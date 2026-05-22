// src/components/VideoPlayer.tsx
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

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

function loadScript(id: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) { resolve(); return; }
    const script    = document.createElement("script");
    script.id       = id;
    script.src      = src;
    script.async    = true;
    script.onload   = () => resolve();
    script.onerror  = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function loadStylesheet(id: string, href: string): void {
  if (document.getElementById(id)) return;
  const link  = document.createElement("link");
  link.id     = id;
  link.rel    = "stylesheet";
  link.href   = href;
  document.head.appendChild(link);
}

async function loadPlyrAndHls(): Promise<{ Plyr: any; Hls: any }> {
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
    Hls:  (window as any).Hls,
  };
}

export default function VideoPlayer({
  streamUrl,
  subtitles = [],
  poster,
  title,
  referer,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef     = useRef<HTMLVideoElement>(null);
  const plyrRef      = useRef<any>(null);
  const hlsRef       = useRef<any>(null);
  const blobUrlRef   = useRef<string | null>(null);  // ← track blob URL for cleanup

  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!streamUrl) return;

    let cancelled = false;

    setError(null);
    setLoading(true);

    // Destroy previous instances
    if (plyrRef.current) { plyrRef.current.destroy(); plyrRef.current = null; }
    if (hlsRef.current)  { hlsRef.current.destroy();  hlsRef.current  = null; }

    // Revoke previous blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    async function init() {
      try {
        const { Plyr, Hls } = await loadPlyrAndHls();
        if (cancelled || !videoRef.current) return;

        const video = videoRef.current;

        // ── Determine the actual URL to feed HLS.js ──────────
        // If it's our /api/proxy URL (serves m3u8 with rewritten segments),
        // fetch it → create a Blob URL → HLS.js can load that fine
        let hlsUrl = streamUrl;

        const isProxyM3u8 =
          streamUrl.startsWith("/api/proxy") ||
          streamUrl.startsWith("data:application/vnd.apple.mpegurl");

        if (isProxyM3u8 && streamUrl.startsWith("/api/proxy")) {
          try {
            console.log("[VideoPlayer] Fetching proxied m3u8…");

            const res = await fetch(streamUrl);
            if (!res.ok) throw new Error(`Proxy returned ${res.status}`);

            const m3u8Text = await res.text();

            // Create a Blob URL — HLS.js handles this perfectly
            const blob     = new Blob([m3u8Text], { type: "application/vnd.apple.mpegurl" });
            const blobUrl  = URL.createObjectURL(blob);
            blobUrlRef.current = blobUrl;
            hlsUrl             = blobUrl;

            console.log("[VideoPlayer] Blob URL created:", blobUrl.slice(0, 40));
          } catch (err: any) {
            console.warn("[VideoPlayer] Blob creation failed, using URL directly:", err.message);
            // Fall through — use streamUrl directly
          }
        }

        // ── Set up HLS.js ────────────────────────────────────
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker:    true,
            // No special headers needed — segments go through /api/proxy
            // which already adds Referer server-side
            maxBufferLength: 30,
            maxBufferSize:   60 * 1000 * 1000,
          });

          hlsRef.current = hls;

          hls.on(Hls.Events.ERROR, (_: any, data: any) => {
            if (data.fatal && !cancelled) {
              console.error("[HLS] Fatal error:", data.type, data.details);
              setError("Stream failed to load. The source may be unavailable.");
              setLoading(false);
            }
          });

          hls.loadSource(hlsUrl);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            console.log("[HLS] Manifest parsed ✓");
            setLoading(false);
          });

        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari native HLS
          video.src = hlsUrl;
          setLoading(false);
        } else {
          video.src = hlsUrl;
          setLoading(false);
        }

        // ── Initialize Plyr ──────────────────────────────────
        const player = new Plyr(video, {
          title:    title || "Anime",
          controls: [
            "play-large", "play", "rewind", "fast-forward",
            "progress", "current-time", "duration",
            "mute", "volume", "captions", "settings", "pip", "fullscreen",
          ],
          settings: ["captions", "quality", "speed"],
          speed: {
            selected: 1,
            options:  [0.5, 0.75, 1, 1.25, 1.5, 2],
          },
          captions: {
            active:   subtitles.length > 0,
            language: "en",
            update:   true,
          },
          poster:   poster || undefined,
          autoplay: false,
          i18n:     { play: "Play", pause: "Pause" },
        });

        plyrRef.current = player;

        // ── Wire quality levels to Plyr settings ─────────────
        if (hlsRef.current) {
          const hls = hlsRef.current;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;

            const availableQualities = hls.levels.map((l: any) => l.height);
            availableQualities.unshift(0); // 0 = Auto

            player.config.quality = {
              default:  0,
              options:  availableQualities,
              forced:   true,
              onChange: (newQuality: number) => {
                if (newQuality === 0) {
                  hls.currentLevel = -1; // Auto
                } else {
                  hls.levels.forEach((level: any, idx: number) => {
                    if (level.height === newQuality) hls.currentLevel = idx;
                  });
                }
              },
            };

            player.quality = 0;
          });
        }

      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "Failed to initialize player");
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      if (plyrRef.current) { plyrRef.current.destroy(); plyrRef.current = null; }
      if (hlsRef.current)  { hlsRef.current.destroy();  hlsRef.current  = null; }
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [streamUrl, poster, title, referer]);

  return (
    <div className="relative w-full rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-2xl shadow-black/60 bg-black">

      {/* Loading overlay */}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-20 aspect-video">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-10 h-10 text-red-500 animate-spin" />
            <p className="text-gray-400 text-sm">Loading stream...</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center justify-center bg-zinc-900 aspect-video">
          <div className="text-center px-6">
            <AlertTriangle className="w-10 h-10 text-yellow-400 mx-auto mb-3" />
            <p className="text-white font-semibold mb-1">Stream Error</p>
            <p className="text-gray-400 text-sm">{error}</p>
          </div>
        </div>
      )}

      {/* Video element */}
      {!error && (
        <div
          ref={containerRef}
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
      )}
    </div>
  );
}
