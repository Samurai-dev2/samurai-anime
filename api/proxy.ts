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
      const res = await fetch(keyUrl, {
        signal: controller.signal,
        headers: headerSets[i],
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) continue;
      console.log(`[proxy] ✓ Key fetched (${buf.byteLength} bytes)`);
      return `data:application/octet-stream;base64,${Buffer.from(buf).toString("base64")}`;
    } catch (err: any) {
      clearTimeout(timer);
    }
  }
  return null;
}

function toProxyUrl(raw: string, base: URL, encodedRef: string, origin: string): string {
  if (raw.startsWith("data:")) return raw;
  let abs: string;
  try { abs = new URL(raw, base).toString(); }
  catch { return raw; }
  if (!abs.startsWith("http")) return raw;
  return `${origin}/api/proxy?url=${encodeURIComponent(abs)}&referer=${encodedRef}`;
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
    if (!t) { out.push(line); continue; }

    if (t.startsWith("#EXT-X-KEY")) {
      const match = t.match(/URI="([^"]+)"/);
      if (!match) { out.push(line); continue; }
      const rawKey = match[1];
      if (rawKey.startsWith("data:")) { out.push(line); continue; }
      let absKey: string;
      try { absKey = new URL(rawKey, base).toString(); }
      catch { absKey = rawKey; }
      const dataUri = await fetchKeyAsDataUri(absKey, referer);
      if (dataUri) {
        out.push(line.replace(/URI="[^"]*"/, `URI="${dataUri}"`));
      } else {
        out.push(line.replace(/URI="[^"]*"/, `URI="${proxy(rawKey)}"`));
      }
      continue;
    }

    if (t.startsWith("#EXT-X-MAP")) {
      out.push(line.replace(/URI="([^"]*)"/, (_, u) => `URI="${proxy(u)}"`));
      continue;
    }
    if (t.startsWith("#EXT-X-STREAM-INF") || t.startsWith("#EXT-X-MEDIA")) {
      out.push(line.replace(/URI="([^"]*)"/, (_, u) => `URI="${proxy(u)}"`));
      continue;
    }
    if (t.startsWith("#")) { out.push(line); continue; }
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

  const host = req.headers.host || "samurai-anime-nine.vercel.app";
  const proto = host.includes("localhost") ? "http" : "https";
  const origin = `${proto}://${host}`;

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
  };

  if (req.headers.range) upstreamHeaders["Range"] = req.headers.range as string;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const upstream = await fetch(url, { signal: controller.signal, headers: upstreamHeaders });
    clearTimeout(timer);

    console.log("[proxy]", upstream.status, url.slice(0, 100));

    if (!upstream.ok && upstream.status !== 206) {
      const body = await upstream.text().catch(() => "");
      console.error("[proxy] Upstream error body:", body.slice(0, 200));
      return res.status(upstream.status).json({
        error: `Upstream returned ${upstream.status}`,
        body: body.slice(0, 200),
      });
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const isM3u8 =
      url.includes(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL");

    if (isM3u8) {
      const text = await upstream.text();
      console.log("[proxy] M3U8 raw:", JSON.stringify(text.slice(0, 300)));

      if (!text.trimStart().startsWith("#EXTM3U")) {
        console.error("[proxy] Not valid M3U8:", text.slice(0, 300));
        return res.status(502).json({
          error: "Upstream did not return valid M3U8",
          preview: text.slice(0, 300),
        });
      }

      const rewritten = await rewriteM3u8(text, url, ref, origin);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store");
      return res.status(200).send(rewritten);
    }

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
    if (err.name === "AbortError")
      return res.status(504).json({ error: "Request timed out" });
    return res.status(500).json({ error: err.message });
  }
}
