// api/stream.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── Types ────────────────────────────────────────────────────
interface StreamResponse {
  url:       string | null;
  subtitles: SubtitleTrack[];
  intro:     TimeMark | null;
  outro:     TimeMark | null;
  source:    string | null;
  error?:    string;
}

interface SubtitleTrack {
  url:   string;
  lang:  string;
  label: string;
}

interface TimeMark {
  start: number;
  end:   number;
}

// Stremio stream object shape
interface StremioStream {
  url?:         string;
  title?:       string;
  name?:        string;
  description?: string;
  subtitles?:   Array<{ url: string; lang: string; }>;
  behaviorHints?: {
    subtitleTracks?: Array<{ url: string; lang: string; id?: string; }>;
    notWebReady?:    boolean;
  };
}

// ─── Constants ────────────────────────────────────────────────
const CONSUMET_STREMIO_BASE =
  process.env.CONSUMET_STREMIO_URL || "https://stremio.consumet.org";

const ANIME_KITSU_BASE =
  process.env.ANIME_KITSU_URL || "https://anime-kitsu.strem.fun";

const ANIWAVE_BASE =
  process.env.ANIWAVE_URL || "https://aniwave.strem.fun";

const REQUEST_TIMEOUT = 12_000; // 12 seconds

// ─── Helpers ──────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await withTimeout(
    fetch(url, {
      headers: {
        "User-Agent": "SamuraiAnime/1.0",
        "Accept":     "application/json",
      },
    }),
    REQUEST_TIMEOUT,
  );

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

