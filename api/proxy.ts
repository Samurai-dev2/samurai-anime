// api/proxy.ts — Vercel Serverless Function
// Simple CORS proxy for HLS streams (self-proxy fallback)

import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { url, referer } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url query parameter is required" });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        Referer: typeof referer === "string" ? referer : "https://kwik.cx/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Origin: typeof referer === "string" ? referer : "https://kwik.cx/",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Upstream returned ${upstream.status}`,
      });
    }

    // Forward content-type
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);

    // Forward content-length if present
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    // Cache for a bit
    res.setHeader("Cache-Control", "public, max-age=60");

    // Stream the body
    const buffer = await upstream.arrayBuffer();
    return res.send(Buffer.from(buffer));
  } catch (err: any) {
    console.error("Proxy error:", err.message);
    return res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
}
