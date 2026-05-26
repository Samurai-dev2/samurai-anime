// api/stream.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

interface StreamResponse {
  url:       string | null;
  subtitles: SubtitleTrack[];
  intro:     { start: number; end: number } | null;
  outro:     { start: number; end: number } | null;
  source:    string | null;
  referer?:  string;
  headers?:  Record<string, string>;
  error?:    string;
}

interface SubtitleTrack {
  url:   string;
  lang:  string;
  label: string;
}

interface MiruroEpisode {
  id:           string;
  number:       number;
  title:        string;
  image?:       string;
  airDate?:     string;
  duration?:    number;
  description?: string;
  filler?:      boolean;
}

interface MiruroProviders {
  [provider: string]: {
    episodes: {
      sub?: MiruroEpisode[];
      dub?: MiruroEpisode[];
    };
  };
}

interface MiruroEpisodesResponse {
  mappings:  Record<string, number | string>;
  providers: MiruroProviders;
}

interface MiruroStream {
  url:     string;
  type:    string;
  quality: string;
}

interface MiruroSubtitle {
  file:  string;
  label: string;
  kind?: string;
}

interface MiruroWatchResponse {
  streams:   MiruroStream[];
  subtitles: MiruroSubtitle[];
  intro:     { start: number; end: number } | null;
  outro:     { start: number; end: number } | null;
}

interface MiruroSearchResult {
  id:    number;
  title: {
    romaji:  string;
    english: string | null;
    native:  string;
  };
  idMal: number | null;
}

interface MiruroSearchResponse {
  results: MiruroSearchResult[];
}

// ── Config ────────────────────────────────────────────────────
const MIRURO_API     = "https://api-test-blush-one.vercel.app";
const PROVIDER_ORDER = ["kiwi", "arc", "zoro", "jet"];
const TIMEOUT_MS     = 25_000;

// ── Helpers ───────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function fetchJson<T>(url: string, label = ""): Promise<T> {
  console.log(`[stream${label ? " " + label : ""}]`, url.slice(0, 120));

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
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

// ── Method 1: Use Miruro /search to find AniList ID by title ──
async function getAnilistIdByTitle(title: string): Promise<number | null> {
  try {
    const url = `${MIRURO_API}/search?query=${encodeURIComponent(title)}&per_page=5`;
    const data = await fetchJson<MiruroSearchResponse>(url, "search");

    if (!data?.results?.length) {
      console.log("[stream] No search results for:", title);
      return null;
    }

    console.log(
      "[stream] Search results:",
      data.results.map((r) =>
        `"${r.title.english ?? r.title.romaji}" (AniList:${r.id} MAL:${r.idMal})`
      ).join(" | ")
    );

    return data.results[0].id;
  } catch (err: any) {
    console.warn("[stream] Title search failed:", err.message);
    return null;
  }
}

// ── Method 2: Use AniList GraphQL to convert MAL ID ───────────
async function malToAnilistViaGraphQL(malId: number): Promise<number | null> {
  try {
    const query = `
      query ($malId: Int) {
        Media(idMal: $malId, type: ANIME) {
          id
          title { romaji english }
        }
      }
    `;
    const res = await withTimeout(
      fetch("https://graphql.anilist.co", {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept":       "application/json",
        },
        body: JSON.stringify({ query, variables: { malId } }),
      }),
      10_000
    );

    if (!res.ok) {
      console.warn("[stream] AniList GraphQL returned:", res.status);
      return null;
    }

    const data = await res.json();

    if (data?.errors?.length) {
      console.warn("[stream] AniList GraphQL error:", data.errors[0]?.message);
      return null;
    }

    const id    = data?.data?.Media?.id;
    const title = data?.data?.Media?.title?.english ?? data?.data?.Media?.title?.romaji;

    if (id) {
      console.log(`[stream] GraphQL: MAL ${malId} → AniList ${id} ("${title}")`);
      return id;
    }
    return null;
  } catch (err: any) {
    console.warn("[stream] GraphQL conversion failed:", err.message);
    return null;
  }
}

