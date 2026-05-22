// api/proxy.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_HOSTS = [
  "uwucdn.top",
  "kwik.cx",
  "animepahe.com",
  "animepahe.ru",
  "animepahe.org",
];

function isAllowedUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return ALLOWED_HOSTS.some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    );
  } catch {
    return false;
  }
}

// Rewrite m3u8 — segment URLs must be ABSOLUTE so HLS.js
// resolves them correctly even when loaded from a Blob URL
function rewriteM3u8(
  content:  string,
  baseUrl:  string,
  referer:  string,
  origin:   string,   // e.g. "https://samurai-anime-nine.vercel.app"
): string {
  const base       = new URL(baseUrl);
  const encodedRef = encodeURIComponent(referer);

  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) return line;

      // Resolve relative → absolute CDN URL
      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(trimmed, base).toString();
      } catch {
        return line;
      }

      if (!absoluteUrl.startsWith("http")) return line;

      // ↓ Use FULL absolute URL including origin
      // so HLS.js resolves correctly from a Blob URL context
      return `${origin}/api/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodedRef}`;
    })
    .join("\n");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { url, referer } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url param required" });
  }

  if (!isAllowedUrl(url)) {
    console.warn("[proxy] Blocked:", url);
    return res.status(403).json({ error: "Host not allowed" });
  }

  // Detect our own origin from the request
  // e.g. "https://samurai-anime-nine.vercel.app"
  const origin =
    req.headers.origin ||
    `https://${req.headers.host}` ||
    "https://samurai-anime-nine.vercel.app";

  const ref = typeof referer === "string" ? referer : "https://kwik.cx/";

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept":     "*/*",
        "Origin":     "https://kwik.cx",
        "Referer":    ref,
        ...(req.headers.range ? { "Range": req.headers.range as string } : {}),
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Upstream ${upstream.status}`,
      });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const isM3u8      =
      url.includes(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL");

    if (isM3u8) {
      const text      = await upstream.text();
      // Pass origin so rewritten URLs are absolute
      const rewritten = rewriteM3u8(text, url, ref, origin as string);

      res.setHeader("Content-Type",  "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache");
      return res.status(200).send(rewritten);
    }

    // Binary segments (.ts files, .jpg chunks, etc.)
    const buffer = await upstream.arrayBuffer();

    const forwardHeaders: Record<string, string> = {
      "Content-Type":  contentType,
      "Cache-Control": "public, max-age=3600",
    };

    const contentLength = upstream.headers.get("content-length");
    const contentRange  = upstream.headers.get("content-range");
    if (contentLength) forwardHeaders["Content-Length"] = contentLength;
    if (contentRange)  forwardHeaders["Content-Range"]  = contentRange;

    res.writeHead(upstream.status === 206 ? 206 : 200, forwardHeaders);
    res.end(Buffer.from(buffer));

  } catch (err: any) {
    console.error("[proxy] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
