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
  link.id    = id;
  link.rel   = "stylesheet";
  link.href  = href;
  document.head.appendChild(link);
}

function loadScript(id: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) { resolve(); return; }
    const s    = document.createElement("script");
    s.id       = id;
    s.src      = src;
    s.async    = true;
    s.onload   = () => resolve();
    s.onerror  = () => reject(new Error(`Failed to load: ${src}`));
    document.head.appendChild(s);
  });
}

let libsCache: Promise<{ Plyr: any; Hls: any }> | null = null;
function loadLibs(): Promise<{ Plyr: any; Hls: any }> {
  if (libsCache) return libsCache;
  libsCache = (async () => {
    loadStylesheet(
      "plyr-css",
      "https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css"
    );
    await loadScript(
      "hls-script",
      "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"
    );
    await loadScript(
      "plyr-script",
      "https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.min.js"
    );
    return { Plyr: (window as any).Plyr, Hls: (window as any).Hls };
  })();
  return libsCache;
}

// Route these through our proxy — everything else goes direct
function shouldProxy(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname.endsWith(".uwucdn.top") ||
      hostname.endsWith(".owocdn.top") ||
      hostname === "kwik.cx"
    );
  } catch {
    return false;
  }
}

function toProxyUrl(url: string, referer: string): string {
  return (
    `${window.location.origin}/api/proxy` +
    `?url=${encodeURIComponent(url)}` +
    `&referer=${encodeURIComponent(referer)}`
  );
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

        // The referer to send with all CDN requests
        const ref = referer || "https://kwik.cx/";

        // Make the initial M3U8 URL absolute
        const absoluteUrl = streamUrl.startsWith("/")
          ? `${window.location.origin}${streamUrl}`
          : streamUrl;

        console.log("[VideoPlayer] Loading:", absoluteUrl.slice(0, 100));

        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker:    true,
            maxBufferLength: 30,
            maxBufferSize:   60 * 1000 * 1000,
            manifestLoadingTimeOut: 20_000,
            levelLoadingTimeOut:    20_000,
            fragLoadingTimeOut:     30_000,
            manifestLoadingMaxRetry: 2,
            levelLoadingMaxRetry:    2,
            fragLoadingMaxRetry:     2,

            // ── KEY: intercept every XHR HLS.js makes ──────
            // If the URL is a CDN URL (uwucdn.top etc) route it
            // through our proxy so the browser never makes a
            // direct cross-origin request that the CDN blocks
            xhrSetup(xhr: XMLHttpRequest, url: string) {
              if (shouldProxy(url)) {
                // Reopen the XHR to the proxy URL instead
                const proxied = toProxyUrl(url, ref);
                console.log("[HLS] Routing through proxy:", url.slice(0, 60));
                xhr.open("GET", proxied, true);
              }
              // If it is already a proxy URL — leave it alone
            },
          });

          hlsRef.current = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            console.log("[VideoPlayer] ✓ Manifest parsed");
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
              console.error("[VideoPlayer] Fatal network error — startLoad()");
              hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              console.error("[VideoPlayer] Fatal media error — recoverMediaError()");
              hls.recoverMediaError();
            } else {
              setError("Stream failed to load. Please try again.");
              setLoading(false);
            }
          });

          // If the M3U8 URL is a CDN URL, route it through proxy first
          const sourceUrl = shouldProxy(absoluteUrl)
            ? toProxyUrl(absoluteUrl, ref)
            : absoluteUrl;

          console.log("[VideoPlayer] Source URL for HLS:", sourceUrl.slice(0, 100));
          hls.loadSource(sourceUrl);
          hls.attachMedia(video);

        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari native HLS
          video.src = absoluteUrl;
          video.addEventListener(
            "loadedmetadata",
            () => { if (!cancelled) setLoading(false); },
            { once: true }
          );
          video.addEventListener(
            "error",
            () => {
              if (!cancelled) {
                setError("Failed to load stream.");
                setLoading(false);
              }
            },
            { once: true }
          );
        } else {
          setError("Your browser does not support HLS playback.");
          setLoading(false);
          return;
        }

        // ── Plyr UI ────────────────────────────────────────
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
              default:  0,
              options:  [0, ...levels],
              forced:   true,
              onChange(q: number) {
                if (q === 0) {
                  hls.currentLevel = -1;
                } else {
                  const idx = hls.levels.findIndex((l: any) => l.height === q);
                  if (idx !== -1) hls.currentLevel = idx;
                }
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
