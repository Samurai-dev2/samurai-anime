// src/components/VideoPlayer.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

interface Subtitle {
  lang:  string;
  label: string;
  url:   string;
}

interface VideoPlayerProps {
  streamUrl:  string;
  subtitles?: Subtitle[];
  poster?:    string;
  title?:     string;
  referer?:   string;
}

function loadStylesheet(id: string, href: string): void {
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id; link.rel = "stylesheet"; link.href = href;
  document.head.appendChild(link);
}

function loadScript(id: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) { resolve(); return; }
    const s = document.createElement("script");
    s.id = id; s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load: ${src}`));
    document.head.appendChild(s);
  });
}

let libsCache: Promise<{ Plyr: any; Hls: any }> | null = null;
function loadLibs(): Promise<{ Plyr: any; Hls: any }> {
  if (libsCache) return libsCache;
  libsCache = (async () => {
    loadStylesheet("plyr-css", "https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css");
    await loadScript("hls-script", "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js");
    await loadScript("plyr-script", "https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.min.js");
    return { Plyr: (window as any).Plyr, Hls: (window as any).Hls };
  })();
  return libsCache;
}

// Build a proxy URL for a CDN resource
function proxyUrl(cdnUrl: string, referer: string): string {
  return (
    `${window.location.origin}/api/proxy` +
    `?url=${encodeURIComponent(cdnUrl)}` +
    `&referer=${encodeURIComponent(referer)}`
  );
}

// Fetch the M3U8 directly from the browser (bypasses Vercel IP blocks)
// then rewrite all segment/key URLs to go through our proxy
async function fetchAndRewriteM3u8(
  m3u8Url: string,
  referer:  string
): Promise<string> {
  console.log("[M3U8] Fetching directly from browser:", m3u8Url.slice(0, 80));

  // Browser fetch — CDN allows this, blocks server IPs
  const res = await fetch(m3u8Url, {
    headers: {
      "Origin":  "https://kwik.cx",
      "Referer": referer,
    },
    // mode: "cors" is default
  });

  if (!res.ok) {
    throw new Error(`M3U8 fetch failed: HTTP ${res.status}`);
  }

  const text = await res.text();
  console.log("[M3U8] Got response, length:", text.length, "starts with:", text.slice(0, 20));

  if (!text.trimStart().startsWith("#EXTM3U")) {
    throw new Error(`Not a valid M3U8. Got: ${text.slice(0, 100)}`);
  }

  const base = new URL(m3u8Url);
  const lines = text.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const t = line.trim();

    if (!t) { out.push(line); continue; }

    // Encryption key — route through proxy
    if (t.startsWith("#EXT-X-KEY")) {
      const match = t.match(/URI="([^"]+)"/);
      if (match && !match[1].startsWith("data:")) {
        let absKey: string;
        try { absKey = new URL(match[1], base).toString(); }
        catch { absKey = match[1]; }
        const rewritten = line.replace(
          /URI="[^"]*"/,
          `URI="${proxyUrl(absKey, referer)}"`
        );
        out.push(rewritten);
      } else {
        out.push(line);
      }
      continue;
    }

    // Init segment — route through proxy
    if (t.startsWith("#EXT-X-MAP")) {
      out.push(
        line.replace(/URI="([^"]*)"/, (_, u) => {
          let abs: string;
          try { abs = new URL(u, base).toString(); }
          catch { abs = u; }
          return `URI="${proxyUrl(abs, referer)}"`;
        })
      );
      continue;
    }

    // Other tags — pass through
    if (t.startsWith("#")) { out.push(line); continue; }

    // Segment URL — route through proxy
    let absSegment: string;
    try { absSegment = new URL(t, base).toString(); }
    catch { absSegment = t; }

    out.push(proxyUrl(absSegment, referer));
  }

  return out.join("\n");
}

export default function VideoPlayer({
  streamUrl,
  subtitles = [],
  poster,
  title,
  referer,
}: VideoPlayerProps) {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const plyrRef      = useRef<any>(null);
  const hlsRef       = useRef<any>(null);
  const blobRef      = useRef<string | null>(null); // track blob URL to revoke it

  const [error,      setError]      = useState<string | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [retryCount, setRetryCount] = useState(0);

  const destroyPlayer = useCallback(() => {
    if (plyrRef.current) {
      try { plyrRef.current.destroy(); } catch { /* ignore */ }
      plyrRef.current = null;
    }
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch { /* ignore */ }
      hlsRef.current = null;
    }
    // Clean up blob URL to free memory
    if (blobRef.current) {
      URL.revokeObjectURL(blobRef.current);
      blobRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!streamUrl) return;

    console.log("[VideoPlayer] streamUrl:", streamUrl.slice(0, 100));

    let cancelled = false;
    setError(null);
    setLoading(true);
    destroyPlayer();

    async function init() {
      try {
        const { Plyr, Hls } = await loadLibs();
        if (cancelled || !videoRef.current) return;

        const video = videoRef.current;
        const ref   = referer || "https://kwik.cx/";

        // Make sure we have an absolute URL
        const absoluteM3u8 = streamUrl.startsWith("/")
          ? `${window.location.origin}${streamUrl}`
          : streamUrl;

        // ── Step 1: Fetch and rewrite M3U8 in the browser ────
        // This works because the browser is not blocked by the CDN
        // The server (Vercel IP) is blocked, but the browser is not
        let hlsSource: string;

        try {
          console.log("[VideoPlayer] Fetching M3U8 from browser...");
          const rewrittenM3u8 = await fetchAndRewriteM3u8(absoluteM3u8, ref);

          // Create a blob URL from the rewritten M3U8
          // HLS.js will use this as its source — all segment URLs
          // inside it point to our proxy so they work fine
          const blob = new Blob([rewrittenM3u8], {
            type: "application/vnd.apple.mpegurl",
          });
          const blobUrl    = URL.createObjectURL(blob);
          blobRef.current  = blobUrl;
          hlsSource        = blobUrl;

          console.log("[VideoPlayer] ✓ M3U8 rewritten, blob URL created");
          console.log("[VideoPlayer] Rewritten M3U8 preview:", rewrittenM3u8.slice(0, 300));

        } catch (fetchErr: any) {
          // If direct browser fetch fails (CORS error), fall back to proxy
          console.warn(
            "[VideoPlayer] Direct fetch failed:", fetchErr.message,
            "— falling back to proxy URL"
          );
          hlsSource = proxyUrl(absoluteM3u8, ref);
        }

        if (cancelled) return;

        // ── Step 2: Feed to HLS.js ────────────────────────────
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker:    true,
            maxBufferLength: 30,
            maxBufferSize:   60 * 1000 * 1000,
            manifestLoadingTimeOut: 20_000,
            levelLoadingTimeOut:    20_000,
            fragLoadingTimeOut:     30_000,
            manifestLoadingMaxRetry: 1,
            levelLoadingMaxRetry:    1,
            fragLoadingMaxRetry:     2,
          });

          hlsRef.current = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            console.log("[VideoPlayer] ✓ HLS manifest parsed");
            setLoading(false);
          });

          hls.on(Hls.Events.ERROR, (_: any, data: any) => {
            if (cancelled) return;
            console.log(
              "[VideoPlayer] HLS error:",
              data.type, "|", data.details,
              "| fatal:", data.fatal,
              "| url:", (data.url || "").slice(0, 80)
            );
            if (!data.fatal) return;

            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
            } else {
              setError("Stream failed to load. Please try again.");
              setLoading(false);
            }
          });

          console.log("[VideoPlayer] Loading HLS source:", hlsSource.slice(0, 80));
          hls.loadSource(hlsSource);
          hls.attachMedia(video);

        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = hlsSource;
          video.addEventListener(
            "loadedmetadata",
            () => { if (!cancelled) setLoading(false); },
            { once: true }
          );
          video.addEventListener(
            "error",
            () => { if (!cancelled) { setError("Failed to load stream."); setLoading(false); } },
            { once: true }
          );
        } else {
          setError("Your browser does not support HLS playback.");
          setLoading(false);
          return;
        }

        // ── Step 3: Plyr UI ───────────────────────────────────
        const player = new Plyr(video, {
          title:    title || "Anime",
          controls: [
            "play-large", "play", "rewind", "fast-forward",
            "progress", "current-time", "duration",
            "mute", "volume", "captions", "settings", "pip", "fullscreen",
          ],
          settings: ["captions", "quality", "speed"],
          speed:    { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
          captions: { active: subtitles.length > 0, language: "en", update: true },
          poster:   poster ?? undefined,
          autoplay: false,
        });

        plyrRef.current = player;

        if (hlsRef.current) {
          const hls = hlsRef.current;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            const levels: number[] = hls.levels.map((l: any) => l.height);
            player.config.quality = {
              default: 0,
              options: [0, ...levels],
              forced:  true,
              onChange(q: number) {
                hls.currentLevel = q === 0
                  ? -1
                  : hls.levels.findIndex((l: any) => l.height === q);
              },
            };
            player.quality = 0;
          });
        }

      } catch (e: any) {
        if (!cancelled) {
          console.error("[VideoPlayer] Init error:", e.message);
          setError(e?.message || "Failed to initialize player");
          setLoading(false);
        }
      }
    }

    init();
    return () => {
      cancelled = true;
      destroyPlayer();
    };
  }, [streamUrl, poster, title, referer, retryCount, destroyPlayer]);

  return (
    <div className="relative w-full rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-2xl shadow-black/60 bg-black">

      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-20 aspect-video">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-10 h-10 text-red-500 animate-spin" />
            <p className="text-gray-400 text-sm">Loading stream…</p>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-center bg-zinc-900 aspect-video">
          <div className="text-center px-6 flex flex-col items-center gap-4">
            <AlertTriangle className="w-10 h-10 text-yellow-400" />
            <p className="text-white font-semibold">Stream Error</p>
            <p className="text-gray-400 text-sm max-w-xs">{error}</p>
            <button
              onClick={() => setRetryCount((c) => c + 1)}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" /> Retry
            </button>
          </div>
        </div>
      )}

      <div
        className="aspect-video w-full"
        style={{
          "--plyr-color-main":         "#dc2626",
          "--plyr-video-background":   "#000",
          "--plyr-menu-background":    "#18181b",
          "--plyr-menu-color":         "#fff",
          "--plyr-menu-border-color":  "#27272a",
          "--plyr-control-icon-size":  "18px",
          "--plyr-font-size-base":     "14px",
          "--plyr-tooltip-background": "#18181b",
          "--plyr-tooltip-color":      "#fff",
          "--plyr-badge-background":   "#dc2626",
        } as React.CSSProperties}
      >
        <video
          ref={videoRef}
          className="w-full h-full"
          crossOrigin="anonymous"
          playsInline
        >
          {subtitles.map((sub) => (
            <track
              key={sub.lang}
              kind="subtitles"
              src={sub.url}
              srcLang={sub.lang}
              label={sub.label}
              default={sub.lang === "en" || sub.lang === "English"}
            />
          ))}
        </video>
      </div>
    </div>
  );
}
