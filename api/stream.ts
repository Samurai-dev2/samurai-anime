// api/stream.ts — Vercel Serverless Function
// Miruro Native API stream resolver + Unified Stream Proxy
// Replaces the Express server's /api/stream route

import type { VercelRequest, VercelResponse } from "@vercel/node";

// ── Config ──────────────────────────────────────────────────────
const MIRURO_API = "https://api-test-blush-one.vercel.app";
const PROXIFY_API = "https://web-production-3a1a9.up.railway.app";
const ANILIST_GRAPHQL = "https://graphql.anilist.co";

const PROVIDER_ORDER = ["kiwi", "arc", "zoro", "jet"];
const TIMEOUT_EPISODES = 12_000;
const TIMEOUT_WATCH = 12_000;
const TIMEOUT_PROXIFY = 8_000;

// ── Types ───────────────────────────────────────────────────────
interface MiruroEpisode {
  id: string;
  number: number;
  title?: string;
  image?: string;
  airDate?: string;
  duration?: number;
  description?: string;
  filler?: boolean;
}

interface MiruroStream {
  url: string;
  type: string;
  quality: string;
}

interface MiruroSubtitle {
  file: string;
  label: string;
  kind?: string;
}

interface SubtitleTrack {
  url: string;
  lang: string;
  label: string;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Fetch JSON with a hard timeout */
async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SamuraiAnime/1.0)",
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Convert MAL ID → AniList ID via GraphQL (no static file needed) */
async function malToAnilist(malId: number): Promise<number | null> {
  const query = `
    query ($malId: Int) {
      Media(idMal: $malId, type: ANIME) {
        id
      }
    }
  `;

  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: { malId } }),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as any;
    return json?.data?.Media?.id ?? null;
  } catch {
    return null;
  }
}

/** Guess the referer header a CDN expects based on the stream hostname */
function detectReferer(streamUrl: string): string {
  try {
    const { hostname } = new URL(streamUrl);

    if (
      hostname.includes("rapid-cloud") ||
      hostname.includes("megacloud") ||
      hostname.includes("vidcloud")
    )
      return "https://zoro.to/";

    if (
      hostname.includes("gogocdn") ||
      hostname.includes("gogoanime") ||
      hostname.includes("gogo-stream")
    )
      return "https://gogoanime.tel/";

    if (
      hostname.includes("owocdn") ||
      hostname.includes("kwik") ||
      hostname.includes("animepahe")
    )
      return "https://kwik.cx/";

    if (hostname.includes("code29wave") || hostname.includes("megaup"))
      return "https://megaup.nl/";

    return "https://kwik.cx/";
  } catch {
    return "https://kwik.cx/";
  }
}

/** Build the Miruro /watch URL from an episode id */
function buildWatchUrl(
  episodeId: string,
  provider: string,
  anilistId: number,
  lang: string
): string {
  // If the id already starts with "watch/", use it as a direct path
  if (episodeId.startsWith("watch/")) {
    return `${MIRURO_API}/${episodeId}`;
  }
  return `${MIRURO_API}/watch/${provider}/${anilistId}/${lang}/${episodeId}`;
}

/** Run a raw stream URL through the Unified Stream Proxy API */
async function proxifyStream(
  streamUrl: string,
  referer: string
): Promise<string | null> {
  try {
    const data = `${streamUrl}|${referer}`;
    const endpoint = `${PROXIFY_API}/proxy?data=${encodeURIComponent(data)}`;

    const res = await fetch(endpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SamuraiAnime/1.0)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_PROXIFY),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as any;
    const src = json?.proxifiedSource;
    if (!src) return null;

    // Preference order for proxy providers
    return src.lunaranime ?? src.miruro ?? src.anikuro ?? src.animanga ?? null;
  } catch {
    return null;
  }
}

