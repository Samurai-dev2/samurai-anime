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
    const allowed = ALLOWED_HOSTS.some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    );
    if (!allowed) {
      // This log will appear in your Vercel logs
      console.warn("[proxy] BLOCKED hostname:", hostname);
    }
    return allowed;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// This is the most important function.
// It tries 3 different ways to fetch the encryption key.
// If all 3 fail, we know the CDN is blocking server IPs entirely.
// ─────────────────────────────────────────────────────────────
async function fetchKeyAsDataUri(
  keyUrl: string,
  referer: string
): Promise<string | null> {

  // We try 3 different sets of headers.
  // Some CDNs block requests with too many headers,
  // some block requests with too few.
  const attempts = [
    // Attempt 1: Full browser-like headers
    {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Origin": "https://kwik.cx",
      "Referer": referer,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
    },
    // Attempt 2: Fewer headers
    {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": referer,
      "Origin": "https://kwik.cx",
    },
    // Attempt 3: Bare minimum headers
    {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": referer,
    },
  ];

  for (let i = 0; i < attempts.length; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      console.log(`[proxy] Key fetch attempt ${i + 1} of 3: ${keyUrl}`);

      const res = await fetch(keyUrl, {
        signal: controller.signal,
        headers: attempts[i],
      });

      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`[proxy] Attempt ${i + 1} failed with HTTP ${res.status}`);
        continue; // try the next set of headers
      }

      const buffer = await res.arrayBuffer();

      if (buffer.byteLength === 0) {
        console.warn(`[proxy] Attempt ${i + 1} returned empty body`);
        continue;
      }

      // Success! Convert the key bytes to a data URI
      const base64 = Buffer.from(buffer).toString("base64");
      console.log(`[proxy] ✓ Key fetched on attempt ${i + 1} (${buffer.byteLength} bytes)`);
      return `data:application/octet-stream;base64,${base64}`;

    } catch (err: any) {
      clearTimeout(timer);
      const reason = err.name === "AbortError" ? "timed out" : err.message;
      console.warn(`[proxy] Attempt ${i + 1} threw: ${reason}`);
      // loop continues to next attempt
    }
  }

  // All 3 attempts failed
  console.error("[proxy] ✗ All 3 key fetch attempts failed for:", keyUrl);
  return null;
}

function toProxyUrl(
  rawUrl: string,
  base: URL,
  encodedRef: string,
  origin: string
): string {
  if (rawUrl.startsWith("data:")) return rawUrl;

  let absolute: string;
  try {
    absolute = new URL(rawUrl, base).toString();
  } catch {
    return rawUrl;
  }

  if (!absolute.startsWith("http")) return rawUrl;

  return (
    `${origin}/api/proxy` +
    `?url=${encodeURIComponent(absolute)}` +
    `&referer=${encodedRef}`
  );
}