// ── Method 3: Use Miruro /search with MAL ID as fallback ──────
async function malToAnilistViaMiruroSearch(
  malId:  number,
  title?: string
): Promise<number | null> {
  if (!title) return null;

  try {
    const url  = `${MIRURO_API}/search?query=${encodeURIComponent(title)}&per_page=10`;
    const data = await fetchJson<MiruroSearchResponse>(url, "mal-search");

    if (!data?.results?.length) return null;

    // Try to match by MAL ID first
    const byMal = data.results.find((r) => r.idMal === malId);
    if (byMal) {
      console.log(`[stream] Miruro search: MAL ${malId} → AniList ${byMal.id}`);
      return byMal.id;
    }

    // Fall back to first result
    const first = data.results[0];
    console.log(
      `[stream] Miruro search fallback: "${first.title.english ?? first.title.romaji}" → AniList ${first.id}`
    );
    return first.id;
  } catch (err: any) {
    console.warn("[stream] Miruro search fallback failed:", err.message);
    return null;
  }
}

// ── Get AniList ID using all available methods ────────────────
async function resolveAnilistId(
  malId: number,
  title?: string
): Promise<number | null> {
  console.log(`[stream] Resolving AniList ID for MAL ${malId} ("${title ?? "?"}")`);

  // Try all methods in parallel for speed
  const [graphqlId, miruroId] = await Promise.all([
    malToAnilistViaGraphQL(malId),
    malToAnilistViaMiruroSearch(malId, title),
  ]);

  const id = graphqlId ?? miruroId;

  if (id) {
    console.log(`[stream] ✓ Resolved AniList ID: ${id}`);
    return id;
  }

  console.error(`[stream] ✗ Could not resolve AniList ID for MAL ${malId}`);
  return null;
}

