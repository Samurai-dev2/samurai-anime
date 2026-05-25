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

/**
 * Fetch the AES key server-side and return as a base64 data URI.
 * HLS.js supports data: URIs for EXT-X-KEY, so this avoids any
 * cross-origin key request from the browser entirely.
 */
async function fetchKeyAsDataUri(
  keyUrl: string,
  referer: string
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(keyUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://kwik.cx",
        Referer: referer,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      },
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.error("[proxy] Key fetch failed:", res.status, keyUrl.slice(0, 80));
      return null;
    }

    const buffer = await res.arrayBuffer();

    // Sanity-check: AES-128 keys are always exactly 16 bytes
    if (buffer.byteLength === 0) {
      console.error("[proxy] Key fetch returned empty body:", keyUrl.slice(0, 80));
      return null;
    }

    if (buffer.byteLength !== 16) {
      console.warn(
        `[proxy] Key is ${buffer.byteLength} bytes (expected 16):`,
        keyUrl.slice(0, 80)
      );
    }

    const base64 = Buffer.from(buffer).toString("base64");
    return `data:application/octet-stream;base64,${base64}`;
  } catch (err: any) {
    console.error("[proxy] Key fetch error:", err.message, keyUrl.slice(0, 80));
    return null;
  }
}

/**
 * Resolve a raw URL from the M3U8 to an absolute URL, then wrap it
 * in our proxy endpoint so the browser never makes a cross-origin request.
 */
function toProxyUrl(
  rawUrl: string,
  base: URL,
  encodedRef: string,
  origin: string
): string {
  // Already a data URI — return as-is (shouldn't happen for segments, but safe)
  if (rawUrl.startsWith("data:")) return rawUrl;

  let absolute: string;
  try {
    absolute = new URL(rawUrl, base).toString();
  } catch {
    console.warn("[proxy] Could not resolve URL:", rawUrl);
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

  const lines = content.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // ── Preserve empty lines exactly ──────────────────────
    if (!trimmed) {
      result.push(line);
      continue;
    }

    // ── #EXT-X-KEY — fetch key server-side, inline as data URI ──
    if (trimmed.startsWith("#EXT-X-KEY")) {
      const uriMatch = trimmed.match(/URI="([^"]+)"/);

      if (uriMatch) {
        const rawKeyUrl = uriMatch[1];

        // Skip if already a data URI (idempotent rewriting)
        if (rawKeyUrl.startsWith("data:")) {
          result.push(line);
          continue;
        }

        let absoluteKeyUrl: string;
        try {
          absoluteKeyUrl = new URL(rawKeyUrl, base).toString();
        } catch {
          absoluteKeyUrl = rawKeyUrl;
        }

        console.log("[proxy] Fetching AES key:", absoluteKeyUrl.slice(0, 80));

        const dataUri = await fetchKeyAsDataUri(absoluteKeyUrl, referer);

        if (dataUri) {
          // Replace only the URI attribute, preserve the rest of the tag
          const rewritten = line.replace(/URI="[^"]*"/, `URI="${dataUri}"`);
          result.push(rewritten);
          console.log("[proxy] ✓ Key inlined as data URI");
        } else {
          // Fallback: proxy the key URL (browser will make a cross-origin
          // request, but with CORS headers it should work)
          const proxyKeyUrl = toProxyUrl(rawKeyUrl, base, encodedRef, origin);
          const rewritten = line.replace(/URI="[^"]*"/, `URI="${proxyKeyUrl}"`);
          result.push(rewritten);
          console.warn("[proxy] ⚠ Key inline failed — using proxy URL fallback");
        }
        continue;
      }

      // No URI attribute — pass through (e.g. METHOD=NONE)
      result.push(line);
      continue;
    }

    // ── #EXT-X-MAP — proxy the init segment ──────────────
    if (trimmed.startsWith("#EXT-X-MAP")) {
      const rewritten = line.replace(
        /URI="([^"]*)"/,
        (_, mapUrl) => `URI="${toProxyUrl(mapUrl, base, encodedRef, origin)}"`
      );
      result.push(rewritten);
      continue;
    }

    // ── Master playlist — rewrite child playlist URIs ─────
    // EXT-X-STREAM-INF and EXT-X-MEDIA URI attributes
    if (
      trimmed.startsWith("#EXT-X-STREAM-INF") ||
      trimmed.startsWith("#EXT-X-MEDIA")
    ) {
      // Rewrite any URI="..." attribute inside these tags
      const rewritten = line.replace(
        /URI="([^"]*)"/,
        (_, u) => `URI="${toProxyUrl(u, base, encodedRef, origin)}"`
      );
      result.push(rewritten);
      continue;
    }

    // ── Other # directives — pass through unchanged ───────
    if (trimmed.startsWith("#")) {
      result.push(line);
      continue;
    }

    // ── Segment / playlist URI line ───────────────────────
    // Guard: skip if somehow empty after trim (shouldn't happen here)
    if (!trimmed) {
      result.push(line);
      continue;
    }

    result.push(toProxyUrl(trimmed, base, encodedRef, origin));
  }

  return result.join("\n");
}

