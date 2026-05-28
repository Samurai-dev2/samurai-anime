import express        from "express";
import cors           from "cors";
import path           from "path";
import fs             from "fs";

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const MIRURO_API  = "https://api-test-blush-one.vercel.app";
const PROXIFY_API = "https://web-production-3a1a9.up.railway.app";

const PROVIDER_ORDER   = ["kiwi", "arc", "zoro", "jet"];
const TIMEOUT_EPISODES = 12_000;
const TIMEOUT_WATCH    = 12_000;
const TIMEOUT_PROXIFY  = 8_000;

// ── Types ─────────────────────────────────────────────────────
interface AnimeEntry {
  mal_id?:       number;
  anilist_id?:   number;
  type?:         string;
  season?:       { tvdb?: number; tmdb?: number };
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

// ── Load mapper ONCE at startup ───────────────────────────────
const malToAnilist = new Map<number, number>();

function loadMapper(): void {
  const candidates = [
    // Primary — copied into server/data/
    path.join(process.cwd(), "data/anime-seasons.json"),
    path.join(__dirname, "../data/anime-seasons.json"),
    // Fallback — relative to compiled output
    path.join(__dirname, "../../src/data/anime-seasons.json"),
    path.join(process.cwd(), "src/data/anime-seasons.json"),
    path.join(process.cwd(), "../src/data/anime-seasons.json"),
  ];

  console.log("🔍 CWD:", process.cwd());
  console.log("🔍 __dirname:", __dirname);

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const raw  = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as AnimeEntry[];

        for (const entry of data) {
          if (entry.mal_id && entry.anilist_id) {
            malToAnilist.set(entry.mal_id, entry.anilist_id);
          }
        }

        console.log(`✅ Mapper loaded: ${malToAnilist.size} entries`);
        return;
      } catch (err: any) {
        console.error("❌ Parse error:", err.message);
      }
    }
  }

  console.error("❌ Could not find anime-seasons.json!");
}

loadMapper();

