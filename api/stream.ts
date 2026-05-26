// api/stream.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

interface StreamResponse {
  url:         string | null;
  subtitles:   SubtitleTrack[];
  intro:       { start: number; end: number } | null;
  outro:       { start: number; end: number } | null;
  source:      string | null;
  referer?:    string;
  headers?:    Record<string, string>;
  error?:      string;
}

interface SubtitleTrack {
  url:   string;
  lang:  string;
  label: string;
}

// ─── Miruro API types ─────────────────────────────────────────

interface MiruroEpisode {
  id:          string;
  number:      number;
  title:       string;
  image?:      string;
  airDate?:    string;
  duration?:   number;
  description?: string;
  filler?:     boolean;
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

// ─── Config ───────────────────────────────────────────────────

const MIRURO_API = "https://miruro-native-api.vercel.app";

// Providers in preference order
// kiwi = AnimePahe (best quality, no ads)
// arc  = backup
// zoro = has subtitles
const PROVIDER_ORDER = ["kiwi", "arc", "zoro", "jet"];

const TIMEOUT_MS = 25_000;

// ─── Helpers ──────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function fetchJson<T>(url: string, label = ""): Promise<T> {
  console.log(`[miruro${label ? " " + label : ""}]`, url.slice(0, 120));

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
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
  }

  return res.json() as Promise<T>;
}

// ─── Convert MAL ID → AniList ID ─────────────────────────────
// Miruro uses AniList IDs. We get MAL IDs from Jikan.
// Use the AniList GraphQL API to convert.
async function malIdToAnilistId(malId: number): Promise<number | null> {
  try {
    const query = `
      query ($malId: Int) {
        Media(idMal: $malId, type: ANIME) {
          id
        }
      }
    `;

    const res = await withTimeout(
      fetch("https://graphql.anilist.co", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body:    JSON.stringify({ query, variables: { malId } }),
      }),
      10_000
    );

    if (!res.ok) return null;

    const data = await res.json();
    const id   = data?.data?.Media?.id;
    if (id) {
      console.log(`[miruro] MAL ${malId} → AniList ${id}`);
      return id;
    }
    return null;
  } catch (err: any) {
    console.warn("[miruro] MAL→AniList conversion failed:", err.message);
    return null;
  }
}

// ─── Main streaming function ──────────────────────────────────

