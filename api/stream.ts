// api/stream.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

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

const PAHE_API =
  process.env.ANIMEPAHE_API_URL || "https://your-animepahe-scraper.onrender.com";

const TIMEOUT_MS = 20_000;

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

// Extract season number from title if present
// "Attack on Titan Season 2" → 2
// "Sword Art Online II" → 2
// "Re:Zero Season 2 Part 2" → 2
function extractSeasonFromTitle(title: string): number | null {
  const patterns = [
    /\bseason\s+(\d+)/i,
    /\bs(\d+)\b/i,
    /\b(\d+)(?:st|nd|rd|th)\s+season/i,
    // Roman numerals II, III, IV (common in anime)
    /\b(II|III|IV|V)\b/,
  ];

  const romanMap: Record<string, number> = {
    II: 2, III: 3, IV: 4, V: 5,
  };

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const val = match[1];
      return romanMap[val] ?? parseInt(val);
    }
  }
  return null;
}

// Clean title for search — remove season/part suffixes
function cleanTitle(title: string): string {
  return title
    .replace(/\s+season\s+\d+/gi,    "")
    .replace(/\s+part\s+\d+/gi,      "")
    .replace(/\s+cour\s+\d+/gi,      "")
    .replace(/\s+\(\d{4}\)/g,        "")
    .replace(/\s+[Ss]\d+$/g,         "")
    .replace(/\s+(II|III|IV|V)$/,    "")  // remove Roman numerals
    .replace(/\s+\d+(?:st|nd|rd|th)\s+season/gi, "")
    .trim();
}

// Score title match — higher = better
function scoreTitleMatch(
  result:       PaheSearchResult,
  cleanedQuery: string,
  seasonNum:    number | null,
): number {
  const a = result.title.toLowerCase();
  const b = cleanedQuery.toLowerCase();

  let score = 0;

  // Base title similarity
  if (a === b)                             score += 100;
  else if (a.startsWith(b) || b.startsWith(a)) score += 80;
  else if (a.includes(b) || b.includes(a))     score += 60;
  else {
    const wordsA  = new Set(a.split(/\s+/));
    const wordsB  = b.split(/\s+/);
    const overlap = wordsB.filter((w) => wordsA.has(w)).length;
    score += (overlap / wordsB.length) * 40;
  }

  // Season matching bonus/penalty
  if (seasonNum && seasonNum > 1) {
    const resultSeason = extractSeasonFromTitle(result.title);

    if (resultSeason === seasonNum) {
      score += 50; // Strong bonus for matching season
    } else if (resultSeason === null && seasonNum > 1) {
      score -= 20; // Penalty if no season in result but we want S2+
    } else if (resultSeason !== null && resultSeason !== seasonNum) {
      score -= 40; // Strong penalty for wrong season
    }

    // Check for season keywords in result title
    const seasonKeywords = [
      `season ${seasonNum}`,
      `s${seasonNum}`,
      // Roman numerals for seasons 2-5
      ["", "", "ii", "iii", "iv", "v"][seasonNum] ?? "",
    ].filter(Boolean);

    const resultLower = result.title.toLowerCase();
    if (seasonKeywords.some((kw) => resultLower.includes(kw))) {
      score += 30;
    }
  } else {
    // For season 1 — penalise results that have a season number > 1
    const resultSeason = extractSeasonFromTitle(result.title);
    if (resultSeason && resultSeason > 1) {
      score -= 30;
    }
  }

  return score;
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

// ─── Main flow ────────────────────────────────────────────────
async function streamFromAnimePahe(
  title:     string,
  episode:   number,
  lang:      "sub" | "dub",
  seasonNum: number,
): Promise<StreamResponse | null> {

  // ── Step 1: Search ─────────────────────────────────────────
  const searchTitle = cleanTitle(title);
  console.log(
    `[AnimePahe] Searching: "${searchTitle}" (original: "${title}", season: ${seasonNum})`
  );

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

  console.log("[AnimePahe] Got", results.length, "results");

  // Score all results
  const scored = results
    .map((r) => ({
      result: r,
      score:  scoreTitleMatch(r, searchTitle, seasonNum),
    }))
    .sort((a, b) => b.score - a.score);

  console.log(
    "[AnimePahe] Scored results:",
    scored
      .slice(0, 5)
      .map((s) => `"${s.result.title}" → ${s.score}`)
      .join(" | "),
  );

  // Always pick the top-scored result
  // (even if score is low — first result is best guess)
  const best = scored[0].result;
  console.log("[AnimePahe] Selected:", best.title, "| session:", best.session);

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

  // Find episode — if not found in best result, try next scored results
  let ep = episodes.find((e) => e.number === episode);

  if (!ep) {
    console.log(
      `[AnimePahe] Episode ${episode} not found in "${best.title}". Trying other results...`
    );

    // Try each other result in score order
    for (const { result: alt } of scored.slice(1)) {
      console.log("[AnimePahe] Trying alt:", alt.title);
      try {
        const altEps = await fetchJson<PaheEpisode[]>(
          `${PAHE_API}/episodes?session=${alt.session}`
        );
        const altEp = altEps?.find((e) => e.number === episode);
        if (altEp) {
          console.log("[AnimePahe] Found ep", episode, "in alt:", alt.title);
          episodes = altEps;
          ep = altEp;
          // Update best to this alt
          Object.assign(best, alt);
          break;
        }
      } catch {
        // continue to next
      }
    }
  }

  if (!ep) {
    console.log(
      "[AnimePahe] Episode", episode, "not found in any result.",
      "Available in best:", episodes.map((e) => e.number).slice(0, 10).join(", "),
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

  console.log("[AnimePahe] Picked:", source.quality, source.audio);

  // ── Step 4: Resolve M3U8 ───────────────────────────────────
  let m3u8Data: PaheM3u8Result;
  try {
    m3u8Data = await fetchJson<PaheM3u8Result>(
      `${PAHE_API}/m3u8?url=${encodeURIComponent(source.url)}`
    );
  } catch (err: any) {
    console.error("[AnimePahe] M3U8 failed:", err.message);
    return null;
  }

  if (!m3u8Data?.m3u8) {
    console.log("[AnimePahe] No M3U8");
    return null;
  }

  console.log("[AnimePahe] ✓ M3U8:", m3u8Data.m3u8.slice(0, 70) + "…");

  const referer  = m3u8Data.referer || "https://kwik.cx/";
  const proxyUrl =
    `/api/proxy` +
    `?url=${encodeURIComponent(m3u8Data.m3u8)}` +
    `&referer=${encodeURIComponent(referer)}`;

  return {
    url:       proxyUrl,
    subtitles: [],
    intro:     null,
    outro:     null,
    source:    `AnimePahe · ${source.quality} · ${source.audio === "eng" ? "Dub" : "Sub"}`,
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

  const { title, episode, lang, season } = req.query;

  if (!title || typeof title !== "string")
    return res.status(400).json({ error: "title is required" });

  const ep        = parseInt(String(episode || "1")) || 1;
  const audio     = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";
  const seasonNum = parseInt(String(season || "1")) || 1;

  console.log(`\n[stream] "${title}" S${seasonNum}E${ep} lang=${audio}`);

  const result = await streamFromAnimePahe(title, ep, audio, seasonNum);

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
    error:     "No stream found on AnimePahe",
  });
}
