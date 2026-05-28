// api/stream.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import animeSeasons from "../src/data/anime-seasons.json";

// ── Types ─────────────────────────────────────────────────────
interface AnimeMapping {
  mal_id:     number;
  anilist_id: number;
  type?:      string;
  season?:    { tvdb?: number; tmdb?: number };
}

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
  title?:       string;
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

interface ProxifyResponse {
  proxifiedSource: {
    miruro?:     string;
    anikuro?:    string;
    lunaranime?: string;
    animanga?:   string;
  };
}

// ── Config ────────────────────────────────────────────────────
const MIRURO_API  = "https://api-test-blush-one.vercel.app";
const PROXIFY_API = "https://web-production-3a1a9.up.railway.app";

// Provider priority order — most reliable first
const PROVIDER_ORDER = ["kiwi", "arc", "zoro", "jet"];

// Per-step timeouts — must sum to well under 25s (Vercel Pro limit)
// Free tier is 10s total — if on free tier, reduce these significantly
const TIMEOUT_EPISODES = 8_000;
const TIMEOUT_WATCH    = 8_000;
const TIMEOUT_PROXIFY  = 6_000;

// ── MAL → AniList map ────────────────────────────────────────
const malToAnilist = new Map<number, number>();
const malToType    = new Map<number, string>();

for (const entry of animeSeasons as AnimeMapping[]) {
  if (entry.mal_id && entry.anilist_id) {
    malToAnilist.set(entry.mal_id, entry.anilist_id);
  }
  if (entry.mal_id && entry.type) {
    malToType.set(entry.mal_id, entry.type);
  }
}

console.log(`[stream] Mapper loaded: ${malToAnilist.size} entries`);

// ── Helpers ───────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, label = ""): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms${label ? " (" + label + ")" : ""}`)),
        ms
      )
    ),
  ]);
}

async function fetchJson<T>(url: string, timeoutMs: number, label = ""): Promise<T> {
  console.log(`[stream/${label}] GET`, url.slice(0, 140));

  const res = await withTimeout(
    fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SamuraiAnime/1.0)",
        "Accept":     "application/json",
      },
    }),
    timeoutMs,
    label
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

// ── Detect referer from stream URL ────────────────────────────
function detectReferer(streamUrl: string): string {
  try {
    const { hostname } = new URL(streamUrl);
    console.log("[stream] CDN hostname:", hostname);

    // Zoro / Aniwatch CDNs
    if (
      hostname.includes("rapid-cloud") ||
      hostname.includes("megacloud") ||
      hostname.includes("vidcloud")
    ) return "https://zoro.to/";

    // GogoAnime CDN
    if (
      hostname.includes("gogocdn") ||
      hostname.includes("gogoanime") ||
      hostname.includes("gogo-stream")
    ) return "https://gogoanime.tel/";

    // AnimePahe CDN
    if (
      hostname.includes("owocdn") ||
      hostname.includes("kwik") ||
      hostname.includes("animepahe")
    ) return "https://kwik.cx/";

    // Arc CDN
    if (
      hostname.includes("code29wave") ||
      hostname.includes("megaup")
    ) return "https://megaup.nl/";

    // Default — works for most providers
    return "https://kwik.cx/";
  } catch {
    return "https://kwik.cx/";
  }
}

// ── Normalize episode ID → full watch path ────────────────────
// The Miruro API returns episode IDs in the format:
//   "watch/kiwi/178005/sub/animepahe-1"
// But some providers may return just a slug. This normalizes both.
function buildWatchUrl(
  episodeId: string,
  provider:  string,
  anilistId: number,
  lang:      string
): string {
  // Already a full path like "watch/kiwi/..."
  if (episodeId.startsWith("watch/")) {
    return `${MIRURO_API}/${episodeId}`;
  }

  // Slug only like "animepahe-1" — build the full path
  return `${MIRURO_API}/watch/${provider}/${anilistId}/${lang}/${episodeId}`;
}

