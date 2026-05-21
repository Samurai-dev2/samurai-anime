// api/stream.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── Types ────────────────────────────────────────────────────
interface SubtitleTrack {
  url:   string;
  lang:  string;
  label: string;
}

interface StreamResponse {
  url:          string | null;
  subtitles:    SubtitleTrack[];
  intro:        null;
  outro:        null;
  source:       string | null;
  referer?:     string;
  headers?:     Record<string, string>;
  error?:       string;
}

// AnimePahe scraper response shapes
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
  audio:   string; // "jpn" | "eng"
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

// Clean title for better search matching
// e.g. "Shingeki no Kyojin Season 3" → "Shingeki no Kyojin"
function cleanTitle(title: string): string {
  return title
    .replace(/\s+season\s+\d+/gi, "")   // remove "Season X"
    .replace(/\s+part\s+\d+/gi, "")     // remove "Part X"
    .replace(/\s+cour\s+\d+/gi, "")     // remove "Cour X"
    .replace(/\s+\(\d{4}\)/g, "")       // remove "(2024)"
    .replace(/\s+[Ss]\d+$/g, "")        // remove "S2" at end
    .trim();
}

// Score how well a search result matches our target title
function scoreTitleMatch(result: PaheSearchResult, target: string): number {
  const a = result.title.toLowerCase();
  const b = target.toLowerCase();

  if (a === b)                          return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 80;
  if (a.includes(b) || b.includes(a))  return 60;

  // Word overlap score
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = b.split(/\s+/);
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return (overlap / wordsB.length) * 40;
}

// Pick best quality source based on lang preference
function pickSource(
  sources: PaheSource[],
  lang:    "sub" | "dub",
): PaheSource | null {
  if (!sources.length) return null;

  const audioTarget = lang === "dub" ? "eng" : "jpn";

  // Preferred quality order
  const qualityOrder = ["1080p", "800p", "720p", "480p", "360p"];

  // Filter by audio language first
  const langFiltered = sources.filter((s) => s.audio === audioTarget);
  const pool         = langFiltered.length ? langFiltered : sources;

  // Pick highest quality from pool
  for (const q of qualityOrder) {
    const match = pool.find((s) => s.quality === q);
    if (match) return match;
  }

  return pool[0];
}

// ─── Main AnimePahe Flow ──────────────────────────────────────
async function streamFromAnimePahe(
  title:   string,
  episode: number,
  lang:    "sub" | "dub",
): Promise<StreamResponse | null> {

  // ── Step 1: Search ─────────────────────────────────────────
  const searchTitle  = cleanTitle(title);
  const searchUrl    = `${PAHE_API}/search?q=${encodeURIComponent(searchTitle)}`;

  let results: PaheSearchResult[];

  try {
    results = await fetchJson<PaheSearchResult[]>(searchUrl);
  } catch (err: any) {
    console.error("[AnimePahe] Search failed:", err.message);
    return null;
  }

  if (!results?.length) {
    console.log("[AnimePahe] No search results for:", searchTitle);
    return null;
  }

  console.log("[AnimePahe] Search returned", results.length, "results");

  // Score and sort results by title match
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
      `${PAHE_API}/episodes?session=${best.session}`,
    );
  } catch (err: any) {
    console.error("[AnimePahe] Episodes fetch failed:", err.message);
    return null;
  }

  if (!episodes?.length) {
    console.log("[AnimePahe] No episodes found");
    return null;
  }

  console.log("[AnimePahe] Got", episodes.length, "episodes");

  // Find target episode
  const ep = episodes.find((e) => e.number === episode);

  if (!ep) {
    console.log(
      "[AnimePahe] Episode", episode, "not found.",
      "Available:", episodes.map((e) => e.number).slice(0, 10).join(", "), "...",
    );
    return null;
  }

  console.log("[AnimePahe] Found episode", ep.number, "| session:", ep.session);

  // ── Step 3: Get Sources ─────────────────────────────────────
  let sources: PaheSource[];

  try {
    sources = await fetchJson<PaheSource[]>(
      `${PAHE_API}/sources` +
      `?anime_session=${best.session}` +
      `&episode_session=${ep.session}`,
    );
  } catch (err: any) {
    console.error("[AnimePahe] Sources fetch failed:", err.message);
    return null;
  }

  if (!sources?.length) {
    console.log("[AnimePahe] No sources returned");
    return null;
  }

  console.log(
    "[AnimePahe] Sources:",
    sources.map((s) => `${s.quality}(${s.audio})`).join(", "),
  );

  // Pick best source
  const source = pickSource(sources, lang);

  if (!source) {
    console.log("[AnimePahe] No suitable source found");
    return null;
  }

  console.log("[AnimePahe] Picked source:", source.quality, source.audio, source.url);

  // ── Step 4: Resolve M3U8 from Kwik ─────────────────────────
  let m3u8Data: PaheM3u8Result;

  try {
    m3u8Data = await fetchJson<PaheM3u8Result>(
      `${PAHE_API}/m3u8?url=${encodeURIComponent(source.url)}`,
    );
  } catch (err: any) {
    console.error("[AnimePahe] M3U8 resolve failed:", err.message);
    return null;
  }

  if (!m3u8Data?.m3u8) {
    console.log("[AnimePahe] No M3U8 URL in response");
    return null;
  }

  console.log("[AnimePahe] ✓ Got M3U8:", m3u8Data.m3u8.slice(0, 70) + "…");

  return {
    url:       m3u8Data.m3u8,
    subtitles: [],           // AnimePahe uses hardcoded subs in the stream
    intro:     null,
    outro:     null,
    source:    `AnimePahe (${source.quality} · ${source.audio === "eng" ? "Dub" : "Sub"})`,
    referer:   m3u8Data.referer,
    headers:   m3u8Data.headers,
  };
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const { title, episode, lang } = req.query;

  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }

  const ep    = parseInt(String(episode || "1")) || 1;
  const audio = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";

  console.log(`\n[stream] title="${title}" ep=${ep} lang=${audio}`);

  const result = await streamFromAnimePahe(title, ep, audio);

  if (result?.url) {
    console.log("[stream] ✓ Success:", result.source);
    return res.status(200).json(result);
  }

  console.log("[stream] ✗ Failed — no stream found");
  return res.status(200).json({
    url:       null,
    subtitles: [],
    intro:     null,
    outro:     null,
    source:    null,
    error:     "No stream found on AnimePahe for this title/episode",
  });
}
