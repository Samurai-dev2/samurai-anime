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
  title: { romaji: string; english: string | null; native: string };
  idMal: number | null;
}

interface MiruroSearchResponse {
  results: MiruroSearchResult[];
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
const MIRURO_API   = "https://api-test-blush-one.vercel.app";
const PROVIDER_ORDER = ["kiwi", "arc", "zoro", "jet"];
const TIMEOUT_MS   = 25_000;

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

// ── Get proxified URL from Proxify API ────────────────────────
// This replaces our entire proxy.ts logic for M3U8 streams
async function proxifyUrl(
  streamUrl: string,
  referer:   string,
  proxifyBase: string
): Promise<string | null> {
  try {
    // Format: /proxy?data={url}|{referer}
    const data      = `${streamUrl}|${referer}`;
    const proxyUrl  = `${proxifyBase}/proxy?data=${encodeURIComponent(data)}`;

    console.log("[proxify] Requesting:", proxyUrl.slice(0, 120));

    const res = await withTimeout(
      fetch(proxyUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SamuraiAnime/1.0)",
          "Accept":     "application/json",
        },
      }),
      15_000
    );

    if (!res.ok) {
      console.warn("[proxify] API returned:", res.status);
      return null;
    }

    const data2 = await res.json() as ProxifyResponse;

    console.log(
      "[proxify] Response:",
      JSON.stringify(data2?.proxifiedSource ?? {})
    );

    // Try providers in order — use first working URL
    const source = data2?.proxifiedSource;
    if (!source) return null;

    // Miruro proxy is most reliable for AnimePahe streams
    const url =
      source.miruro     ||
      source.anikuro    ||
      source.lunaranime ||
      source.animanga   ||
      null;

    if (url) {
      console.log("[proxify] ✓ Got proxified URL:", url.slice(0, 80));
    } else {
      console.warn("[proxify] No valid URL in response");
    }

    return url;
  } catch (err: any) {
    console.error("[proxify] Failed:", err.message);
    return null;
  }
}

// ── MAL ID → AniList ID ───────────────────────────────────────
async function resolveAnilistId(
  malId: number,
  title?: string
): Promise<number | null> {
  console.log(`[stream] Resolving AniList ID for MAL ${malId}`);

  // Method 1: AniList GraphQL
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

    if (res.ok) {
      const data = await res.json();
      const id   = data?.data?.Media?.id;
      if (id) {
        const t = data?.data?.Media?.title?.english ?? data?.data?.Media?.title?.romaji;
        console.log(`[stream] GraphQL: MAL ${malId} → AniList ${id} "${t}"`);
        return id;
      }
      if (data?.errors) {
        console.warn("[stream] GraphQL errors:", JSON.stringify(data.errors));
      }
    } else {
      console.warn("[stream] GraphQL HTTP:", res.status);
    }
  } catch (err: any) {
    console.warn("[stream] GraphQL failed:", err.message);
  }

  // Method 2: Miruro search by title
  if (title) {
    try {
      const url  = `${MIRURO_API}/search?query=${encodeURIComponent(title)}&per_page=10`;
      const data = await fetchJson<MiruroSearchResponse>(url, "search");

      if (data?.results?.length) {
        console.log(
          "[stream] Search results:",
          data.results.slice(0, 3).map((r) =>
            `"${r.title.english ?? r.title.romaji}"(AL:${r.id} MAL:${r.idMal})`
          ).join(" | ")
        );

        // Prefer exact MAL ID match
        const byMal = data.results.find((r) => r.idMal === malId);
        if (byMal) {
          console.log(`[stream] Search: MAL ${malId} → AniList ${byMal.id}`);
          return byMal.id;
        }

        // Fall back to first result
        console.log(`[stream] Search fallback → AniList ${data.results[0].id}`);
        return data.results[0].id;
      }
    } catch (err: any) {
      console.warn("[stream] Search fallback failed:", err.message);
    }
  }

  console.error(`[stream] Could not resolve AniList ID for MAL ${malId}`);
  return null;
}

