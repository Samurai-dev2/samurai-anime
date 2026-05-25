// api/stream.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

interface StreamResponse {
  url:       string | null;
  subtitles: any[];
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

const PAHE_API =
  process.env.ANIMEPAHE_API_URL ||
  "https://animepahe-api-topaz-eta.vercel.app";

const TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function fetchJson<T>(url: string, label = ""): Promise<T> {
  console.log(`[fetch${label ? " " + label : ""}]`, url.slice(0, 120));
  const res = await withTimeout(
    fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SamuraiAnime/1.0)",
        "Accept":     "application/json",
      },
    }),
    TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
  }
  return res.json() as Promise<T>;
}

const ROMAN: Record<string, number> = { II: 2, III: 3, IV: 4, V: 5 };

function extractSeasonFromTitle(title: string): number | null {
  const patterns: [RegExp, (m: RegExpMatchArray) => number][] = [
    [/\bseason\s+(\d+)/i,                (m) => parseInt(m[1])],
    [/\bs(\d+)\b/i,                      (m) => parseInt(m[1])],
    [/\b(\d+)(?:st|nd|rd|th)\s+season/i, (m) => parseInt(m[1])],
    [/\b(II|III|IV|V)\b/,                (m) => ROMAN[m[1]]],
  ];
  for (const [re, extract] of patterns) {
    const match = title.match(re);
    if (match) return extract(match);
  }
  return null;
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s+season\s+\d+/gi, "")
    .replace(/\s+part\s+\d+/gi,   "")
    .replace(/\s+cour\s+\d+/gi,   "")
    .replace(/\s+\(\d{4}\)/g,     "")
    .replace(/\s+[Ss]\d+$/g,      "")
    .replace(/\s+(II|III|IV|V)$/, "")
    .replace(/\s+\d+(?:st|nd|rd|th)\s+season/gi, "")
    .trim();
}

function scoreTitleMatch(
  result: PaheSearchResult,
  cleanedQuery: string,
  seasonNum: number
): number {
  const a = result.title.toLowerCase();
  const b = cleanedQuery.toLowerCase();
  let score = 0;

  if (a === b)                                  score += 100;
  else if (a.startsWith(b) || b.startsWith(a)) score += 80;
  else if (a.includes(b) || b.includes(a))      score += 60;
  else {
    const wordsA  = new Set(a.split(/\s+/));
    const wordsB  = b.split(/\s+/);
    const overlap = wordsB.filter((w) => wordsA.has(w)).length;
    score += (overlap / Math.max(wordsB.length, 1)) * 40;
  }

  const resultSeason = extractSeasonFromTitle(result.title);
  if (seasonNum > 1) {
    if (resultSeason === seasonNum)       score += 50;
    else if (resultSeason === null)       score -= 20;
    else                                  score -= 40;

    const want = [
      `season ${seasonNum}`,
      `s${seasonNum}`,
      Object.entries(ROMAN).find(([, v]) => v === seasonNum)?.[0]?.toLowerCase() ?? "",
    ].filter(Boolean);
    if (want.some((kw) => a.includes(kw))) score += 30;
  } else {
    if (resultSeason && resultSeason > 1) score -= 30;
  }
  return score;
}

const QUALITY_ORDER = ["1080p", "800p", "720p", "480p", "360p"];

function pickSource(sources: PaheSource[], lang: "sub" | "dub"): PaheSource | null {
  if (!sources.length) return null;
  const audioTarget = lang === "dub" ? "eng" : "jpn";
  const preferred   = sources.filter((s) => s.audio === audioTarget);
  const pool        = preferred.length ? preferred : sources;
  for (const q of QUALITY_ORDER) {
    const match = pool.find((s) => s.quality === q);
    if (match) return match;
  }
  return pool[0] ?? null;
}