async function streamFromMiruro(
  anilistId: number,
  episode:   number,
  lang:      "sub" | "dub"
): Promise<StreamResponse | null> {

  // ── Step 1: Get episodes ────────────────────────────────────
  let episodesData: MiruroEpisodesResponse;
  try {
    episodesData = await fetchJson<MiruroEpisodesResponse>(
      `${MIRURO_API}/episodes/${anilistId}`,
      "episodes"
    );
  } catch (err: any) {
    console.error("[miruro] Episodes fetch failed:", err.message);
    return null;
  }

  if (!episodesData?.providers) {
    console.log("[miruro] No providers in response");
    return null;
  }

  console.log(
    "[miruro] Available providers:",
    Object.keys(episodesData.providers).join(", ")
  );

  // ── Step 2: Find the episode across providers ───────────────
  // Try providers in preference order
  let episodeId: string | null   = null;
  let provider:  string | null   = null;
  let foundEp:   MiruroEpisode | null = null;

  for (const prov of PROVIDER_ORDER) {
    const provData = episodesData.providers[prov];
    if (!provData?.episodes) continue;

    // Try requested lang first, then fall back to the other
    const langsToTry = lang === "sub"
      ? ["sub", "dub"]
      : ["dub", "sub"];

    for (const tryLang of langsToTry) {
      const eps = provData.episodes[tryLang as "sub" | "dub"];
      if (!Array.isArray(eps) || !eps.length) continue;

      const ep = eps.find((e) => e.number === episode);
      if (ep?.id) {
        episodeId = ep.id;
        provider  = prov;
        foundEp   = ep;
        console.log(
          `[miruro] Found E${episode} in provider "${prov}" lang "${tryLang}":`,
          ep.id
        );
        break;
      }
    }

    if (episodeId) break;
  }

  if (!episodeId || !provider) {
    console.log(
      `[miruro] Episode ${episode} not found in any provider.`,
      "Available providers:",
      Object.keys(episodesData.providers).join(", ")
    );
    return null;
  }

  // ── Step 3: Get streams ─────────────────────────────────────
  // The episode ID is already the path: "watch/kiwi/178005/sub/animepahe-1"
  // So just prepend the base URL
  let watchData: MiruroWatchResponse;
  try {
    const watchUrl = `${MIRURO_API}/${episodeId}`;
    watchData = await fetchJson<MiruroWatchResponse>(watchUrl, "watch");
  } catch (err: any) {
    console.error("[miruro] Watch fetch failed:", err.message);
    return null;
  }

  if (!watchData?.streams?.length) {
    console.log("[miruro] No streams returned");
    return null;
  }

  console.log(
    "[miruro] Streams:",
    watchData.streams.map((s) => `${s.quality}(${s.type})`).join(", ")
  );

  // Pick the best HLS stream
  const hlsStreams = watchData.streams.filter((s) => s.type === "hls");
  const stream     = hlsStreams[0] ?? watchData.streams[0];

  if (!stream?.url) {
    console.log("[miruro] No valid stream URL");
    return null;
  }

  console.log("[miruro] ✓ Stream:", stream.url.slice(0, 80));

  // ── Build response ──────────────────────────────────────────
  const subtitles: SubtitleTrack[] = (watchData.subtitles ?? [])
    .filter((s) => s.file && s.label)
    .map((s) => ({
      url:   s.file,
      lang:  s.label.toLowerCase().slice(0, 2),
      label: s.label,
    }));

  // Route the stream through our proxy
  const proxyUrl =
    `/api/proxy` +
    `?url=${encodeURIComponent(stream.url)}` +
    `&referer=${encodeURIComponent("https://kwik.cx/")}`;

  return {
    url:       proxyUrl,
    subtitles,
    intro:     watchData.intro ?? null,
    outro:     watchData.outro ?? null,
    source:    `Miruro · ${provider} · ${stream.quality}`,
    referer:   "https://kwik.cx/",
    headers:   {},
  };
}

// ─── Handler ──────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const { title, episode, lang, season, malId } = req.query;

  if (!malId || typeof malId !== "string") {
    return res.status(400).json({ error: "malId is required" });
  }

  const malIdNum  = parseInt(malId);
  const ep        = Math.max(1, parseInt(String(episode || "1")) || 1);
  const audio     = lang === "dub" ? "dub" : "sub" as "sub" | "dub";

  console.log(`\n══ [stream] malId=${malIdNum} E${ep} [${audio}] ══`);

  try {
    // Convert MAL ID to AniList ID
    const anilistId = await malIdToAnilistId(malIdNum);

    if (!anilistId) {
      console.log("[stream] Could not convert MAL ID to AniList ID:", malIdNum);
      return res.status(200).json({
        url:       null,
        subtitles: [],
        intro:     null,
        outro:     null,
        source:    null,
        error:     "Could not find anime on AniList",
      });
    }

    console.log(`[stream] AniList ID: ${anilistId}`);

    const result = await streamFromMiruro(anilistId, ep, audio);

    if (result?.url) {
      console.log("[stream] ✓", result.source);
      return res.status(200).json(result);
    }

    return res.status(200).json({
      url:       null,
      subtitles: [],
      intro:     null,
      outro:     null,
      source:    null,
      error:     "No stream found",
    });

  } catch (err: any) {
    console.error("[stream] Error:", err.message);
    return res.status(500).json({
      url:       null,
      subtitles: [],
      intro:     null,
      outro:     null,
      source:    null,
      error:     "Internal server error",
    });
  }
}
