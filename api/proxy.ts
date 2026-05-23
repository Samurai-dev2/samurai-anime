// api/proxy.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_HOSTS = [
  "uwucdn.top",
  "owocdn.top",
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

// Fetch the AES key server-side and return as base64 data URI
// so HLS.js never needs to make a cross-origin request for it
async function fetchKeyAsDataUri(
  keyUrl:  string,
  referer: string,
): Promise<string | null> {
  try {
    const res = await fetch(keyUrl, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":          "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin":          "https://kwik.cx",
        "Referer":         referer,
        "Sec-Fetch-Dest":  "empty",
        "Sec-Fetch-Mode":  "cors",
        "Sec-Fetch-Site":  "cross-site",
      },
    });

    if (!res.ok) {
      console.error("[proxy] Key fetch failed:", res.status, keyUrl);
      return null;
    }

    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return `data:application/octet-stream;base64,${base64}`;
  } catch (err: any) {
    console.error("[proxy] Key fetch error:", err.message);
    return null;
  }
}

async function rewriteM3u8(
  content: string,
  baseUrl: string,
  referer: string,
  origin:  string,
): Promise<string> {
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

  // Collect all #EXT-X-KEY lines and pre-fetch their keys
  // so we can inline them as data URIs
  const lines  = content.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      result.push(line);
      continue;
    }

    // ── #EXT-X-KEY — inline the key as data URI ──────────
    if (trimmed.startsWith("#EXT-X-KEY")) {
      const uriMatch = line.match(/URI="([^"]+)"/);

      if (uriMatch) {
        const rawKeyUrl = uriMatch[1];

        // Resolve to absolute URL
        let absoluteKeyUrl: string;
        try {
          absoluteKeyUrl = new URL(rawKeyUrl, base).toString();
        } catch {
          absoluteKeyUrl = rawKeyUrl;
        }

        console.log("[proxy] Fetching key server-side:", absoluteKeyUrl.slice(0, 60));

        // Fetch key on the server — no CORS issue here
        const dataUri = await fetchKeyAsDataUri(absoluteKeyUrl, referer);

        if (dataUri) {
          // Replace URI with inline data URI — HLS.js supports this
          const rewritten = line.replace(
            /URI="([^"]+)"/,
            `URI="${dataUri}"`
          );
          result.push(rewritten);
          console.log("[proxy] ✓ Key inlined as data URI");
        } else {
          // Fall back to proxy URL if key fetch fails
          const rewritten = line.replace(
            /URI="([^"]+)"/,
            (_, keyUrl) => `URI="${toProxyUrl(keyUrl)}"`
          );
          result.push(rewritten);
          console.warn("[proxy] Key fetch failed, using proxy URL as fallback");
        }
      } else {
        result.push(line);
      }
      continue;
    }

    // ── #EXT-X-MAP — proxy the init segment ──────────────
    if (trimmed.startsWith("#EXT-X-MAP")) {
      const rewritten = line.replace(
        /URI="([^"]+)"/,
        (_, mapUrl) => `URI="${toProxyUrl(mapUrl)}"`
      );
      result.push(rewritten);
      continue;
    }

    // ── Other # tags — pass through ──────────────────────
    if (trimmed.startsWith("#")) {
      result.push(line);
      continue;
    }

    // ── Segment URLs — proxy them ─────────────────────────
    result.push(toProxyUrl(trimmed));
  }

  return result.join("\n");
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

  const upstreamHeaders = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept":          "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://kwik.cx",
    "Referer":         ref,
    "Sec-Fetch-Dest":  "empty",
    "Sec-Fetch-Mode":  "cors",
    "Sec-Fetch-Site":  "cross-site",
    "Connection":      "keep-alive",
    ...(req.headers.range ? { "Range": req.headers.range as string } : {}),
  };

  try {
    const upstream = await fetch(url, { headers: upstreamHeaders });

    if (!upstream.ok) {
      console.error("[proxy] Upstream", upstream.status, url.slice(0, 80));
      return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";

    const isM3u8 =
      url.includes(".m3u8")           ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL");

    // ── M3U8 — rewrite with inlined keys ─────────────────
    if (isM3u8) {
      const text      = await upstream.text();
      // rewriteM3u8 is now async because it fetches keys
      const rewritten = await rewriteM3u8(text, url, ref, origin);
      console.log("[proxy] ✓ m3u8 served:", url.slice(0, 60));
      res.setHeader("Content-Type",  "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache");
      return res.status(200).send(rewritten);
    }

    // ── Binary (segments, etc.) ───────────────────────────
    const buffer = await upstream.arrayBuffer();

    res.writeHead(upstream.status === 206 ? 206 : 200, {
      "Content-Type":  contentType,
      "Cache-Control": "public, max-age=3600",
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