// ─── Main handler ─────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — allow all origins so the browser player can reach us
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Content-Type"
  );

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  // ── Validate params ───────────────────────────────────────
  const { url, referer } = req.query;

  if (!url || typeof url !== "string")
    return res.status(400).json({ error: "url param required" });

  if (!isAllowedUrl(url)) {
    console.warn("[proxy] Blocked host:", url.slice(0, 80));
    return res.status(403).json({ error: "Host not allowed" });
  }

  // ── Derive the public origin of THIS server ───────────────
  // Used to build absolute proxy URLs inside rewritten M3U8 files.
  // Prefer the incoming Origin header; fall back to Host.
  const origin =
    (req.headers["origin"] as string | undefined) ||
    `https://${req.headers.host}`;

  const ref =
    typeof referer === "string" && referer ? referer : "https://kwik.cx/";

  // ── Build upstream request headers ───────────────────────
  const upstreamHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://kwik.cx",
    Referer: ref,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    Connection: "keep-alive",
  };

  // Forward Range header for byte-range / partial content requests
  if (req.headers.range) {
    upstreamHeaders["Range"] = req.headers.range as string;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: upstreamHeaders,
    });

    clearTimeout(timer);

    if (!upstream.ok && upstream.status !== 206) {
      console.error("[proxy] Upstream error:", upstream.status, url.slice(0, 80));
      return res
        .status(upstream.status)
        .json({ error: `Upstream returned ${upstream.status}` });
    }

    const contentType =
      upstream.headers.get("content-type") || "application/octet-stream";

    const isM3u8 =
      url.includes(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL");

    // ── M3U8 playlist ─────────────────────────────────────
    if (isM3u8) {
      const text = await upstream.text();

      if (!text.trim().startsWith("#EXTM3U")) {
        console.error("[proxy] Response is not a valid M3U8:", text.slice(0, 120));
        return res.status(502).json({ error: "Upstream did not return a valid M3U8" });
      }

      const rewritten = await rewriteM3u8(text, url, ref, origin);

      console.log("[proxy] ✓ M3U8 served:", url.slice(0, 80));

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store");
      return res.status(200).send(rewritten);
    }

    // ── Binary segment / init segment / key ──────────────
    const buffer = await upstream.arrayBuffer();
    const status = upstream.status === 206 ? 206 : 200;

    const responseHeaders: Record<string, string | number> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    };

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) responseHeaders["Content-Length"] = contentLength;

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) responseHeaders["Content-Range"] = contentRange;

    res.writeHead(status, responseHeaders);
    res.end(Buffer.from(buffer));
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.error("[proxy] Upstream timed out:", url.slice(0, 80));
      return res.status(504).json({ error: "Upstream request timed out" });
    }
    console.error("[proxy] Unexpected error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
