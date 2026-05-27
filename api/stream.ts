// api/stream.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
// Import the mapper JSON directly
import animeSeasons from "../src/data/anime-seasons.json";

interface AnimeMapping {
  mal_id:      number;
  anilist_id:  number;
  type?:       string;
  season?:     { tvdb?: number; tmdb?: number };
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

interface ProxifyResponse {
  proxifiedSource: {
    miruro?:     string;
    anikuro?:    string;
    lunaranime?: string;
    animanga?:   string;
  };
}

// ── Config ────────────────────────────────────────────────────
const MIRURO_API     = "https://api-test-blush-one.vercel.app";
const PROXIFY_API    = "https://web-production-3a1a9.up.railway.app";
const PROVIDER_ORDER = ["kiwi", "arc", "zoro", "jet"];
const TIMEOUT_MS     = 25_000;

// ── Build a MAL→AniList lookup map at startup ─────────────────
// This runs once when the function cold-starts — very fast
const malToAnilist = new Map<number, number>();
for (const entry of animeSeasons as AnimeMapping[]) {
  if (entry.mal_id && entry.anilist_id) {
    malToAnilist.set(entry.mal_id, entry.anilist_id);
  }
}
console.log(`[stream] Mapper loaded: ${malToAnilist.size} entries`);

// ── Convert MAL ID → AniList ID ───────────────────────────────
function malIdToAnilistId(malId: number): number | null {
  const anilistId = malToAnilist.get(malId);
  if (anilistId) {
    console.log(`[stream] Mapper: MAL ${malId} → AniList ${anilistId}`);
    return anilistId;
  }
  console.warn(`[stream] Mapper: no entry for MAL ${malId}`);
  return null;
}

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

// ── Call Proxify API ──────────────────────────────────────────
async function getProxifiedUrl(
  streamUrl: string,
  referer:   string
): Promise<string | null> {
  try {
    const data     = `${streamUrl}|${referer}`;
    const endpoint = `${PROXIFY_API}/proxy?data=${encodeURIComponent(data)}`;

    console.log("[proxify] Calling:", endpoint.slice(0, 120));

    const res = await withTimeout(
      fetch(endpoint, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SamuraiAnime/1.0)",
          "Accept":     "application/json",
        },
      }),
      15_000
    );

    if (!res.ok) {
      console.warn("[proxify] HTTP error:", res.status);
      return null;
    }

    const json = await res.json() as ProxifyResponse;
    const src  = json?.proxifiedSource;
    if (!src) return null;

    // lunaranime = simplest encoding, most compatible
    // miruro     = XOR encrypted, very reliable
    // anikuro    = base64
    // animanga   = JSON headers
    const picked =
      src.lunaranime ||
      src.miruro     ||
      src.anikuro    ||
      src.animanga   ||
      null;

    if (picked) {
      console.log("[proxify] ✓ URL:", picked.slice(0, 100));
    } else {
      console.warn("[proxify] All providers empty");
    }
    return picked;
  } catch (err: any) {
    console.error("[proxify] Failed:", err.message);
    return null;
  }
}