// ── Main Handler ────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ── Parse params ──────────────────────────────────────────────
  const { malId, episode, lang } = req.query;

  if (!malId || typeof malId !== "string") {
    return res.status(400).json({
      url: null,
      subtitles: [],
      intro: null,
      outro: null,
      source: null,
      error: "malId is required",
    });
  }

  const malIdNum = parseInt(malId);
  if (isNaN(malIdNum) || malIdNum <= 0) {
    return res.status(400).json({
      url: null,
      subtitles: [],
      intro: null,
      outro: null,
      source: null,
      error: "malId must be a positive integer",
    });
  }

  const epNum = Math.max(1, parseInt(String(episode || "1")) || 1);
  const audio = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";

  console.log(`\n${"═".repeat(50)}`);
  console.log(`MAL:${malIdNum} · E${epNum} · [${audio}]`);
  console.log(`${"═".repeat(50)}`);

  try {
    // ── Step 0: MAL → AniList ID ────────────────────────────────
    const anilistId = await malToAnilist(malIdNum);

    if (!anilistId) {
      return res.status(200).json({
        url: null,
        subtitles: [],
        intro: null,
        outro: null,
        source: null,
        error: `Could not resolve AniList ID for MAL ${malIdNum}`,
      });
    }

    console.log(`AniList ID: ${anilistId}`);

    // ── Step 1: Fetch episodes from Miruro ──────────────────────
    let episodesData: any;
    try {
      episodesData = await fetchJson<any>(
        `${MIRURO_API}/episodes/${anilistId}`,
        TIMEOUT_EPISODES
      );
    } catch (err: any) {
      return res.status(200).json({
        url: null,
        subtitles: [],
        intro: null,
        outro: null,
        source: null,
        error: `Episodes fetch failed: ${err.message}`,
      });
    }

    if (!episodesData?.providers) {
      return res.status(200).json({
        url: null,
        subtitles: [],
        intro: null,
        outro: null,
        source: null,
        error: "No providers in episodes response",
      });
    }

    const available = Object.keys(episodesData.providers);
    console.log("Providers:", available.join(", "));

    // ── Step 2: Find the requested episode ───────────────────────
    const ordered = [
      ...PROVIDER_ORDER.filter((p) => available.includes(p)),
      ...available.filter((p) => !PROVIDER_ORDER.includes(p)),
    ];

    let episodeId: string | null = null;
    let provider: string | null = null;
    let resolvedLang = audio;

    for (const prov of ordered) {
      const provData = episodesData.providers[prov];
      if (!provData?.episodes) continue;

      // Try requested lang first, then fallback
      const langsToTry: ("sub" | "dub")[] =
        audio === "sub" ? ["sub", "dub"] : ["dub", "sub"];

      for (const tryLang of langsToTry) {
        const eps: MiruroEpisode[] = provData.episodes[tryLang];
        if (!Array.isArray(eps) || !eps.length) continue;

        const ep = eps.find((e) => e.number === epNum);
        if (ep?.id) {
          episodeId = ep.id;
          provider = prov;
          resolvedLang = tryLang;
          console.log(
            `✓ E${epNum} in "${prov}" [${tryLang}]: ${ep.id}`
          );
          break;
        }
      }
      if (episodeId) break;
    }

    if (!episodeId || !provider) {
      // Debug: log what's actually available
      for (const prov of ordered.slice(0, 3)) {
        const sub = episodesData.providers[prov]?.episodes?.sub;
        const dub = episodesData.providers[prov]?.episodes?.dub;
        console.log(
          `"${prov}" sub:[${sub?.map((e: any) => e.number).slice(0, 8).join(",")}]`,
          `dub:[${dub?.map((e: any) => e.number).slice(0, 8).join(",")}]`
        );
      }

      return res.status(200).json({
        url: null,
        subtitles: [],
        intro: null,
        outro: null,
        source: null,
        error: `Episode ${epNum} not found. Providers: ${ordered.join(", ")}`,
      });
    }

    // ── Step 3: Fetch stream sources from Miruro ─────────────────
    const watchUrl = buildWatchUrl(episodeId, provider, anilistId, resolvedLang);
    console.log("Watch URL:", watchUrl);

    let watchData: any;
    try {
      watchData = await fetchJson<any>(watchUrl, TIMEOUT_WATCH);
    } catch (err: any) {
      return res.status(200).json({
        url: null,
        subtitles: [],
        intro: null,
        outro: null,
        source: null,
        error: `Watch fetch failed: ${err.message}`,
      });
    }

    if (!watchData?.streams?.length) {
      return res.status(200).json({
        url: null,
        subtitles: [],
        intro: null,
        outro: null,
        source: null,
        error: "No streams in watch response",
      });
    }

    // ── Step 4: Pick the best quality HLS stream ────────────────
    const hlsStreams = watchData.streams
      .filter((s: MiruroStream) => s.type === "hls" && s.url)
      .sort(
        (a: MiruroStream, b: MiruroStream) =>
          (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0)
      );

    const best = hlsStreams[0] ?? watchData.streams.find((s: MiruroStream) => s.url) ?? null;

    if (!best?.url) {
      return res.status(200).json({
        url: null,
        subtitles: [],
        intro: null,
        outro: null,
        source: null,
        error: "No usable stream URL",
      });
    }

    console.log("Best:", best.quality, best.type, best.url.slice(0, 80));

    // ── Step 5: Proxify through the Unified Stream Proxy ─────────
    const referer = detectReferer(best.url);
    const proxifiedUrl = await proxifyStream(best.url, referer);

    const subtitles: SubtitleTrack[] = (watchData.subtitles ?? [])
      .filter((s: MiruroSubtitle) => s.file && s.label)
      .map((s: MiruroSubtitle) => ({
        url: s.file,
        lang: s.label.toLowerCase().slice(0, 2),
        label: s.label,
      }));

    const sourceLabel = `Miruro · ${provider} · ${best.quality} · ${resolvedLang}`;

    // ── Return proxified URL ─────────────────────────────────────
    if (proxifiedUrl) {
      console.log("✓ Done —", sourceLabel, "(proxified)");
      return res.status(200).json({
        url: proxifiedUrl,
        subtitles,
        intro: watchData.intro ?? null,
        outro: watchData.outro ?? null,
        source: sourceLabel,
        referer,
      });
    }

    // ── Fallback: return raw URL with headers ────────────────────
    console.warn("Proxify failed — returning raw URL with referer header");
    return res.status(200).json({
      url: best.url,
      subtitles,
      intro: watchData.intro ?? null,
      outro: watchData.outro ?? null,
      source: `${sourceLabel} (direct)`,
      referer,
      headers: { Referer: referer },
    });
  } catch (err: any) {
    console.error("✗ Unhandled:", err.message);
    return res.status(200).json({
      url: null,
      subtitles: [],
      intro: null,
      outro: null,
      source: null,
      error: `Server error: ${err.message}`,
    });
  }
}
