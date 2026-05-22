// api/stream.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── Types ────────────────────────────────────────────────────
interface SubtitleTrack {
  url:   string;
  lang:  string;
  label: string;
}

interface StreamResponse {
  url:       string | null;
  subtitles: SubtitleTrack[];
  intro:     null;
  outro:     null;
  source:    string | null;
  referer?:  string;
  headers?:  Record<string, string>;
  error?:    string;
}

interface PaheSearchResult {
  id:      number;
  title:   string;
  url:     string;
  year:    number;
  poster:  string;
  type:    string;
  session: string;
}

interface PaheEpisode {
  id:       number;
  number:   number;
  title:    string;
  snapshot: string;
  session:  string;
}

interface PaheSource {
  url:     string;
  quality: string;
  fansub:  string;
  audio:   string;
}

interface PaheM3u8Result {
  m3u8:      string;
  referer:   string;
  headers:   Record<string, string>;
  proxy_url: string;
}

// ─── Config ───────────────────────────────────────────────────
const PAHE_API =
  process.env.ANIMEPAHE_API_URL || "https://your-animepahe-scraper.onrender.com";

const TIMEOUT_MS = 20_000;

// ─── Helpers ──────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function fetchJson<T>(url: string): Promise<T> {
  console.log("[fetch]", url);
  const res = await withTimeout(
    fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SamuraiAnime/1.0)",
        "Accept":     "application/json",
      },
    }),
    TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} — ${text.slice(0, 100)}`);
  }
  return res.json() as Promise<T>;
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s+season\s+\d+/gi, "")
    .replace(/\s+part\s+\d+/gi,   "")
    .replace(/\s+cour\s+\d+/gi,   "")
    .replace(/\s+\(\d{4}\)/g,     "")
    .replace(/\s+[Ss]\d+$/g,      "")
    .trim();
}

function scoreTitleMatch(result: PaheSearchResult, target: string): number {
  const a = result.title.toLowerCase();
  const b = target.toLowerCase();
  if (a === b)                             return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 80;
  if (a.includes(b)   || b.includes(a))   return 60;
  const wordsA  = new Set(a.split(/\s+/));
  const wordsB  = b.split(/\s+/);
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return (overlap / wordsB.length) * 40;
}

function pickSource(sources: PaheSource[], lang: "sub" | "dub"): PaheSource | null {
  if (!sources.length) return null;
  const audioTarget  = lang === "dub" ? "eng" : "jpn";
  const qualityOrder = ["1080p", "800p", "720p", "480p", "360p"];
  const langFiltered = sources.filter((s) => s.audio === audioTarget);
  const pool         = langFiltered.length ? langFiltered : sources;
  for (const q of qualityOrder) {
    const match = pool.find((s) => s.quality === q);
    if (match) return match;
  }
  return pool[0];
}

// ── Rewrite m3u8 playlist so all segment URLs go through our proxy ──
function rewriteM3u8(content: string, baseUrl: string, referer: string): string {
  const base       = new URL(baseUrl);
  const encodedRef = encodeURIComponent(referer);

  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) return line;

      // Resolve relative → absolute URL
      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(trimmed, base).toString();
      } catch {
        return line;
      }

      if (!absoluteUrl.startsWith("http")) return line;

      // Route through our proxy
      return `/api/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodedRef}`;
    })
    .join("\n");
}

// ─── Main AnimePahe Flow ──────────────────────────────────────
async function streamFromAnimePahe(
  title:   string,
  episode: number,
  lang:    "sub" | "dub",
): Promise<StreamResponse | null> {

  // ── Step 1: Search ─────────────────────────────────────────
  const searchTitle = cleanTitle(title);

  let results: PaheSearchResult[];
  try {
    results = await fetchJson<PaheSearchResult[]>(
      `${PAHE_API}/search?q=${encodeURIComponent(searchTitle)}`
    );
  } catch (err: any) {
    console.error("[AnimePahe] Search failed:", err.message);
    return null;
  }

  if (!results?.length) {
    console.log("[AnimePahe] No results for:", searchTitle);
    return null;
  }

  const scored = results
    .map((r) => ({ result: r, score: scoreTitleMatch(r, searchTitle) }))
    .sort((a, b) => b.score - a.score);

  console.log(
    "[AnimePahe] Top matches:",
    scored.slice(0, 3).map((s) => `"${s.result.title}" (${s.score})`).join(", "),
  );

  const best = scored[0].result;
  console.log("[AnimePahe] Using:", best.title, "| session:", best.session);

  // ── Step 2: Get Episodes ────────────────────────────────────
  let episodes: PaheEpisode[];
  try {
    episodes = await fetchJson<PaheEpisode[]>(
      `${PAHE_API}/episodes?session=${best.session}`
    );
  } catch (err: any) {
    console.error("[AnimePahe] Episodes failed:", err.message);
    return null;
  }

  if (!episodes?.length) {
    console.log("[AnimePahe] No episodes");
    return null;
  }

  console.log("[AnimePahe] Got", episodes.length, "episodes");

  const ep = episodes.find((e) => e.number === episode);
  if (!ep) {
    console.log(
      "[AnimePahe] Episode", episode, "not found. Available:",
      episodes.map((e) => e.number).slice(0, 10).join(", "), "...",
    );
    return null;
  }

  console.log("[AnimePahe] Found ep", ep.number, "| session:", ep.session);

  // ── Step 3: Get Sources ─────────────────────────────────────
  let sources: PaheSource[];
  try {
    sources = await fetchJson<PaheSource[]>(
      `${PAHE_API}/sources` +
      `?anime_session=${best.session}` +
      `&episode_session=${ep.session}`
    );
  } catch (err: any) {
    console.error("[AnimePahe] Sources failed:", err.message);
    return null;
  }

  if (!sources?.length) {
    console.log("[AnimePahe] No sources");
    return null;
  }

  console.log(
    "[AnimePahe] Sources:",
    sources.map((s) => `${s.quality}(${s.audio})`).join(", "),
  );

  const source = pickSource(sources, lang);
  if (!source) {
    console.log("[AnimePahe] No suitable source");
    return null;
  }

  console.log("[AnimePahe] Picked:", source.quality, source.audio, source.url);

  // ── Step 4: Resolve M3U8 from Kwik ─────────────────────────
  let m3u8Data: PaheM3u8Result;
  try {
    m3u8Data = await fetchJson<PaheM3u8Result>(
      `${PAHE_API}/m3u8?url=${encodeURIComponent(source.url)}`
    );
  } catch (err: any) {
    console.error("[AnimePahe] M3U8 resolve failed:", err.message);
    return null;
  }

  if (!m3u8Data?.m3u8) {
    console.log("[AnimePahe] No M3U8 in response");
    return null;
  }

  console.log("[AnimePahe] ✓ Got M3U8:", m3u8Data.m3u8.slice(0, 70) + "…");

 // ── Step 5: Return proxied URL ──────────────────────────────
  // Instead of data URI (which HLS.js can't load),
  // return a /api/proxy URL that serves the rewritten m3u8
  const referer = m3u8Data.referer || "https://kwik.cx/";

  // The proxy will fetch the m3u8, rewrite segment URLs, and return it
  const proxyUrl =
    `/api/proxy` +
    `?url=${encodeURIComponent(m3u8Data.m3u8)}` +
    `&referer=${encodeURIComponent(referer)}`;

  console.log("[AnimePahe] ✓ Returning proxy URL:", proxyUrl);

  return {
    url:       proxyUrl,          // /api/proxy?url=...&referer=...
    subtitles: [],
    intro:     null,
    outro:     null,
    source:    `AnimePahe (${source.quality} · ${source.audio === "eng" ? "Dub" : "Sub"})`,
    referer,
    headers:   m3u8Data.headers,
  };

    if (!m3u8Res.ok) throw new Error(`M3U8 fetch failed: ${m3u8Res.status}`);
    m3u8Content = await m3u8Res.text();
  } catch (err: any) {
    console.error("[AnimePahe] M3U8 content fetch failed:", err.message);
    // Fall back to returning proxy URL — let client fetch it
    const proxyUrl =
      `/api/proxy` +
      `?url=${encodeURIComponent(m3u8Data.m3u8)}` +
      `&referer=${encodeURIComponent(referer)}`;

    return {
      url:       proxyUrl,
      subtitles: [],
      intro:     null,
      outro:     null,
      source:    `AnimePahe (${source.quality} · ${source.audio === "eng" ? "Dub" : "Sub"})`,
      referer,
      headers:   m3u8Data.headers,
    };
  }

  // Rewrite all segment/sub-playlist URLs inside the m3u8
  const rewritten = rewriteM3u8(m3u8Content, m3u8Data.m3u8, referer);

  // Encode and return as data URI so HLS.js can load it directly
  // without needing an extra round-trip to /api/proxy
  const encoded   = Buffer.from(rewritten).toString("base64");
  const dataUri   = `data:application/vnd.apple.mpegurl;base64,${encoded}`;

  console.log("[AnimePahe] ✓ M3U8 rewritten, segments proxied");

  return {
    url:       dataUri,
    subtitles: [],
    intro:     null,
    outro:     null,
    source:    `AnimePahe (${source.quality} · ${source.audio === "eng" ? "Dub" : "Sub"})`,
    referer,
    headers:   m3u8Data.headers,
  };
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const { title, episode, lang } = req.query;

  if (!title || typeof title !== "string")
    return res.status(400).json({ error: "title is required" });

  const ep    = parseInt(String(episode || "1")) || 1;
  const audio = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";

  console.log(`\n[stream] title="${title}" ep=${ep} lang=${audio}`);

  const result = await streamFromAnimePahe(title, ep, audio);

  if (result?.url) {
    console.log("[stream] ✓ Success:", result.source);
    return res.status(200).json(result);
  }

  console.log("[stream] ✗ No stream found");
  return res.status(200).json({
    url:       null,
    subtitles: [],
    intro:     null,
    outro:     null,
    source:    null,
    error:     "No stream found on AnimePahe for this title/episode",
  });
}
