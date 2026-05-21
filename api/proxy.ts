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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — allow your site to call this
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { url, referer } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url param required" });
  }

  // Security — only proxy allowed CDN hosts
  if (!isAllowedUrl(url)) {
    console.warn("[proxy] Blocked:", url);
    return res.status(403).json({ error: "Host not allowed" });
  }

  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":     "*/*",
      "Origin":     "https://kwik.cx",
      "Referer":    typeof referer === "string" ? referer : "https://kwik.cx/",
    };

    // Forward Range header for video seeking
    if (req.headers.range) {
      headers["Range"] = req.headers.range as string;
    }

    const upstream = await fetch(url, { headers });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Upstream error: ${upstream.status}`,
      });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";

    // For m3u8 playlists — rewrite all URLs inside to go through proxy too
    if (
      url.endsWith(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL")
    ) {
      const text    = await upstream.text();
      const rewritten = rewriteM3u8(text, url, typeof referer === "string" ? referer : "");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache");
      return res.status(200).send(rewritten);
    }

    // For .ts segments and other binary — stream through
    const buffer = await upstream.arrayBuffer();

    // Forward relevant headers
    const forwardHeaders: Record<string, string> = {
      "Content-Type":  contentType,
      "Cache-Control": "public, max-age=3600",
    };

    const contentLength = upstream.headers.get("content-length");
    const contentRange  = upstream.headers.get("content-range");
    if (contentLength) forwardHeaders["Content-Length"]  = contentLength;
    if (contentRange)  forwardHeaders["Content-Range"]   = contentRange;

    res.writeHead(upstream.status === 206 ? 206 : 200, forwardHeaders);
    res.end(Buffer.from(buffer));

  } catch (err: any) {
    console.error("[proxy] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── Rewrite m3u8 so all segment/playlist URLs go through our proxy ──
function rewriteM3u8(content: string, baseUrl: string, referer: string): string {
  const base        = new URL(baseUrl);
  const encodedRef  = encodeURIComponent(referer);

  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) return line;

      // Resolve relative URLs to absolute
      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(trimmed, base).toString();
      } catch {
        return line;
      }

      // Only rewrite lines that are actual URLs (segments or sub-playlists)
      if (!absoluteUrl.startsWith("http")) return line;

      // Wrap through our proxy
      return `/api/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodedRef}`;
    })
    .join("\n");
}