// ── Main streaming function ───────────────────────────────────
async function streamFromMiruro(
  anilistId:   number,
  episode:     number,
  lang:        "sub" | "dub",
  proxifyBase: string
): Promise<StreamResponse | null> {

  // Step 1: Get episodes
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
    console.log("[stream] No providers:", JSON.stringify(episodesData).slice(0, 200));
    return null;
  }

  const availableProviders = Object.keys(episodesData.providers);
  console.log("[stream] Providers:", availableProviders.join(", "));

  // Step 2: Find episode ID
  let episodeId: string | null = null;
  let provider:  string | null = null;
  let usedLang   = lang;

  // Try preferred providers first
  for (const prov of [...PROVIDER_ORDER, ...availableProviders]) {
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
        console.log(`[stream] E${episode} in "${prov}" [${tryLang}]: ${ep.id}`);
        break;
      }
    }
    if (episodeId) break;
  }

  if (!episodeId || !provider) {
    // Log available episodes for debugging
    for (const prov of availableProviders.slice(0, 2)) {
      const sub = episodesData.providers[prov]?.episodes?.sub;
      if (sub?.length) {
        console.log(
          `"${prov}" episodes:`,
          sub.slice(0, 10).map((e) => e.number).join(", ")
        );
      }
    }
    console.log(`[stream] E${episode} not found`);
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
    console.log("[stream] No valid stream URL");
    return null;
  }

  console.log("[stream] Raw stream URL:", stream.url.slice(0, 100));

  // Determine referer for this CDN
  let referer = "https://kwik.cx/";
  try {
    const h = new URL(stream.url).hostname;
    if (h.includes("rapid-cloud") || h.includes("megacloud")) {
      referer = "https://zoro.to/";
    } else if (h.includes("gogocdn")) {
      referer = "https://gogoanime.tel/";
    }
  } catch {}

  // Step 4: Get proxified URL from Proxify API
  const proxifiedUrl = await proxifyUrl(stream.url, referer, proxifyBase);

  if (!proxifiedUrl) {
    console.warn("[stream] Proxify failed — falling back to our own proxy");
    // Fall back to our own proxy
    const fallbackUrl =
      `/api/proxy` +
      `?url=${encodeURIComponent(stream.url)}` +
      `&referer=${encodeURIComponent(referer)}`;

    return {
      url:       fallbackUrl,
      subtitles: buildSubtitles(watchData),
      intro:     watchData.intro ?? null,
      outro:     watchData.outro ?? null,
      source:    `Miruro · ${provider} · ${stream.quality} · ${usedLang} (own proxy)`,
      referer,
      headers:   {},
    };
  }

  return {
    url:       proxifiedUrl,  // ← Direct URL, no proxy needed
    subtitles: buildSubtitles(watchData),
    intro:     watchData.intro ?? null,
    outro:     watchData.outro ?? null,
    source:    `Miruro · ${provider} · ${stream.quality} · ${usedLang}`,
    referer,
    headers:   {},
  };
}

function buildSubtitles(watchData: MiruroWatchResponse): SubtitleTrack[] {
  return (watchData.subtitles ?? [])
    .filter((s) => s.file && s.label)
    .map((s) => ({
      url:   s.file,
      lang:  s.label.toLowerCase().slice(0, 2),
      label: s.label,
    }));
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

  const ep       = Math.max(1, parseInt(String(episode || "1")) || 1);
  const audio    = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";
  const titleStr = typeof title === "string" ? title : undefined;

  // Get the Proxify API base URL from environment variable
  // Set PROXIFY_API_URL in your Vercel environment variables
  // pointing to wherever you deployed the Proxify Flask app
  const proxifyBase =
    process.env.PROXIFY_API_URL ||
    "https://your-proxify-deployment.vercel.app"; // ← replace this

  console.log(`\n══ [stream] MAL:${malIdNum} "${titleStr}" E${ep} [${audio}] ══`);
  console.log(`[stream] Using Proxify: ${proxifyBase}`);

  try {
    const anilistId = await resolveAnilistId(malIdNum, titleStr);

    if (!anilistId) {
      return res.status(200).json({
        url: null, subtitles: [], intro: null, outro: null,
        source: null,
        error: `Could not find AniList ID for MAL ID ${malIdNum}`,
      });
    }

    console.log(`[stream] AniList ID: ${anilistId}`);

    const result = await streamFromMiruro(anilistId, ep, audio, proxifyBase);

    if (result?.url) {
      console.log("[stream] ✓", result.source);
      return res.status(200).json(result);
    }

    return res.status(200).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "No stream found",
    });

  } catch (err: any) {
    console.error("[stream] Error:", err.message);
    return res.status(500).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "Internal server error",
    });
  }
}
