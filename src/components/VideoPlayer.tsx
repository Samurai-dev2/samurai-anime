// src/components/VideoPlayer.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

interface Subtitle {
  lang: string;
  label: string;
  url: string;
}

interface VideoPlayerProps {
  streamUrl: string;
  subtitles?: Subtitle[];
  poster?: string;
  title?: string;
  referer?: string;
}

// ─── Script / CSS loader helpers ──────────────────────────────

function loadStylesheet(id: string, href: string): void {
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function loadScript(id: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

let libsPromise: Promise<{ Plyr: any; Hls: any }> | null = null;

function loadLibs(): Promise<{ Plyr: any; Hls: any }> {
  if (libsPromise) return libsPromise;

  libsPromise = (async () => {
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
    return {
      Plyr: (window as any).Plyr,
      Hls: (window as any).Hls,
    };
  })();

  return libsPromise;
}

// ─── Component ────────────────────────────────────────────────

export default function VideoPlayer({
  streamUrl,
  subtitles = [],
  poster,
  title,
  referer,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const plyrRef = useRef<any>(null);
  const hlsRef = useRef<any>(null);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

    let cancelled = false;

    setError(null);
    setLoading(true);
    destroyPlayer();

    async function init() {
      try {
        const { Plyr, Hls } = await loadLibs();
        if (cancelled || !videoRef.current) return;

        const video = videoRef.current;

        // ── HLS setup ──────────────────────────────────────
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            maxBufferLength: 30,
            maxBufferSize: 60 * 1000 * 1000,
            // Longer timeout for slow CDN segments
            manifestLoadingTimeOut: 15_000,
            levelLoadingTimeOut: 15_000,
            fragLoadingTimeOut: 30_000,
          });

          hlsRef.current = hls;

          hls.on(Hls.Events.ERROR, (_: any, data: any) => {
            if (cancelled) return;

            console.warn(
              "[HLS] Error:",
              data.type,
              data.details,
              "fatal:", data.fatal
            );

            if (!data.fatal) return; // non-fatal — HLS.js will retry

            // Fatal errors need explicit recovery or we show an error
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              console.error("[HLS] Fatal network error — attempting recovery");
              hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              console.error("[HLS] Fatal media error — attempting recoverMediaError");
              hls.recoverMediaError();
            } else {
              setError(
                "Stream failed to load. " +
                  "The source may be unavailable or geo-restricted."
              );
              setLoading(false);
            }
          });

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            console.log("[HLS] ✓ Manifest parsed");
            setLoading(false);
          });

          hls.loadSource(streamUrl);
          hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari — native HLS
          video.src = streamUrl;
          video.addEventListener("loadedmetadata", () => {
            if (!cancelled) setLoading(false);
          }, { once: true });
          video.addEventListener("error", () => {
            if (!cancelled) {
              setError("Failed to load stream (native HLS error).");
              setLoading(false);
            }
          }, { once: true });
        } else {
          setError("HLS playback is not supported in this browser.");
          setLoading(false);
          return;
        }

        // ── Plyr setup ─────────────────────────────────────
        const player = new Plyr(video, {
          title: title || "Anime",
          controls: [
            "play-large",
            "play",
            "rewind",
            "fast-forward",
            "progress",
            "current-time",
            "duration",
            "mute",
            "volume",
            "captions",
            "settings",
            "pip",
            "fullscreen",
          ],
          settings: ["captions", "quality", "speed"],
          speed: {
            selected: 1,
            options: [0.5, 0.75, 1, 1.25, 1.5, 2],
          },
          captions: {
            active: subtitles.length > 0,
            language: "en",
            update: true,
          },
          poster: poster ?? undefined,
          autoplay: false,
        });

        plyrRef.current = player;

        // ── Quality levels ─────────────────────────────────
        if (hlsRef.current) {
          const hls = hlsRef.current;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;

            const levels: number[] = hls.levels.map((l: any) => l.height);
            const options = [0, ...levels]; // 0 = Auto

            player.config.quality = {
              default: 0,
              options,
              forced: true,
              onChange(newQuality: number) {
                if (newQuality === 0) {
                  hls.currentLevel = -1; // Auto
                } else {
                  const idx = hls.levels.findIndex(
                    (l: any) => l.height === newQuality
                  );
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

  // ── Retry handler ────────────────────────────────────────────
  const handleRetry = () => {
    setRetryCount((c) => c + 1);
  };

  return (
    <div className="relative w-full rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-2xl shadow-black/60 bg-black">
      {/* Loading overlay */}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-20 aspect-video">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-10 h-10 text-red-500 animate-spin" />
            <p className="text-gray-400 text-sm">Loading stream…</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center justify-center bg-zinc-900 aspect-video">
          <div className="text-center px-6 flex flex-col items-center gap-4">
            <AlertTriangle className="w-10 h-10 text-yellow-400" />
            <p className="text-white font-semibold">Stream Error</p>
            <p className="text-gray-400 text-sm max-w-xs">{error}</p>
            <button
              onClick={handleRetry}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Player */}
      <div
        className="aspect-video w-full"
        style={
          {
            "--plyr-color-main": "#dc2626",
            "--plyr-video-background": "#000",
            "--plyr-menu-background": "#18181b",
            "--plyr-menu-color": "#fff",
            "--plyr-menu-border-color": "#27272a",
            "--plyr-control-icon-size": "18px",
            "--plyr-font-size-base": "14px",
            "--plyr-tooltip-background": "#18181b",
            "--plyr-tooltip-color": "#fff",
            "--plyr-badge-background": "#dc2626",
          } as React.CSSProperties
        }
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