// ── Proxify ───────────────────────────────────────────────────
async function proxifyStream(
  streamUrl: string,
  referer:   string
): Promise<string | null> {
  try {
    const data     = `${streamUrl}|${referer}`;
    const endpoint = `${PROXIFY_API}/proxy?data=${encodeURIComponent(data)}`;
    console.log("[proxify] →", endpoint.slice(0, 140));

    const res = await withTimeout(
      fetch(endpoint, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SamuraiAnime/1.0)",
          "Accept":     "application/json",
        },
      }),
      TIMEOUT_PROXIFY,
      "proxify"
    );

    if (!res.ok) {
      console.warn("[proxify] HTTP", res.status);
      return null;
    }

    const json = (await res.json()) as ProxifyResponse;
    const src  = json?.proxifiedSource;
    if (!src) { console.warn("[proxify] Empty proxifiedSource"); return null; }

    // Pick in order of reliability
    const picked =
      src.lunaranime ?? // simplest, most compatible
      src.miruro     ?? // XOR encrypted, very reliable
      src.anikuro    ?? // base64
      src.animanga   ?? // JSON headers
      null;

    if (picked) console.log("[proxify] ✓", picked.slice(0, 100));
    else        console.warn("[proxify] All providers null");

    return picked;
  } catch (err: any) {
    console.warn("[proxify] Failed:", err.message);
    return null;
  }
}

// ── Core stream resolver ──────────────────────────────────────
async function resolveStream(
  anilistId: number,
  episode:   number,
  lang:      "sub" | "dub"
): Promise<StreamResponse> {

  // ── Step 1: Fetch episode list ──────────────────────────────
  let episodesData: MiruroEpisodesResponse;

  try {
    episodesData = await fetchJson<MiruroEpisodesResponse>(
      `${MIRURO_API}/episodes/${anilistId}`,
      TIMEOUT_EPISODES,
      "episodes"
    );
  } catch (err: any) {
    console.error("[stream] Episodes fetch failed:", err.message);
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null,
      error: `Could not fetch episode list: ${err.message}`,
    };
  }

  if (!episodesData?.providers) {
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "No providers returned from episodes API",
    };
  }

  const availableProviders = Object.keys(episodesData.providers);
  console.log("[stream] Available providers:", availableProviders.join(", "));

  // ── Step 2: Find the episode across providers ───────────────
  const orderedProviders = [
    ...PROVIDER_ORDER.filter((p) => availableProviders.includes(p)),
    ...availableProviders.filter((p) => !PROVIDER_ORDER.includes(p)),
  ];

  let episodeId:  string | null = null;
  let provider:   string | null = null;
  let resolvedLang              = lang;

  for (const prov of orderedProviders) {
    const provData = episodesData.providers[prov];
    if (!provData?.episodes) continue;

    // Try requested lang first, then fallback
    const langsToTry: ("sub" | "dub")[] =
      lang === "sub" ? ["sub", "dub"] : ["dub", "sub"];

    for (const tryLang of langsToTry) {
      const eps = provData.episodes[tryLang];
      if (!Array.isArray(eps) || eps.length === 0) continue;

      const ep = eps.find((e) => e.number === episode);
      if (ep?.id) {
        episodeId    = ep.id;
        provider     = prov;
        resolvedLang = tryLang;
        console.log(
          `[stream] ✓ Found E${episode} in "${prov}" [${tryLang}]: ${ep.id}`
        );
        break;
      }
    }
    if (episodeId) break;
  }

  // Debug: log what's actually available if not found
  if (!episodeId) {
    for (const prov of orderedProviders.slice(0, 3)) {
      const sub = episodesData.providers[prov]?.episodes?.sub;
      const dub = episodesData.providers[prov]?.episodes?.dub;
      console.log(
        `[stream] "${prov}" sub: [${sub?.map((e) => e.number).slice(0, 10).join(",")}]`,
        `dub: [${dub?.map((e) => e.number).slice(0, 10).join(",")}]`
      );
    }

    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null,
      error: `Episode ${episode} not found in any provider. ` +
             `Available providers: ${orderedProviders.join(", ")}`,
    };
  }

  // ── Step 3: Fetch watch / stream sources ────────────────────
  const watchUrl = buildWatchUrl(episodeId, provider!, anilistId, resolvedLang);
  console.log("[stream] Watch URL:", watchUrl);

  let watchData: MiruroWatchResponse;
  try {
    watchData = await fetchJson<MiruroWatchResponse>(
      watchUrl,
      TIMEOUT_WATCH,
      "watch"
    );
  } catch (err: any) {
    console.error("[stream] Watch fetch failed:", err.message);
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null,
      error: `Could not fetch stream sources: ${err.message}`,
    };
  }

  // Validate response
  if (!watchData?.streams?.length) {
    console.error(
      "[stream] Empty streams. Raw response:",
      JSON.stringify(watchData).slice(0, 300)
    );
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null,
      error: "Stream API returned no playable sources",
    };
  }

  console.log(
    "[stream] Streams:",
    watchData.streams.map((s) => `${s.quality}(${s.type})`).join(", ")
  );

  // ── Step 4: Pick best stream ─────────────────────────────────
  // Prefer HLS, sorted by quality descending
  const hlsStreams = watchData.streams
    .filter((s) => s.type === "hls" && s.url)
    .sort((a, b) => {
      const qa = parseInt(a.quality) || 0;
      const qb = parseInt(b.quality) || 0;
      return qb - qa;
    });

  // Fallback to any stream with a URL
  const bestStream =
    hlsStreams[0] ??
    watchData.streams.find((s) => s.url) ??
    null;

  if (!bestStream?.url) {
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "No playable stream URL found",
    };
  }

  console.log("[stream] Best stream:", bestStream.quality, bestStream.type);
  console.log("[stream] Raw URL:", bestStream.url.slice(0, 120));

  // ── Step 5: Proxify ──────────────────────────────────────────
  const referer      = detectReferer(bestStream.url);
  const proxifiedUrl = await proxifyStream(bestStream.url, referer);

  // ── Build subtitle list ───────────────────────────────────────
  const subtitles: SubtitleTrack[] = (watchData.subtitles ?? [])
    .filter((s) => s.file && s.label)
    .map((s) => ({
      url:   s.file,
      lang:  s.label.toLowerCase().slice(0, 2),
      label: s.label,
    }));

  const sourceLabel =
    `Miruro · ${provider} · ${bestStream.quality} · ${resolvedLang}`;

  // ── Return proxified URL, or fallback to own proxy ───────────
  if (proxifiedUrl) {
    console.log("[stream] ✓ Delivering proxified URL");
    return {
      url:       proxifiedUrl,
      subtitles,
      intro:     watchData.intro ?? null,
      outro:     watchData.outro ?? null,
      source:    sourceLabel,
      referer,
      headers:   {},
    };
  }

  // Last resort: route through our own proxy endpoint
  console.warn("[stream] Proxify failed — falling back to /api/proxy");
  return {
    url: `/api/proxy?url=${encodeURIComponent(bestStream.url)}&referer=${encodeURIComponent(referer)}`,
    subtitles,
    intro:   watchData.intro ?? null,
    outro:   watchData.outro ?? null,
    source:  `${sourceLabel} (self-proxied)`,
    referer,
    headers: {},
  };
}