// ── Main stream resolver ──────────────────────────────────────
async function resolveStream(
  anilistId: number,
  episode:   number,
  lang:      "sub" | "dub"
): Promise<StreamResponse | null> {

  // Step 1: Get episodes from Miruro
  let episodesData: MiruroEpisodesResponse;
  try {
    episodesData = await fetchJson<MiruroEpisodesResponse>(
      `${MIRURO_API}/episodes/${anilistId}`,
      "episodes"
    );
  } catch (err: any) {
    console.error("[stream] Episodes failed:", err.message);
    return null;
  }

  if (!episodesData?.providers) {
    console.log("[stream] No providers in response");
    return null;
  }

  const allProviders = Object.keys(episodesData.providers);
  console.log("[stream] Providers:", allProviders.join(", "));

  // Step 2: Find episode ID
  let episodeId: string | null = null;
  let provider:  string | null = null;
  let usedLang   = lang;

  const orderedProviders = [
    ...PROVIDER_ORDER,
    ...allProviders.filter((p) => !PROVIDER_ORDER.includes(p)),
  ];

  for (const prov of orderedProviders) {
    const provData = episodesData.providers[prov];
    if (!provData?.episodes) continue;

    const langsToTry: ("sub" | "dub")[] =
      lang === "sub" ? ["sub", "dub"] : ["dub", "sub"];

    for (const tryLang of langsToTry) {
      const eps = provData.episodes[tryLang];
      if (!Array.isArray(eps) || !eps.length) continue;

      const ep = eps.find((e) => e.number === episode);
      if (ep?.id) {
        episodeId = ep.id;
        provider  = prov;
        usedLang  = tryLang;
        console.log(`[stream] ✓ E${episode} in "${prov}"[${tryLang}]: ${ep.id}`);
        break;
      }
    }
    if (episodeId) break;
  }

  if (!episodeId || !provider) {
    for (const prov of allProviders.slice(0, 3)) {
      const sub = episodesData.providers[prov]?.episodes?.sub;
      console.log(
        `[stream] "${prov}" has ${sub?.length ?? 0} sub eps:`,
        sub?.slice(0, 5).map((e) => e.number).join(", ") ?? "none"
      );
    }
    console.log(`[stream] E${episode} not found in any provider`);
    return null;
  }

  // Step 3: Get watch data
  // episodeId = "watch/kiwi/178005/sub/animepahe-1"
  const watchUrl = `${MIRURO_API}/${episodeId}`;
  console.log("[stream] Watch URL:", watchUrl);

  let watchData: MiruroWatchResponse;
  try {
    watchData = await fetchJson<MiruroWatchResponse>(watchUrl, "watch");
  } catch (err: any) {
    console.error("[stream] Watch failed:", err.message);
    return null;
  }

  if (!watchData?.streams?.length) {
    console.log("[stream] No streams:", JSON.stringify(watchData).slice(0, 200));
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
    console.log("[stream] No usable stream URL");
    return null;
  }

  console.log("[stream] Raw URL:", stream.url.slice(0, 100));

  // Determine correct referer for this CDN
  let referer = "https://kwik.cx/";
  try {
    const hostname = new URL(stream.url).hostname;
    console.log("[stream] CDN:", hostname);
    if (hostname.includes("rapid-cloud") || hostname.includes("megacloud")) {
      referer = "https://zoro.to/";
    } else if (hostname.includes("gogocdn") || hostname.includes("gogoanime")) {
      referer = "https://gogoanime.tel/";
    }
  } catch {}

  // Step 4: Proxify the stream URL
  const proxifiedUrl = await getProxifiedUrl(stream.url, referer);

  const subtitles: SubtitleTrack[] = (watchData.subtitles ?? [])
    .filter((s) => s.file && s.label)
    .map((s) => ({
      url:   s.file,
      lang:  s.label.toLowerCase().slice(0, 2),
      label: s.label,
    }));

  if (proxifiedUrl) {
    return {
      url:       proxifiedUrl,
      subtitles,
      intro:     watchData.intro  ?? null,
      outro:     watchData.outro  ?? null,
      source:    `Miruro · ${provider} · ${stream.quality} · ${usedLang}`,
      referer,
      headers:   {},
    };
  }

  // Fallback: our own proxy
  console.warn("[stream] Proxify failed — using own proxy");
  return {
    url: `/api/proxy?url=${encodeURIComponent(stream.url)}&referer=${encodeURIComponent(referer)}`,
    subtitles,
    intro:   watchData.intro  ?? null,
    outro:   watchData.outro  ?? null,
    source:  `Miruro · ${provider} · ${stream.quality} · ${usedLang} (fallback)`,
    referer,
    headers: {},
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

  const { episode, lang, malId } = req.query;

  if (!malId || typeof malId !== "string")
    return res.status(400).json({ error: "malId is required" });

  const malIdNum = parseInt(malId);
  if (isNaN(malIdNum))
    return res.status(400).json({ error: "malId must be a number" });

  const ep    = Math.max(1, parseInt(String(episode || "1")) || 1);
  const audio = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";

  console.log(`\n══ [stream] MAL:${malIdNum} E${ep} [${audio}] ══`);

  try {
    // Use local mapper — no external API call needed
    const anilistId = malIdToAnilistId(malIdNum);

    if (!anilistId) {
      return res.status(200).json({
        url: null, subtitles: [], intro: null, outro: null,
        source: null,
        error: `MAL ID ${malIdNum} not found in mapper. The anime may not be in our database.`,
      });
    }

    console.log(`[stream] AniList ID: ${anilistId}`);

    const result = await resolveStream(anilistId, ep, audio);

    if (result?.url) {
      console.log("[stream] ✓", result.source);
      return res.status(200).json(result);
    }

    return res.status(200).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "No stream found for this episode",
    });

  } catch (err: any) {
    console.error("[stream] Error:", err.message);
    return res.status(500).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "Internal server error",
    });
  }
}
