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
  referer?:   string;   // ← new: needed for AnimePahe/Kwik streams
}

// ── Load scripts from CDN so we dont need npm packages ─────
function loadScript(id: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) {
      resolve();
      return;
    }
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
  referer,    // ← destructure new prop
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef     = useRef<HTMLVideoElement>(null);
  const plyrRef      = useRef<any>(null);
  const hlsRef       = useRef<any>(null);

  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!streamUrl) return;

    let cancelled = false;

    setError(null);
    setLoading(true);

    if (plyrRef.current) {
      plyrRef.current.destroy();
      plyrRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    async function init() {
      try {
        const { Plyr, Hls } = await loadPlyrAndHls();
        if (cancelled || !videoRef.current) return;

        const video = videoRef.current;

        // ── Set up HLS ──────────────────────────────────────
        if (streamUrl.includes(".m3u8") && Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: false,
            // ↓ Only change: pass referer in xhrSetup if we have one
            xhrSetup: (xhr: XMLHttpRequest, url: string) => {
              xhr.setRequestHeader("Accept", "*/*");
              // AnimePahe/Kwik streams require a Referer header
              // We send it as a custom header — your scraper's
              // proxy endpoint handles the actual referer forwarding
              if (referer) {
                xhr.setRequestHeader("X-Referer", referer);
              }
            },
          });

          hlsRef.current = hls;

          hls.on(Hls.Events.ERROR, (_: any, data: any) => {
            if (data.fatal && !cancelled) {
              setError("Stream failed to load. Try switching to fallback.");
              setLoading(false);
            }
          });

          hls.loadSource(streamUrl);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            setLoading(false);
          });

        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari native HLS
          video.src = streamUrl;
          setLoading(false);
        } else {
          // plain MP4 or direct URL
          video.src = streamUrl;
          setLoading(false);
        }

        // ── Initialize Plyr ─────────────────────────────────
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
          poster: poster || undefined,
          autoplay: false,
          i18n: {
            play:  "Play",
            pause: "Pause",
          },
        });

        plyrRef.current = player;

        // ── Quality switching through HLS ────────────────────
        if (hlsRef.current) {
          const hls = hlsRef.current;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            const availableQualities = hls.levels.map((l: any) => l.height);
            availableQualities.unshift(0); // 0 = auto

            player.config.quality = {
              default:  0,
              options:  availableQualities,
              forced:   true,
              onChange: (newQuality: number) => {
                if (newQuality === 0) {
                  hls.currentLevel = -1;
                } else {
                  hls.levels.forEach((level: any, idx: number) => {
                    if (level.height === newQuality) {
                      hls.currentLevel = idx;
                    }
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
      if (plyrRef.current) {
        plyrRef.current.destroy();
        plyrRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [streamUrl, poster, title, referer]); // ← add referer to deps

  return (
    <div className="relative w-full rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-2xl shadow-black/60 bg-black">

      {/* loading overlay */}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-20 aspect-video">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-10 h-10 text-red-500 animate-spin" />
            <p className="text-gray-400 text-sm">Loading stream...</p>
          </div>
        </div>
      )}

      {/* error state */}
      {error && (
        <div className="flex items-center justify-center bg-zinc-900 aspect-video">
          <div className="text-center px-6">
            <AlertTriangle className="w-10 h-10 text-yellow-400 mx-auto mb-3" />
            <p className="text-white font-semibold mb-1">Stream Error</p>
            <p className="text-gray-400 text-sm">{error}</p>
          </div>
        </div>
      )}

      {/* video element */}
      {!error && (
        <div
          ref={containerRef}
          className="aspect-video w-full"
          style={{
            "--plyr-color-main":        "#dc2626",
            "--plyr-video-background":  "#000",
            "--plyr-menu-background":   "#18181b",
            "--plyr-menu-color":        "#fff",
            "--plyr-menu-border-color": "#27272a",
            "--plyr-control-icon-size": "18px",
            "--plyr-font-size-base":    "14px",
            "--plyr-tooltip-background":"#18181b",
            "--plyr-tooltip-color":     "#fff",
            "--plyr-badge-background":  "#dc2626",
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