async function rewriteM3u8(
  content: string,
  baseUrl: string,
  referer: string,
  origin: string
): Promise<string> {
  const base = new URL(baseUrl);
  const encodedRef = encodeURIComponent(referer);
  const proxy = (raw: string) => toProxyUrl(raw, base, encodedRef, origin);

  const lines = content.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const t = line.trim();

    // Empty line - keep as is
    if (!t) {
      out.push(line);
      continue;
    }

    // ── Encryption key line ───────────────────────────────
    if (t.startsWith("#EXT-X-KEY")) {
      const uriMatch = t.match(/URI="([^"]+)"/);

      // No URI in this tag (e.g. METHOD=NONE) - keep as is
      if (!uriMatch) {
        out.push(line);
        continue;
      }

      const rawKeyUrl = uriMatch[1];

      // Already a data URI - keep as is
      if (rawKeyUrl.startsWith("data:")) {
        out.push(line);
        continue;
      }

      // Resolve to full URL
      let absoluteKeyUrl: string;
      try {
        absoluteKeyUrl = new URL(rawKeyUrl, base).toString();
      } catch {
        absoluteKeyUrl = rawKeyUrl;
      }

      // Try to fetch and inline the key
      const dataUri = await fetchKeyAsDataUri(absoluteKeyUrl, referer);

      if (dataUri) {
        // SUCCESS - replace the URL with actual key data
        out.push(line.replace(/URI="[^"]*"/, `URI="${dataUri}"`));
        console.log("[proxy] ✓ Key successfully inlined");
      } else {
        // FAILED - use proxy URL as last resort
        // (this is what causes the 403 you are seeing)
        console.warn("[proxy] ✗ Key inline failed! Using proxy URL fallback.");
        console.warn("[proxy] The CDN may be blocking Vercel server IPs.");
        out.push(line.replace(/URI="[^"]*"/, `URI="${proxy(rawKeyUrl)}"`));
      }
      continue;
    }

    // ── Init segment ──────────────────────────────────────
    if (t.startsWith("#EXT-X-MAP")) {
      out.push(line.replace(/URI="([^"]*)"/, (_, u) => `URI="${proxy(u)}"`));
      continue;
    }

    // ── Master playlist child entries ─────────────────────
    if (t.startsWith("#EXT-X-STREAM-INF") || t.startsWith("#EXT-X-MEDIA")) {
      out.push(line.replace(/URI="([^"]*)"/, (_, u) => `URI="${proxy(u)}"`));
      continue;
    }

    // ── Any other # tag - keep as is ─────────────────────
    if (t.startsWith("#")) {
      out.push(line);
      continue;
    }

    // ── Video segment URL - proxy it ──────────────────────
    out.push(proxy(t));
  }

  return out.join("\n");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const { url, referer } = req.query;

  if (!url || typeof url !== "string")
    return res.status(400).json({ error: "url param required" });

  if (!isAllowedUrl(url))
    return res.status(403).json({ error: "Host not allowed" });

  const origin =
    (req.headers["origin"] as string | undefined) ||
    `https://${req.headers.host}`;

  const ref =
    typeof referer === "string" && referer.startsWith("http")
      ? referer
      : "https://kwik.cx/";

  const upstreamHeaders: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://kwik.cx",
    "Referer": ref,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    "Connection": "keep-alive",
  };

  if (req.headers.range) {
    upstreamHeaders["Range"] = req.headers.range as string;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: upstreamHeaders,
    });

    clearTimeout(timer);

    if (!upstream.ok && upstream.status !== 206) {
      console.error("[proxy] Upstream error:", upstream.status, url.slice(0, 100));
      return res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
    }

    const contentType =
      upstream.headers.get("content-type") ?? "application/octet-stream";

    const isM3u8 =
      url.includes(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL");

    // ── M3U8 playlist ─────────────────────────────────────
    if (isM3u8) {
      const text = await upstream.text();

      if (!text.trimStart().startsWith("#EXTM3U")) {
        console.error("[proxy] Not a valid M3U8:", text.slice(0, 120));
        return res.status(502).json({ error: "Upstream did not return a valid M3U8" });
      }

      const rewritten = await rewriteM3u8(text, url, ref, origin);

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store");
      console.log("[proxy] ✓ M3U8 served:", url.slice(0, 100));
      return res.status(200).send(rewritten);
    }

    // ── Binary (video segments, key files, etc.) ──────────
    const buffer = await upstream.arrayBuffer();
    const status = upstream.status === 206 ? 206 : 200;

    const responseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    };

    const cl = upstream.headers.get("content-length");
    if (cl) responseHeaders["Content-Length"] = cl;

    const cr = upstream.headers.get("content-range");
    if (cr) responseHeaders["Content-Range"] = cr;

    res.writeHead(status, responseHeaders);
    res.end(Buffer.from(buffer));

  } catch (err: any) {
    clearTimeout(timer);

    if (err.name === "AbortError") {
      console.error("[proxy] Timed out:", url.slice(0, 100));
      return res.status(504).json({ error: "Request timed out" });
    }

    console.error("[proxy] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