// ── Main streaming function ───────────────────────────────────
async function streamFromMiruro(
  anilistId: number,
  episode:   number,
  lang:      "sub" | "dub"
): Promise<StreamResponse | null> {

  // ── Step 1: Get episodes ──────────────────────────────────
  let episodesData: MiruroEpisodesResponse;
  try {
    episodesData = await fetchJson<MiruroEpisodesResponse>(
      `${MIRURO_API}/episodes/${anilistId}`,
      "episodes"
    );
  } catch (err: any) {
    console.error("[stream] Episodes fetch failed:", err.message);
    return null;
  }

  if (!episodesData?.providers) {
    console.log("[stream] No providers in response:", JSON.stringify(episodesData).slice(0, 200));
    return null;
  }

  const availableProviders = Object.keys(episodesData.providers);
  console.log("[stream] Available providers:", availableProviders.join(", "));

  // ── Step 2: Find episode ──────────────────────────────────
  let episodeId: string | null = null;
  let provider:  string | null = null;
  let usedLang:  string        = lang;

  for (const prov of PROVIDER_ORDER) {
    const provData = episodesData.providers[prov];
    if (!provData?.episodes) continue;

    const langsToTry = lang === "sub" ? ["sub", "dub"] : ["dub", "sub"];

    for (const tryLang of langsToTry) {
      const eps = provData.episodes[tryLang as "sub" | "dub"];
      if (!Array.isArray(eps) || !eps.length) continue;

      const ep = eps.find((e) => e.number === episode);
      if (ep?.id) {
        episodeId = ep.id;
        provider  = prov;
        usedLang  = tryLang;
        console.log(`[stream] Found E${episode} in "${prov}" [${tryLang}]: ${ep.id}`);
        break;
      }
    }
    if (episodeId) break;
  }

  // If preferred providers failed, try ALL available providers
  if (!episodeId) {
    console.log("[stream] Preferred providers failed, trying all providers...");

    for (const prov of availableProviders) {
      if (PROVIDER_ORDER.includes(prov)) continue; // already tried
      const provData = episodesData.providers[prov];
      if (!provData?.episodes) continue;

      for (const tryLang of ["sub", "dub"]) {
        const eps = provData.episodes[tryLang as "sub" | "dub"];
        if (!Array.isArray(eps)) continue;

        const ep = eps.find((e) => e.number === episode);
        if (ep?.id) {
          episodeId = ep.id;
          provider  = prov;
          usedLang  = tryLang;
          console.log(`[stream] Found E${episode} in fallback provider "${prov}" [${tryLang}]`);
          break;
        }
      }
      if (episodeId) break;
    }
  }

  if (!episodeId || !provider) {
    // Log what episodes ARE available to help debug
    for (const prov of availableProviders.slice(0, 2)) {
      const sub = episodesData.providers[prov]?.episodes?.sub;
      if (sub?.length) {
        console.log(
          `[stream] "${prov}" has episodes:`,
          sub.slice(0, 5).map((e) => e.number).join(", ")
        );
      }
    }
    console.log(`[stream] E${episode} not found in any provider`);
    return null;
  }

  // ── Step 3: Get watch data ────────────────────────────────
  // episodeId format: "watch/kiwi/178005/sub/animepahe-1"
  // Watch URL format: {MIRURO_API}/watch/kiwi/178005/sub/animepahe-1
  const watchUrl = `${MIRURO_API}/${episodeId}`;
  console.log("[stream] Watch URL:", watchUrl);

  let watchData: MiruroWatchResponse;
  try {
    watchData = await fetchJson<MiruroWatchResponse>(watchUrl, "watch");
  } catch (err: any) {
    console.error("[stream] Watch fetch failed:", err.message);
    return null;
  }

  if (!watchData?.streams?.length) {
    console.log(
      "[stream] No streams in watch response:",
      JSON.stringify(watchData).slice(0, 200)
    );
    return null;
  }

  console.log(
    "[stream] Streams:",
    watchData.streams.map((s) => `${s.quality}(${s.type})`).join(", ")
  );

  // Pick best HLS stream
  const hlsStreams = watchData.streams
    .filter((s) => s.type === "hls" && s.url)
    .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

  const stream = hlsStreams[0] ?? watchData.streams.find((s) => s.url);

  if (!stream?.url) {
    console.log("[stream] No valid stream URL found");
    return null;
  }

  console.log("[stream] ✓ Stream:", stream.url.slice(0, 80));

  // Determine correct referer for the CDN
  let streamReferer = "https://kwik.cx/";
  try {
    const streamHostname = new URL(stream.url).hostname;
    console.log("[stream] Stream hostname:", streamHostname);

    if (streamHostname.includes("rapid-cloud") || streamHostname.includes("megacloud")) {
      streamReferer = "https://zoro.to/";
    } else if (streamHostname.includes("uwucdn") || streamHostname.includes("owocdn")) {
      streamReferer = "https://kwik.cx/";
    } else if (streamHostname.includes("gogocdn") || streamHostname.includes("gogoanime")) {
      streamReferer = "https://gogoanime.tel/";
    }
  } catch {}

  const subtitles: SubtitleTrack[] = (watchData.subtitles ?? [])
    .filter((s) => s.file && s.label)
    .map((s) => ({
      url:   s.file,
      lang:  s.label.toLowerCase().slice(0, 2),
      label: s.label,
    }));

  const proxyUrl =
    `/api/proxy` +
    `?url=${encodeURIComponent(stream.url)}` +
    `&referer=${encodeURIComponent(streamReferer)}`;

  return {
    url:       proxyUrl,
    subtitles,
    intro:     watchData.intro  ?? null,
    outro:     watchData.outro  ?? null,
    source:    `Miruro · ${provider} · ${stream.quality} · ${usedLang}`,
    referer:   streamReferer,
    headers:   {},
  };
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const { episode, lang, malId, title } = req.query;

  if (!malId || typeof malId !== "string")
    return res.status(400).json({ error: "malId is required" });

  const malIdNum = parseInt(malId);
  if (isNaN(malIdNum))
    return res.status(400).json({ error: "malId must be a number" });

  const ep        = Math.max(1, parseInt(String(episode || "1")) || 1);
  const audio     = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";
  const titleStr  = typeof title === "string" ? title : undefined;

  console.log(`\n══ [stream] malId=${malIdNum} title="${titleStr}" E${ep} [${audio}] ══`);

  try {
    // Resolve AniList ID from MAL ID
    const anilistId = await resolveAnilistId(malIdNum, titleStr);

    if (!anilistId) {
      return res.status(200).json({
        url: null, subtitles: [], intro: null, outro: null,
        source: null,
        error: `Could not find AniList ID for MAL ID ${malIdNum}`,
      });
    }

    console.log(`[stream] Using AniList ID: ${anilistId}`);

    const result = await streamFromMiruro(anilistId, ep, audio);

    if (result?.url) {
      console.log("[stream] ✓", result.source);
      return res.status(200).json(result);
    }

    return res.status(200).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "No stream found for this episode",
    });

  } catch (err: any) {
    console.error("[stream] Unhandled error:", err.message);
    return res.status(500).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "Internal server error",
    });
  }
}
