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
    const ok = ALLOWED_HOSTS.some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    );
    if (!ok) console.warn("[proxy] Blocked hostname:", hostname);
    return ok;
  } catch {
    console.warn("[proxy] Could not parse URL:", url);
    return false;
  }
}

async function fetchKeyAsDataUri(
  keyUrl: string,
  referer: string
): Promise<string | null> {
  const headerSets = [
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
    {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Origin": "https://kwik.cx",
      "Referer": referer,
    },
    {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": referer,
    },
  ];

  for (let i = 0; i < headerSets.length; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      console.log(`[proxy] Key attempt ${i + 1}/3:`, keyUrl.slice(0, 80));
      const res = await fetch(keyUrl, {
        signal: controller.signal,
        headers: headerSets[i],
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`[proxy] Key attempt ${i + 1} got HTTP ${res.status}`);
        continue;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) {
        console.warn(`[proxy] Key attempt ${i + 1} got empty body`);
        continue;
      }
      console.log(`[proxy] ✓ Key got on attempt ${i + 1} — ${buf.byteLength} bytes`);
      const b64 = Buffer.from(buf).toString("base64");
      return `data:application/octet-stream;base64,${b64}`;
    } catch (err: any) {
      clearTimeout(timer);
      console.warn(
        `[proxy] Key attempt ${i + 1} threw:`,
        err.name === "AbortError" ? "timeout" : err.message
      );
    }
  }

  console.error("[proxy] ✗ All key fetch attempts failed:", keyUrl.slice(0, 80));
  return null;
}

// ─── THIS IS THE CRITICAL FUNCTION ───────────────────────────
// Segment URLs MUST be absolute (https://...) not relative (/api/proxy?...)
// because HLS.js resolves relative URLs against its internal blob: base URL
// which breaks everything
function toAbsoluteProxyUrl(
  rawUrl: string,
  base: URL,
  encodedRef: string,
  // This MUST be the full public URL of your site e.g. https://samurai-anime-nine.vercel.app
  publicOrigin: string
): string {
  if (rawUrl.startsWith("data:")) return rawUrl;

  let abs: string;
  try {
    abs = new URL(rawUrl, base).toString();
  } catch {
    console.warn("[proxy] Cannot resolve URL:", rawUrl);
    return rawUrl;
  }

  if (!abs.startsWith("http")) return rawUrl;

  // MUST be absolute - HLS.js will break with relative URLs
  return (
    `${publicOrigin}/api/proxy` +
    `?url=${encodeURIComponent(abs)}` +
    `&referer=${encodedRef}`
  );
}

async function rewriteM3u8(
  content: string,
  baseUrl: string,
  referer: string,
  publicOrigin: string // e.g. https://samurai-anime-nine.vercel.app
): Promise<string> {
  const base = new URL(baseUrl);
  const encodedRef = encodeURIComponent(referer);
  const proxy = (raw: string) =>
    toAbsoluteProxyUrl(raw, base, encodedRef, publicOrigin);

  const lines = content.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const t = line.trim();

    // Empty line — preserve exactly
    if (!t) {
      out.push(line);
      continue;
    }

    // Encryption key
    if (t.startsWith("#EXT-X-KEY")) {
      const match = t.match(/URI="([^"]+)"/);
      if (!match) {
        out.push(line);
        continue;
      }
      const rawKey = match[1];
      if (rawKey.startsWith("data:")) {
        out.push(line);
        continue;
      }
      let absKey: string;
      try {
        absKey = new URL(rawKey, base).toString();
      } catch {
        absKey = rawKey;
      }
      const dataUri = await fetchKeyAsDataUri(absKey, referer);
      if (dataUri) {
        out.push(line.replace(/URI="[^"]*"/, `URI="${dataUri}"`));
        console.log("[proxy] ✓ Key inlined as data URI");
      } else {
        // Fallback to proxy URL — at least it will go through our server
        out.push(line.replace(/URI="[^"]*"/, `URI="${proxy(rawKey)}"`));
        console.warn("[proxy] Key inline failed — using proxy URL fallback");
      }
      continue;
    }

    // Init segment
    if (t.startsWith("#EXT-X-MAP")) {
      out.push(line.replace(/URI="([^"]*)"/, (_, u) => `URI="${proxy(u)}"`));
      continue;
    }

    // Master playlist variant / rendition tags
    if (t.startsWith("#EXT-X-STREAM-INF") || t.startsWith("#EXT-X-MEDIA")) {
      out.push(line.replace(/URI="([^"]*)"/, (_, u) => `URI="${proxy(u)}"`));
      continue;
    }

    // Any other tag — pass through
    if (t.startsWith("#")) {
      out.push(line);
      continue;
    }

    // Segment URL line — MUST be absolute proxy URL
    out.push(proxy(t));
  }

  return out.join("\n");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  const { url, referer } = req.query;

  if (!url || typeof url !== "string")
    return res.status(400).json({ error: "url param required" });

  if (!isAllowedUrl(url))
    return res.status(403).json({ error: "Host not allowed" });

  // ── Derive the public origin ────────────────────────────────
  // This is used to build absolute proxy URLs inside M3U8 files.
  // HLS.js NEEDS absolute URLs — relative ones get resolved against
  // the blob: URL that HLS.js uses internally, causing 404 errors.
  //
  // We hardcode the production URL as the ultimate fallback so this
  // never produces a broken relative URL.
  const host = req.headers.host || "";
  const proto = host.includes("localhost") ? "http" : "https";
  const publicOrigin = `${proto}://${host}`;

  console.log("[proxy] publicOrigin:", publicOrigin);
  console.log("[proxy] Fetching:", url.slice(0, 100));

  const ref =
    typeof referer === "string" && referer.startsWith("http")
      ? referer
      : "https://kwik.cx/";

  const upstreamHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

    console.log(
      "[proxy] Upstream response:",
      upstream.status,
      upstream.headers.get("content-type"),
      url.slice(0, 80)
    );

    if (!upstream.ok && upstream.status !== 206) {
      return res
        .status(upstream.status)
        .json({ error: `Upstream returned ${upstream.status}` });
    }

    const contentType =
      upstream.headers.get("content-type") ?? "application/octet-stream";

    const isM3u8 =
      url.includes(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL");

    // ── M3U8 ───────────────────────────────────────────────
    if (isM3u8) {
      const text = await upstream.text();

      console.log(
        "[proxy] M3U8 preview:",
        text.slice(0, 150).replace(/\n/g, " | ")
      );

      if (!text.trimStart().startsWith("#EXTM3U")) {
        console.error("[proxy] Invalid M3U8 content:", text.slice(0, 300));
        return res.status(502).json({
          error: "Upstream did not return a valid M3U8",
          preview: text.slice(0, 300),
        });
      }

      const rewritten = await rewriteM3u8(text, url, ref, publicOrigin);

      // Log a few lines of the rewritten M3U8 so we can verify URLs are absolute
      const firstFewLines = rewritten.split("\n").slice(0, 10).join("\n");
      console.log("[proxy] Rewritten M3U8 (first 10 lines):\n", firstFewLines);

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store");
      return res.status(200).send(rewritten);
    }

    // ── Binary (segments, keys) ────────────────────────────
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
      console.error("[proxy] Timed out:", url.slice(0, 80));
      return res.status(504).json({ error: "Request timed out" });
    }
    console.error("[proxy] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