// ── Helpers ───────────────────────────────────────────────────
function withTimeout<T>(
  promise: Promise<T>,
  ms:      number,
  label =  ""
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms ${label}`)),
        ms
      )
    ),
  ]);
}

async function fetchJson<T>(
  url:       string,
  timeoutMs: number,
  label =    ""
): Promise<T> {
  console.log(`  [${label}] GET ${url.slice(0, 120)}`);

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
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

function detectReferer(streamUrl: string): string {
  try {
    const { hostname } = new URL(streamUrl);

    if (
      hostname.includes("rapid-cloud") ||
      hostname.includes("megacloud")   ||
      hostname.includes("vidcloud")
    ) return "https://zoro.to/";

    if (
      hostname.includes("gogocdn")    ||
      hostname.includes("gogoanime")  ||
      hostname.includes("gogo-stream")
    ) return "https://gogoanime.tel/";

    if (
      hostname.includes("owocdn")    ||
      hostname.includes("kwik")      ||
      hostname.includes("animepahe")
    ) return "https://kwik.cx/";

    if (
      hostname.includes("code29wave") ||
      hostname.includes("megaup")
    ) return "https://megaup.nl/";

    return "https://kwik.cx/";
  } catch {
    return "https://kwik.cx/";
  }
}

function buildWatchUrl(
  episodeId: string,
  provider:  string,
  anilistId: number,
  lang:      string
): string {
  if (episodeId.startsWith("watch/")) {
    return `${MIRURO_API}/${episodeId}`;
  }
  return `${MIRURO_API}/watch/${provider}/${anilistId}/${lang}/${episodeId}`;
}

async function proxifyStream(
  streamUrl: string,
  referer:   string
): Promise<string | null> {
  try {
    const data     = `${streamUrl}|${referer}`;
    const endpoint = `${PROXIFY_API}/proxy?data=${encodeURIComponent(data)}`;

    console.log("  [proxify] →", endpoint.slice(0, 120));

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
      console.warn("  [proxify] HTTP", res.status);
      return null;
    }

    const json = (await res.json()) as ProxifyResponse;
    const src  = json?.proxifiedSource;
    if (!src) return null;

    const picked =
      src.lunaranime ??
      src.miruro     ??
      src.anikuro    ??
      src.animanga   ??
      null;

    if (picked) console.log("  [proxify] ✓", picked.slice(0, 80));
    else        console.warn("  [proxify] all providers null");

    return picked;
  } catch (err: any) {
    console.warn("  [proxify] failed:", err.message);
    return null;
  }
}

// ── Core resolver ─────────────────────────────────────────────
async function resolveStream(
  anilistId: number,
  episode:   number,
  lang:      "sub" | "dub"
): Promise<StreamResponse> {

  // Step 1: Episodes
  let episodesData: MiruroEpisodesResponse;
  try {
    episodesData = await fetchJson<MiruroEpisodesResponse>(
      `${MIRURO_API}/episodes/${anilistId}`,
      TIMEOUT_EPISODES,
      "episodes"
    );
  } catch (err: any) {
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: `Episodes fetch failed: ${err.message}`,
    };
  }

  if (!episodesData?.providers) {
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "No providers in episodes response",
    };
  }

  const available = Object.keys(episodesData.providers);
  console.log("  [stream] Providers:", available.join(", "));

  // Step 2: Find episode
  const ordered = [
    ...PROVIDER_ORDER.filter((p) => available.includes(p)),
    ...available.filter((p) => !PROVIDER_ORDER.includes(p)),
  ];

  let episodeId:    string | null = null;
  let provider:     string | null = null;
  let resolvedLang                = lang;

  for (const prov of ordered) {
    const provData = episodesData.providers[prov];
    if (!provData?.episodes) continue;

    const langsToTry: ("sub" | "dub")[] =
      lang === "sub" ? ["sub", "dub"] : ["dub", "sub"];

    for (const tryLang of langsToTry) {
      const eps = provData.episodes[tryLang];
      if (!Array.isArray(eps) || !eps.length) continue;

      const ep = eps.find((e) => e.number === episode);
      if (ep?.id) {
        episodeId    = ep.id;
        provider     = prov;
        resolvedLang = tryLang;
        console.log(
          `  [stream] ✓ E${episode} in "${prov}" [${tryLang}]: ${ep.id}`
        );
        break;
      }
    }
    if (episodeId) break;
  }

  if (!episodeId || !provider) {
    // Debug: show what episodes ARE available
    for (const prov of ordered.slice(0, 3)) {
      const sub = episodesData.providers[prov]?.episodes?.sub;
      const dub = episodesData.providers[prov]?.episodes?.dub;
      console.log(
        `  [stream] "${prov}" sub:[${sub?.map((e) => e.number).slice(0, 8).join(",")}]`,
        `dub:[${dub?.map((e) => e.number).slice(0, 8).join(",")}]`
      );
    }
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null,
      error: `Episode ${episode} not found. Providers: ${ordered.join(", ")}`,
    };
  }

  // Step 3: Watch sources
  const watchUrl = buildWatchUrl(episodeId, provider, anilistId, resolvedLang);
  console.log("  [stream] Watch URL:", watchUrl);

  let watchData: MiruroWatchResponse;
  try {
    watchData = await fetchJson<MiruroWatchResponse>(
      watchUrl,
      TIMEOUT_WATCH,
      "watch"
    );
  } catch (err: any) {
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: `Watch fetch failed: ${err.message}`,
    };
  }

  if (!watchData?.streams?.length) {
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "No streams in watch response",
    };
  }

  // Step 4: Pick best stream
  const hlsStreams = watchData.streams
    .filter((s) => s.type === "hls" && s.url)
    .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

  const best =
    hlsStreams[0] ??
    watchData.streams.find((s) => s.url) ??
    null;

  if (!best?.url) {
    return {
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "No usable stream URL",
    };
  }

  console.log("  [stream] Best:", best.quality, best.type, best.url.slice(0, 80));

  // Step 5: Proxify
  const referer      = detectReferer(best.url);
  const proxifiedUrl = await proxifyStream(best.url, referer);

  const subtitles: SubtitleTrack[] = (watchData.subtitles ?? [])
    .filter((s) => s.file && s.label)
    .map((s) => ({
      url:   s.file,
      lang:  s.label.toLowerCase().slice(0, 2),
      label: s.label,
    }));

  const sourceLabel =
    `Miruro · ${provider} · ${best.quality} · ${resolvedLang}`;

  if (proxifiedUrl) {
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

  // Self-proxy fallback
  console.warn("  [stream] Proxify failed — self-proxy fallback");
  return {
    url: `/proxy?url=${encodeURIComponent(best.url)}&referer=${encodeURIComponent(referer)}`,
    subtitles,
    intro:   watchData.intro ?? null,
    outro:   watchData.outro ?? null,
    source:  `${sourceLabel} (self-proxied)`,
    referer,
    headers: {},
  };
}

// ── Routes ────────────────────────────────────────────────────

// Health check
app.get("/health", (_, res) => {
  res.json({
    ok:      true,
    entries: malToAnilist.size,
    uptime:  process.uptime(),
  });
});

// Stream endpoint
app.get("/api/stream", async (req, res) => {
  const { malId, episode, lang } = req.query;

  if (!malId || typeof malId !== "string") {
    return res.status(400).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "malId is required",
    });
  }

  const malIdNum = parseInt(malId);
  if (isNaN(malIdNum) || malIdNum <= 0) {
    return res.status(400).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: "malId must be a positive integer",
    });
  }

  const epNum = Math.max(1, parseInt(String(episode || "1")) || 1);
  const audio = (lang === "dub" ? "dub" : "sub") as "sub" | "dub";

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  MAL:${malIdNum} · E${epNum} · [${audio}]`);
  console.log(`${"═".repeat(50)}`);

  const anilistId = malToAnilist.get(malIdNum) ?? null;

  if (!anilistId) {
    return res.status(200).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null,
      error: `MAL ID ${malIdNum} not in database`,
    });
  }

  console.log(`  AniList ID: ${anilistId}`);

  try {
    const result = await resolveStream(anilistId, epNum, audio);

    if (result.url) {
      console.log(`  ✓ Done — ${result.source}`);
    } else {
      console.warn(`  ✗ No stream — ${result.error}`);
    }

    return res.status(200).json(result);
  } catch (err: any) {
    console.error("  ✗ Unhandled:", err.message);
    return res.status(200).json({
      url: null, subtitles: [], intro: null, outro: null,
      source: null, error: `Server error: ${err.message}`,
    });
  }
});

// Self-proxy fallback endpoint
app.get("/proxy", async (req, res) => {
  const { url, referer } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).send("url is required");
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        "Referer":    typeof referer === "string" ? referer : "https://kwik.cx/",
        "User-Agent": "Mozilla/5.0",
        "Origin":     typeof referer === "string" ? referer : "https://kwik.cx/",
      },
    });

    // Forward content-type
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Stream the body
    const buffer = await upstream.arrayBuffer();
    return res.send(Buffer.from(buffer));
  } catch (err: any) {
    return res.status(502).send(`Proxy error: ${err.message}`);
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 SamuraiAnime API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Stream: http://localhost:${PORT}/api/stream?malId=20&episode=1&lang=sub`);
});
