// Worker A (改良版) — SHA-in-path + ?meta=1 (文本优先、二进制 base64)
// 自动移除仓库名后多余的 /blob 段

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/+/, "");
      if (!path) return new Response("Worker Running", { status: 200 });

      const wantMeta = url.searchParams.get("meta") === "1";

      // parse raw path parts
      const partsRaw = path.split("/").filter(p => p !== "");
      if (partsRaw.length < 3) return new Response("路径格式: /owner/repo/branch/path/to/file", { status: 400 });

      // If the 3rd segment is "blob" (i.e. /owner/repo/blob/branch/...), remove it.
      // After removal, expected parts: [owner, repo, branch, ...filePath]
      const parts = partsRaw.slice(); // clone
      if (parts[2] && parts[2].toLowerCase() === "blob") {
        // remove the "blob" segment
        parts.splice(2, 1);
      }

      // Re-check length after potential removal
      if (parts.length < 3) return new Response("路径格式: /owner/repo/branch/path/to/file", { status: 400 });

      const owner = parts[0];
      const repo = parts[1];
      const branch = parts[2] || "main";
      const filePath = parts.slice(3).join("/");

      // prepare headers for API
      const apiHeaders = new Headers();
      if (env.GH_TOKEN) apiHeaders.append("Authorization", `token ${env.GH_TOKEN}`);
      apiHeaders.append("User-Agent", "Cloudflare-Worker"); // GitHub API 要求

      // get latest sha (cached inside)
      const sha = await getLatestSha(owner, repo, branch, apiHeaders);
      if (!sha) {
        // 如果无法拿到 sha，仍继续尝试用 branch URL 以保证可用性
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

      // choose fetchUrl: if sha available and changed -> use sha-in-path; else use branch path
      let fetchUrl;
      if (sha && (!lastSha || lastSha !== sha)) {
        fetchUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${filePath}`;
        console.log("SHA changed, using SHA-in-path:", fetchUrl);
      } else {
        fetchUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
      }

      // update sha cache (short TTL)
      try {
        await cache.put(shaCacheKey, new Response(JSON.stringify({ sha }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10, s-maxage=10" }
        }));
      } catch (e) { console.error("写入 sha cache 失败", e); }

      // fetch file content (raw). 如果私有仓库，token 会用于授权
      const rawHeaders = new Headers();
      if (env.GH_TOKEN) rawHeaders.append("Authorization", `token ${env.GH_TOKEN}`);
      // raw 请求不用必须附 User-Agent，但加上也无害
      rawHeaders.append("User-Agent", "Cloudflare-Worker");

      const originResp = await fetch(fetchUrl, { headers: rawHeaders, cf: { cacheTtl: 0, cacheEverything: false } });
      if (!originResp.ok) {
        const txt = await originResp.text().catch(() => "");
        return new Response(txt || "无法获取文件", { status: originResp.status });
      }

      // read body
      const buf = await originResp.arrayBuffer();
      const contentType = originResp.headers.get("content-type") || "application/octet-stream";

      // 如果不是 meta 模式，直接返回原始内容（并设置不缓存 header）
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

      // meta 模式：文本优先，二进制 base64
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
        // 二进制 -> base64
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
