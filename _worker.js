// Worker: 支持多种路径形式（包括直接传入完整 raw URL）
// 功能：SHA-in-path 绕过 + ?meta=1（文本优先，二进制 base64）+ 自动移除 /blob

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      let path = url.pathname.replace(/^\/+/, ""); // 去掉开头斜杠
      if (!path) return new Response("Worker Running", { status: 200 });

      const wantMeta = url.searchParams.get("meta") === "1";

      // 如果 path 看起来像一个完整 URL（以 http:// 或 https:// 开头），解码它
      // 例如: https://cndm.pp.ua/https://raw.githubusercontent.com/owner/repo/branch/file
      // 或: https://cndm.pp.ua/http://example.com/...
      let isFullUrl = false;
      let parsedFromFull = null;
      if (/^https?:\/\//i.test(path)) {
        // path 是完整 URL 字符串
        isFullUrl = true;
        try {
          // decode in case someone encoded slashes etc
          const decoded = decodeURIComponent(path);
          const parsed = new URL(decoded);
          parsedFromFull = parsed; // URL object
        } catch (e) {
          // 如果 decode 或 new URL 失败，继续按普通 path 处理
          parsedFromFull = null;
          console.error("解析完整 URL 失败:", e);
        }
      } else {
        // 也可能是用户把完整 url 作为转义过的字符串（例如 https:/ /raw... without second slash）
        // 不强制处理这些怪异情况，继续常规解析
      }

      // 解析出 owner, repo, branch, filePath
      let owner, repo, branch, filePath;

      if (parsedFromFull && parsedFromFull.hostname && parsedFromFull.hostname.includes("raw.githubusercontent.com")) {
        // 从完整 raw URL 解析 path parts
        // raw URL path 格式: /owner/repo/branch/path/to/file OR /owner/repo/sha/path
        const p = parsedFromFull.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
        // Remove potential 'blob' if present at position 2? (unlikely in raw URL but safe)
        // raw.githubusercontent URLs normally don't have /blob, but handle generically
        const pClean = p.slice();
        if (pClean[2] && pClean[2].toLowerCase() === "blob") {
          pClean.splice(2, 1);
        }
        if (pClean.length >= 3) {
          owner = pClean[0]; repo = pClean[1]; branch = pClean[2];
          filePath = pClean.slice(3).join("/");
        } else {
          // 格式异常，回退到把整个 raw URL 当作 fetchUrl（不进行 SHA 优化）
          owner = null;
        }
      }

      // 如果不是完整 raw URL，按常规 /owner/repo/branch/... 解析，并移除可能的 /blob 段
      if (!owner) {
        // parse raw path segments and remove 'blob' if present right after repo
        const partsRaw = path.split("/").filter(p => p !== "");
        // handle case: /owner/repo/blob/branch/...
        if (partsRaw.length >= 3 && partsRaw[2].toLowerCase() === "blob") {
          // remove the 'blob' segment
          partsRaw.splice(2, 1);
        }
        if (partsRaw.length < 3) {
          // invalid format
          return new Response("路径格式: /owner/repo/branch/path/to/file 或 /https://raw.githubusercontent.com/owner/repo/branch/path", { status: 400 });
        }
        owner = partsRaw[0];
        repo = partsRaw[1];
        branch = partsRaw[2] || "main";
        filePath = partsRaw.slice(3).join("/");
      }

      // 如果 filePath 为空（例如只访问 /owner/repo/branch/），拒绝
      if (!filePath) {
        return new Response("请指定仓库内的文件路径，例如 /owner/repo/branch/path/to/file", { status: 400 });
      }

      // prepare headers for GitHub API and raw fetch
      const apiHeaders = new Headers();
      if (env.GH_TOKEN) apiHeaders.append("Authorization", `token ${env.GH_TOKEN}`);
      apiHeaders.append("User-Agent", "Cloudflare-Worker"); // GitHub API 要求

      // get latest sha (cached inside)
      const sha = await getLatestSha(owner, repo, branch, apiHeaders);
      if (!sha) {
        console.error("无法获取 SHA，回退到 branch URL");
      }

      // read last saved sha for this file
      const cache = caches.default;
      const shaCacheKey = new Request(`sha://${owner}/${repo}/${filePath}`);
      let lastSha = null;
      try {
        const cached = await cache.match(shaCacheKey);
        if (cached) lastSha = (await cached.json()).sha;
      } catch (e) { console.error("读取 sha cache 错误", e); }

      // choose fetchUrl
      let fetchUrl;
      if (sha && (!lastSha || lastSha !== sha)) {
        // use sha in path (this produces a distinct URL reliably bypassing CDN cache)
        fetchUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${filePath}`;
        console.log("SHA changed, using SHA-in-path:", fetchUrl);
      } else {
        // use branch path
        fetchUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
      }

      // update sha cache (short TTL)
      try {
        await cache.put(shaCacheKey, new Response(JSON.stringify({ sha }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10, s-maxage=10" }
        }));
      } catch (e) { console.error("写入 sha cache 失败", e); }

      // Prepare headers for raw fetch (Authorization if private)
      const rawHeaders = new Headers();
      if (env.GH_TOKEN) rawHeaders.append("Authorization", `token ${env.GH_TOKEN}`);
      rawHeaders.append("User-Agent", "Cloudflare-Worker");

      // If the original request was a full raw URL not matching our parsed owner/repo/branch/filePath
      // (e.g. user provided some other host), we still allow fetching that original URL:
      // If parsedFromFull exists but we failed to extract owner/repo properly, fallback to that full URL.
      if (parsedFromFull && (!owner || !repo || !branch || !filePath)) {
        // Use the original full URL as-is
        fetchUrl = parsedFromFull.toString();
      }

      // fetch the resource
      const originResp = await fetch(fetchUrl, { headers: rawHeaders, cf: { cacheTtl: 0, cacheEverything: false } });
      if (!originResp.ok) {
        const txt = await originResp.text().catch(() => "");
        return new Response(txt || "无法获取文件", { status: originResp.status });
      }

      // read body
      const buf = await originResp.arrayBuffer();
      const contentType = originResp.headers.get("content-type") || "application/octet-stream";

      // non-meta: return raw content, preserving content-type, and add debug headers
      if (!wantMeta) {
        const outHeaders = new Headers(originResp.headers);
        outHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        outHeaders.set("Pragma", "no-cache");
        outHeaders.set("Expires", "0");
        outHeaders.set("X-Fetched-By", "sha-in-path");
        outHeaders.set("X-Used-URL", fetchUrl);
        outHeaders.set("X-Origin-CF-Cache", originResp.headers.get("cf-cache-status") || "none");
        outHeaders.set("X-Origin-Age", originResp.headers.get("age") || "0");
        return new Response(buf, { status: originResp.status, headers: outHeaders });
      }

      // meta mode: text-first, else base64
      let content;
      let content_is_base64 = false;
      if (isTextContentType(contentType)) {
        try {
          const decoder = new TextDecoder("utf-8");
          content = decoder.decode(buf);
          content_is_base64 = false;
        } catch (e) {
          console.error("文本解码失败，转 base64 返回", e);
          content = arrayBufferToBase64(buf);
          content_is_base64 = true;
        }
      } else {
        content = arrayBufferToBase64(buf);
        content_is_base64 = true;
      }

      const meta = {
        sha: sha || null,
        fetched_at: new Date().toISOString(),
        content,
        content_is_base64,
        content_type: contentType,
        status: originResp.status
      };

      return new Response(JSON.stringify(meta), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }
      });

    } catch (e) {
      console.error("Worker 错误:", e);
      return new Response("Worker 内部错误: " + (e && e.message || e), { status: 500 });
    }
  }
};

// ---------------- helper: getLatestSha (带短期缓存) ----------------
async function getLatestSha(owner, repo, branch, headers) {
  const cache = caches.default;
  const cacheKey = new Request(`branch-sha://${owner}/${repo}/${branch}`);
  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      try { const j = await cached.json(); if (j && j.sha) return j.sha; } catch (e) {}
    }

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`;
    const resp = await fetch(apiUrl, { headers });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.error("getLatestSha API 错误:", resp.status, t);
      return null;
    }
    const body = await resp.json();
    const sha = body && body.sha ? body.sha : null;
    if (!sha) return null;

    try {
      await cache.put(cacheKey, new Response(JSON.stringify({ sha }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=5, s-maxage=5" }
      }));
    } catch (e) { console.error("put branch sha cache fail", e); }

    return sha;
  } catch (e) {
    console.error("getLatestSha 错误:", e);
    return null;
  }
}

// ---------------- helper: 判断是否为文本类型 ----------------
function isTextContentType(ct) {
  if (!ct) return false;
  ct = ct.toLowerCase();
  if (ct.startsWith("text/")) return true;
  if (ct.includes("json") || ct.includes("javascript") || ct.includes("xml") || ct.includes("html") || ct.includes("svg") || ct.includes("yaml") || ct.includes("css")) return true;
  return false;
}

// ---------------- helper: ArrayBuffer -> base64 ----------------
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 32KB per chunk
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  try {
    return btoa(binary);
  } catch (e) {
    console.error("base64 编码失败", e);
    return "";
  }
}
