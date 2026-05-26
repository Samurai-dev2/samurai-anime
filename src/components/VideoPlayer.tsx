// src/components/VideoPlayer.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { AlertTriangle, Loader2, RefreshCw, SkipForward } from "lucide-react";

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
  intro?:     { start: number; end: number } | null;
  outro?:     { start: number; end: number } | null;
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
    s.onload  = () => resolve();
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

export default function VideoPlayer({
  streamUrl,
  subtitles = [],
  poster,
  title,
  referer,
  intro,
  outro,
}: VideoPlayerProps) {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const plyrRef      = useRef<any>(null);
  const hlsRef       = useRef<any>(null);

  const [error,       setError]       = useState<string | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [retryCount,  setRetryCount]  = useState(0);
  // Show skip intro button when inside the intro window
  const [showSkipIntro, setShowSkipIntro] = useState(false);
  const [showSkipOutro, setShowSkipOutro] = useState(false);

  const destroyPlayer = useCallback(() => {
    if (plyrRef.current) { try { plyrRef.current.destroy(); } catch {} plyrRef.current = null; }
    if (hlsRef.current)  { try { hlsRef.current.destroy();  } catch {} hlsRef.current  = null; }
  }, []);

  // ── Skip button logic ────────────────────────────────────────
  // Watch the video currentTime and show skip buttons in the right windows
  useEffect(() => {
    const video = videoRef.current;
    if (!video || (!intro && !outro)) return;

    function onTimeUpdate() {
      const t = video!.currentTime;

      if (intro) {
        setShowSkipIntro(t >= intro.start && t <= intro.end);
      }
      if (outro) {
        setShowSkipOutro(t >= outro.start && t <= outro.end);
      }
    }

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [intro, outro]);

  const skipIntro = useCallback(() => {
    if (videoRef.current && intro) {
      videoRef.current.currentTime = intro.end;
      setShowSkipIntro(false);
    }
  }, [intro]);

  const skipOutro = useCallback(() => {
    if (videoRef.current && outro) {
      videoRef.current.currentTime = outro.end;
      setShowSkipOutro(false);
    }
  }, [outro]);

  // ── Player init ──────────────────────────────────────────────
  useEffect(() => {
    if (!streamUrl) return;

    console.log("[VideoPlayer] streamUrl:", streamUrl.slice(0, 100));

    let cancelled = false;
    setError(null);
    setLoading(true);
    setShowSkipIntro(false);
    setShowSkipOutro(false);
    destroyPlayer();

    async function init() {
      try {
        const { Plyr, Hls } = await loadLibs();
        if (cancelled || !videoRef.current) return;

        const video = videoRef.current;

        const absoluteUrl = streamUrl.startsWith("/")
          ? `${window.location.origin}${streamUrl}`
          : streamUrl;

        console.log("[VideoPlayer] Loading:", absoluteUrl.slice(0, 100));

        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker:            true,
            maxBufferLength:         30,
            maxBufferSize:           60 * 1000 * 1000,
            manifestLoadingTimeOut:  20_000,
            levelLoadingTimeOut:     20_000,
            fragLoadingTimeOut:      30_000,
            manifestLoadingMaxRetry: 1,
            levelLoadingMaxRetry:    1,
            fragLoadingMaxRetry:     2,
          });

          hlsRef.current = hls