async function streamFromAnimePahe(
  title:     string,
  episode:   number,
  lang:      "sub" | "dub",
  seasonNum: number
): Promise<StreamResponse | null> {

  // 1. Search
  const searchTitle = cleanTitle(title);
  console.log(`\n[AnimePahe] "${searchTitle}" S${seasonNum}E${episode} ${lang}`);

  let results: PaheSearchResult[];
  try {
    results = await fetchJson<PaheSearchResult[]>(
      `${PAHE_API}/search?q=${encodeURIComponent(searchTitle)}`, "search"
    );
  } catch (err: any) {
    console.error("[AnimePahe] Search error:", err.message);
    return null;
  }

  if (!Array.isArray(results) || !results.length) return null;

  const scored = results
    .map((r) => ({ r, score: scoreTitleMatch(r, searchTitle, seasonNum) }))
    .sort((a, b) => b.score - a.score);

  console.log("[AnimePahe] Top:", scored.slice(0, 3).map(({ r, score }) =>
    `"${r.title}"(${score})`).join(" | "));

  // 2. Find episode
  let chosenAnime: PaheSearchResult | null = null;
  let episodes:    PaheEpisode[]           = [];
  let ep:          PaheEpisode | null      = null;

  for (const { r, score } of scored) {
    if (score < 20 && chosenAnime !== null) break;

    let eps: PaheEpisode[];
    try {
      eps = await fetchJson<PaheEpisode[]>(
        `${PAHE_API}/episodes?session=${r.session}`, "episodes"
      );
    } catch { continue; }

    if (!Array.isArray(eps) || !eps.length) continue;

    const found = eps.find((e) => e.number === episode);
    if (found) {
      chosenAnime = r; episodes = eps; ep = found;
      console.log(`[AnimePahe] ✓ Found E${episode} in "${r.title}"`);
      break;
    }
    if (!chosenAnime) { chosenAnime = r; episodes = eps; }
  }

  if (!ep || !chosenAnime) {
    console.log(`[AnimePahe] E${episode} not found`);
    return null;
  }

  // 3. Sources
  let sources: PaheSource[];
  try {
    sources = await fetchJson<PaheSource[]>(
      `${PAHE_API}/sources?anime_session=${chosenAnime.session}&episode_session=${ep.session}`,
      "sources"
    );
  } catch (err: any) {
    console.error("[AnimePahe] Sources error:", err.message);
    return null;
  }

  if (!Array.isArray(sources) || !sources.length) return null;

  const source = pickSource(sources, lang);
  if (!source) return null;

  console.log("[AnimePahe] Picked:", source.quality, source.audio, source.url);

  // 4. Get M3U8
  let m3u8Data: PaheM3u8Result;
  try {
    m3u8Data = await fetchJson<PaheM3u8Result>(
      `${PAHE_API}/m3u8?url=${encodeURIComponent(source.url)}`, "m3u8"
    );
  } catch (err: any) {
    console.error("[AnimePahe] M3U8 error:", err.message);
    return null;
  }

  if (!m3u8Data?.m3u8) return null;

  console.log("[AnimePahe] ✓ M3U8:", m3u8Data.m3u8.slice(0, 80));

  const referer    = m3u8Data.referer || "https://kwik.cx/";
  const audioLabel = source.audio === "eng" ? "Dub" : "Sub";

  // Return the proxy URL pointing to the fresh M3U8
  const proxyUrl =
    `/api/proxy` +
    `?url=${encodeURIComponent(m3u8Data.m3u8)}` +
    `&referer=${encodeURIComponent(referer)}`;

  return {
    url:       proxyUrl,
    subtitles: [],
    intro:     null,
    outro:     null,
    source:    `AnimePahe · ${source.quality} · ${audioLabel}`,
    referer,
    headers:   m3u8Data.headers ?? {},
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const { title, episode, lang, season } = req.query;
  if (!title || typeof title !== "string")
    return res.status(400).json({ error: "title is required" });

  const ep        = Math.max(1, parseInt(String(episode || "1")) || 1);
  const audio     = lang === "dub" ? "dub" : "sub" as "sub" | "dub";
  const seasonNum = Math.max(1, parseInt(String(season  || "1")) || 1);

  console.log(`\n══ [stream] "${title}" S${seasonNum}E${ep} [${audio}] ══`);

  try {
    const result = await streamFromAnimePahe(title, ep, audio, seasonNum);

    if (result?.url) {
      console.log("[stream] ✓", result.source);
      return res.status(200).json(result);
    }

    return res.status(200).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "No stream found on AnimePahe",
    });
  } catch (err: any) {
    console.error("[stream] Error:", err.message);
    return res.status(500).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "Internal server error",
    });
  }
}
