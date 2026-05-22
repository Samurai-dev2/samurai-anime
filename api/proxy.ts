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

function rewriteM3u8(
  content: string,
  baseUrl: string,
  referer: string,
  origin:  string,
): string {
  const base       = new URL(baseUrl);
  const encodedRef = encodeURIComponent(referer);

  function toProxyUrl(rawUrl: string): string {
    // Resolve relative → absolute
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

      // ── Rewrite #EXT-X-KEY URI ──────────────────────────
      // e.g. #EXT-X-KEY:METHOD=AES-128,URI="https://vault.../mon.key",IV=0x...
      if (trimmed.startsWith("#EXT-X-KEY")) {
        return line.replace(
          /URI="([^"]+)"/,
          (_, keyUrl) => `URI="${toProxyUrl(keyUrl)}"`,
        );
      }

      // ── Rewrite #EXT-X-MAP URI ───────────────────────────
      // e.g. #EXT-X-MAP:URI="init.mp4"
      if (trimmed.startsWith("#EXT-X-MAP")) {
        return line.replace(
          /URI="([^"]+)"/,
          (_, mapUrl) => `URI="${toProxyUrl(mapUrl)}"`,
        );
      }

      // ── Skip all other # lines ───────────────────────────
      if (trimmed.startsWith("#")) return line;

      // ── Rewrite segment / sub-playlist URLs ──────────────
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

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url param required" });
  }

  if (!isAllowedUrl(url)) {
    console.warn("[proxy] Blocked:", url);
    return res.status(403).json({ error: "Host not allowed" });
  }

  const origin =
    (req.headers.origin as string) ||
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
      console.error("[proxy] Upstream error:", upstream.status, url);
      return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";

    const isM3u8 =
      url.includes(".m3u8")              ||
      contentType.includes("mpegurl")    ||
      contentType.includes("x-mpegURL");

    // ── M3U8 playlist — rewrite all URLs ─────────────────
    if (isM3u8) {
      const text      = await upstream.text();
      const rewritten = rewriteM3u8(text, url, ref, origin);

      console.log("[proxy] Serving rewritten m3u8 for:", url.slice(0, 60));

      res.setHeader("Content-Type",  "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache");
      return res.status(200).send(rewritten);
    }

    // ── .key files — serve as binary ─────────────────────
    // AES-128 key files are small binary blobs
    const isKey = url.includes(".key") || url.endsWith("mon.key");

    if (isKey) {
      const buffer = await upstream.arrayBuffer();
      console.log("[proxy] Serving key file:", url.slice(0, 60));
      res.setHeader("Content-Type",  "application/octet-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.writeHead(200, {
        "Content-Type":  "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      return res.end(Buffer.from(buffer));
    }

    // ── Binary segments (.ts, .jpg chunks, etc.) ─────────
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