// Normalize title for Stremio search
function slugify(title: string): string {
  return encodeURIComponent(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Pick best stream — prefer 1080p, then 720p, avoid torrents
function pickBestStream(streams: StremioStream[]): StremioStream | null {
  if (!streams?.length) return null;

  const httpStreams = streams.filter(
    (s) => s.url && (s.url.startsWith("http://") || s.url.startsWith("https://"))
  );

  if (!httpStreams.length) return null;

  const priority = ["1080", "720", "480", "360"];

  for (const res of priority) {
    const match = httpStreams.find(
      (s) =>
        s.title?.includes(res) ||
        s.name?.includes(res)   ||
        s.description?.includes(res)
    );
    if (match) return match;
  }

  return httpStreams[0];
}

function extractSubtitles(stream: StremioStream): SubtitleTrack[] {
  const raw =
    stream.behaviorHints?.subtitleTracks ||
    stream.subtitles ||
    [];

  return raw.map((s, i) => ({
    url:   s.url,
    lang:  s.lang || "und",
    label: s.lang || `Track ${i + 1}`,
  }));
}

// ─── Provider 1: Consumet Stremio Addon ───────────────────────
// Endpoint: /stream/anime/series/{kitsuId}:{season}:{episode}.json
// We search Consumet's catalog first to get the kitsu ID
async function tryConsometStremio(
  title:   string,
  episode: number,
  lang:    "sub" | "dub",
): Promise<StreamResponse | null> {
  try {
    // Step 1: Search catalog to find the Kitsu ID
    const searchUrl = `${CONSUMET_STREMIO_BASE}/catalog/anime/gogoanime-${
      lang === "dub" ? "dub" : "sub"
    }/search=${slugify(title)}.json`;

    console.log("[Consumet] Searching:", searchUrl);

    const catalog = await fetchJson<{ metas?: Array<{ id: string; name: string; }> }>(
      searchUrl
    );

    const meta = catalog.metas?.[0];
    if (!meta?.id) {
      console.log("[Consumet] No catalog results");
      return null;
    }

    console.log("[Consumet] Found meta:", meta.id, meta.name);

    // Step 2: Fetch streams for that ID
    // ID format for Gogoanime: "kitsu:12345" or "gogoanime:title-episode-X"
    const streamUrl = `${CONSUMET_STREMIO_BASE}/stream/anime/series/${
      encodeURIComponent(meta.id)
    }:1:${episode}.json`;

    console.log("[Consumet] Fetching streams:", streamUrl);

    const data = await fetchJson<{ streams?: StremioStream[] }>(streamUrl);
    const stream = pickBestStream(data.streams ?? []);

    if (!stream?.url) return null;

    console.log("[Consumet] ✓ Got stream:", stream.url.slice(0, 60));

    return {
      url:       stream.url,
      subtitles: extractSubtitles(stream),
      intro:     null,
      outro:     null,
      source:    "Consumet (Gogoanime)",
    };
  } catch (err: any) {
    console.warn("[Consumet] Failed:", err.message);
    return null;
  }
}

// ─── Provider 2: Anime Kitsu Stremio Addon ────────────────────
// Uses Kitsu IDs — more reliable for non-dubbed content
async function tryAnimeKitsu(
  title:   string,
  episode: number,
  malId?:  number,
): Promise<StreamResponse | null> {
  try {
    // Search by title in the Kitsu catalog
    const searchUrl = `${ANIME_KITSU_BASE}/catalog/anime/kitsu-anime-list/search=${slugify(title)}.json`;

    console.log("[Kitsu] Searching:", searchUrl);

    const catalog = await fetchJson<{
      metas?: Array<{ id: string; name: string; }>;
    }>(searchUrl);

    const meta = catalog.metas?.[0];
    if (!meta?.id) {
      console.log("[Kitsu] No results");
      return null;
    }

    console.log("[Kitsu] Found:", meta.id, meta.name);

    // Kitsu stream format
    const streamUrl = `${ANIME_KITSU_BASE}/stream/anime/series/${
      encodeURIComponent(meta.id)
    }:1:${episode}.json`;

    const data = await fetchJson<{ streams?: StremioStream[] }>(streamUrl);
    const stream = pickBestStream(data.streams ?? []);

    if (!stream?.url) return null;

    console.log("[Kitsu] ✓ Got stream");

    return {
      url:       stream.url,
      subtitles: extractSubtitles(stream),
      intro:     null,
      outro:     null,
      source:    "Anime Kitsu",
    };
  } catch (err: any) {
    console.warn("[Kitsu] Failed:", err.message);
    return null;
  }
}

// ─── Provider 3: Direct Consumet API ──────────────────────────
// Fallback: hit consumet.org REST API directly (not stremio addon)
const CONSUMET_API =
  process.env.CONSUMET_API_URL || "https://api.consumet.org";

async function tryConsometDirect(
  title:   string,
  episode: number,
  lang:    "sub" | "dub",
): Promise<StreamResponse | null> {
  try {
    // Search anime
    const searchUrl = `${CONSUMET_API}/anime/gogoanime/${encodeURIComponent(title)}`;
    console.log("[Consumet-Direct] Searching:", searchUrl);

    const search = await fetchJson<{
      results?: Array<{
        id:    string;
        title: string;
        url:   string;
        subOrDub?: string;
      }>;
    }>(searchUrl);

    if (!search.results?.length) return null;

    // Find sub or dub version
    const result =
      search.results.find(
        (r) =>
          r.subOrDub === lang &&
          r.title.toLowerCase().includes(title.toLowerCase().slice(0, 10))
      ) || search.results[0];

    console.log("[Consumet-Direct] Using:", result.id);

    // Fetch episode list
    const infoUrl = `${CONSUMET_API}/anime/gogoanime/info/${encodeURIComponent(result.id)}`;
    const info    = await fetchJson<{
      episodes?: Array<{ id: string; number: number; }>;
    }>(infoUrl);

    const ep = info.episodes?.find((e) => e.number === episode);
    if (!ep) {
      console.log("[Consumet-Direct] Episode not found");
      return null;
    }

    // Fetch stream sources
    const sourceUrl = `${CONSUMET_API}/anime/gogoanime/watch/${encodeURIComponent(ep.id)}?server=vidstreaming`;
    console.log("[Consumet-Direct] Fetching sources:", sourceUrl);

    const sources = await fetchJson<{
      sources?:   Array<{ url: string; quality: string; isM3U8: boolean; }>;
      subtitles?: Array<{ url: string; lang: string; }>;
      intro?:     { start: number; end: number; };
      outro?:     { start: number; end: number; };
    }>(sourceUrl);

    if (!sources.sources?.length) return null;

    // Pick best quality
    const ordered = [...(sources.sources)].sort((a, b) => {
      const order = ["1080p", "720p", "480p", "360p", "default", "backup"];
      return order.indexOf(a.quality) - order.indexOf(b.quality);
    });

    const best = ordered[0];
    console.log("[Consumet-Direct] ✓ Got stream:", best.quality);

    return {
      url:       best.url,
      subtitles: (sources.subtitles ?? []).map((s, i) => ({
        url:   s.url,
        lang:  s.lang,
        label: s.lang || `Track ${i + 1}`,
      })),
      intro:  sources.intro  ?? null,
      outro:  sources.outro  ?? null,
      source: `Consumet Direct (${best.quality})`,
    };
  } catch (err: any) {
    console.warn("[Consumet-Direct] Failed:", err.message);
    return null;
  }
}

// ─── Provider 4: Zoro / Aniwatch via Consumet ─────────────────
async function tryZoro(
  title:   string,
  episode: number,
): Promise<StreamResponse | null> {
  try {
    const searchUrl = `${CONSUMET_API}/anime/zoro/${encodeURIComponent(title)}`;
    console.log("[Zoro] Searching:", searchUrl);

    const search = await fetchJson<{
      results?: Array<{ id: string; title: string; }>;
    }>(searchUrl);

    if (!search.results?.length) return null;

    const result = search.results[0];
    const infoUrl = `${CONSUMET_API}/anime/zoro/info?id=${encodeURIComponent(result.id)}`;

    const info = await fetchJson<{
      episodes?: Array<{ id: string; number: number; episodeId?: string; }>;
    }>(infoUrl);

    const ep = info.episodes?.find((e) => e.number === episode);
    if (!ep) return null;

    const epId = ep.episodeId ?? ep.id;
    const srcUrl = `${CONSUMET_API}/anime/zoro/watch?episodeId=${encodeURIComponent(epId)}`;
    console.log("[Zoro] Fetching:", srcUrl);

    const sources = await fetchJson<{
      sources?:   Array<{ url: string; quality: string; isM3U8: boolean; }>;
      subtitles?: Array<{ url: string; lang: string; }>;
      intro?:     { start: number; end: number; };
      outro?:     { start: number; end: number; };
    }>(srcUrl);

    if (!sources.sources?.length) return null;

    // Prefer HLS streams
    const hlsSources = sources.sources.filter((s) => s.isM3U8);
    const best       = hlsSources[0] ?? sources.sources[0];

    console.log("[Zoro] ✓ Got stream");

    return {
      url:       best.url,
      subtitles: (sources.subtitles ?? []).map((s, i) => ({
        url:   s.url,
        lang:  s.lang,
        label: s.lang || `Track ${i + 1}`,
      })),
      intro:  sources.intro ?? null,
      outro:  sources.outro ?? null,
      source: "Zoro/Aniwatch",
    };
  } catch (err: any) {
    console.warn("[Zoro] Failed:", err.message);
    return null;
  }
}

// ─── Main Handler ─────────────────────────────────────────────
export default async function handler(
  req:  VercelRequest,
  res:  VercelResponse,
) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method not allowed" });

  const { title, episode, lang, malId } = req.query;

  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }

  const ep    = parseInt(String(episode || "1")) || 1;
  const audio = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";
  const mid   = malId ? parseInt(String(malId)) : undefined;

  console.log(`\n[stream] title="${title}" ep=${ep} lang=${audio} malId=${mid}`);

  // Try each provider in sequence — stop on first success
  const providers = [
    () => tryConsometDirect(title, ep, audio),
    () => tryZoro(title, ep),
    () => tryConsometStremio(title, ep, audio),
    () => tryAnimeKitsu(title, ep, mid),
  ];

  for (const provider of providers) {
    const result = await provider();
    if (result?.url) {
      console.log(`[stream] ✓ Success from: ${result.source}`);
      return res.status(200).json(result);
    }
  }

  console.log("[stream] ✗ All providers failed");
  return res.status(200).json({
    url:       null,
    subtitles: [],
    intro:     null,
    outro:     null,
    source:    null,
    error:     "No stream found across all providers",
  });
}
