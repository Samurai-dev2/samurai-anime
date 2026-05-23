// api/proxy.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_HOSTS = [
  "uwucdn.top",
  "owocdn.top",       // ← add this, seen in your console
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

function rewriteM3u8(
  content: string,
  baseUrl: string,
  referer: string,
  origin:  string,
): string {
  const base       = new URL(baseUrl);
  const encodedRef = encodeURIComponent(referer);

  function toProxyUrl(rawUrl: string): string {
    let absolute: string;
    try {
      absolute = new URL(rawUrl, base).toString();
    } catch {
      return rawUrl;
    }
    if (!absolute.startsWith("http")) return rawUrl;
    return `${origin}/api/proxy?url=${encodeURIComponent(absolute)}&referer=${encodedRef}`;
  }

  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite encryption key URI
      if (trimmed.startsWith("#EXT-X-KEY")) {
        return line.replace(
          /URI="([^"]+)"/,
          (_, keyUrl) => `URI="${toProxyUrl(keyUrl)}"`,
        );
      }

      // Rewrite map URI (init segments)
      if (trimmed.startsWith("#EXT-X-MAP")) {
        return line.replace(
          /URI="([^"]+)"/,
          (_, mapUrl) => `URI="${toProxyUrl(mapUrl)}"`,
        );
      }

      // Skip other # tags
      if (trimmed.startsWith("#")) return line;

      // Rewrite segment URLs
      return toProxyUrl(trimmed);
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

  if (!url || typeof url !== "string")
    return res.status(400).json({ error: "url param required" });

  if (!isAllowedUrl(url)) {
    console.warn("[proxy] Blocked:", url);
    return res.status(403).json({ error: "Host not allowed" });
  }

  const origin =
    (req.headers.origin as string) ||
    `https://${req.headers.host}` ||
    "https://samurai-anime-nine.vercel.app";

  const ref = typeof referer === "string" ? referer : "https://kwik.cx/";

  // Extract kwik episode ID from referer for proper headers
  const kwikEpId = ref.includes("kwik.cx/e/")
    ? ref.split("kwik.cx/e/")[1]?.split(/[?#]/)[0] ?? ""
    : "";

  try {
    const upstream = await fetch(url, {
      headers: {
        // Full browser-like headers to avoid 403
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":          "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Origin":          "https://kwik.cx",
        "Referer":         ref,
        "Sec-Fetch-Dest":  "empty",
        "Sec-Fetch-Mode":  "cors",
        "Sec-Fetch-Site":  "cross-site",
        "Connection":      "keep-alive",
        ...(req.headers.range ? { "Range": req.headers.range as string } : {}),
      },
    });

    if (!upstream.ok) {
      console.error("[proxy] Upstream", upstream.status, "for:", url.slice(0, 80));
      return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";

    const isM3u8 =
      url.includes(".m3u8")           ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL");

    // M3U8 — rewrite and return
    if (isM3u8) {
      const text      = await upstream.text();
      const rewritten = rewriteM3u8(text, url, ref, origin);
      console.log("[proxy] ✓ m3u8 rewritten:", url.slice(0, 60));
      res.setHeader("Content-Type",  "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache");
      return res.status(200).send(rewritten);
    }

    // Binary (segments, key files, etc.)
    const buffer = await upstream.arrayBuffer();
    const isKey  = url.includes(".key") || url.endsWith("mon.key");

    res.writeHead(upstream.status === 206 ? 206 : 200, {
      "Content-Type":  isKey ? "application/octet-stream" : contentType,
      "Cache-Control": isKey ? "no-cache" : "public, max-age=3600",
      ...(upstream.headers.get("content-length")
        ? { "Content-Length": upstream.headers.get("content-length")! }
        : {}),
      ...(upstream.headers.get("content-range")
        ? { "Content-Range": upstream.headers.get("content-range")! }
        : {}),
    });

    res.end(Buffer.from(buffer));

  } catch (err: any) {
    console.error("[proxy] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