// ── Vercel Handler ────────────────────────────────────────────
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  // ── Parse params ────────────────────────────────────────────
  const { malId, episode, lang } = req.query;

  if (!malId || typeof malId !== "string")
    return res.status(400).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "malId is required",
    });

  const malIdNum = parseInt(malId);
  if (isNaN(malIdNum) || malIdNum <= 0)
    return res.status(400).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "malId must be a positive integer",
    });

  const epNum   = Math.max(1, parseInt(String(episode || "1")) || 1);
  const audio   = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";

  console.log(`\n══════════════════════════════════════`);
  console.log(`[stream] MAL:${malIdNum} · E${epNum} · [${audio}]`);
  console.log(`══════════════════════════════════════`);

  // ── MAL → AniList ───────────────────────────────────────────
  const anilistId = malToAnilist.get(malIdNum) ?? null;

  if (!anilistId) {
    console.warn(`[stream] MAL ${malIdNum} not in mapper`);
    return res.status(200).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null,
      error: `MAL ID ${malIdNum} not found in our database.`,
    });
  }

  console.log(`[stream] AniList ID: ${anilistId}`);

  // ── Resolve ─────────────────────────────────────────────────
  try {
    const result = await resolveStream(anilistId, epNum, audio);

    if (result.url) {
      console.log(`[stream] ✓ Done — source: ${result.source}`);
    } else {
      console.warn(`[stream] ✗ No stream — ${result.error}`);
    }

    // Always 200 — errors are in the payload
    return res.status(200).json(result);

  } catch (err: any) {
    // This should never happen now — but just in case
    console.error("[stream] Unhandled error:", err.message, err.stack);
    return res.status(200).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null,
      error: `Server error: ${err.message}`,
    });
  }
}
