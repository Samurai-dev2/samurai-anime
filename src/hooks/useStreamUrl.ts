// src/hooks/useStreamUrl.ts
import { useState, useEffect, useRef } from "react";

export interface SubtitleTrack {
  url:   string;
  lang:  string;
  label: string;
}

export interface StreamHeaders {
  referer?: string;
  headers?: Record<string, string>;
}

interface StreamResult {
  streamUrl:     string | null;
  subtitles:     SubtitleTrack[];
  streamHeaders: StreamHeaders;
  loading:       boolean;
  error:         string | null;
  intro:         { start: number; end: number } | null;
  outro:         { start: number; end: number } | null;
  sourceLabel:   string | null;
}

// How long to wait for the stream API (ms)
// Keep under Vercel's function timeout
const FETCH_TIMEOUT = 28_000;

export function useStreamUrl(
  title:   string | null,
  episode: number,
  lang:    "sub" | "dub",
  malId?:  number,
  season?: number,
): StreamResult {
  const [streamUrl,     setStreamUrl]     = useState<string | null>(null);
  const [subtitles,     setSubtitles]     = useState<SubtitleTrack[]>([]);
  const [streamHeaders, setStreamHeaders] = useState<StreamHeaders>({});
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [sourceLabel,   setSourceLabel]   = useState<string | null>(null);
  const [intro,         setIntro]         = useState<{ start: number; end: number } | null>(null);
  const [outro,         setOutro]         = useState<{ start: number; end: number } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!malId) {
      setStreamUrl(null);
      setSubtitles([]);
      setStreamHeaders({});
      setSourceLabel(null);
      setIntro(null);
      setOutro(null);
      setError("No anime ID available");
      setLoading(false);
      return;
    }

    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Timeout that aborts the fetch if the server takes too long
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT);

    async function fetchStream() {
      setLoading(true);
      setError(null);
      setStreamUrl(null);
      setSubtitles([]);
      setStreamHeaders({});
      setSourceLabel(null);
      setIntro(null);
      setOutro(null);

      try {
        const params = new URLSearchParams({
          malId:   String(malId),
          episode: String(episode),
          lang,
          season:  String(season ?? 1),
        });

        if (title) params.set("title", title);

        console.log("[useStreamUrl] Fetching:", params.toString());

        const res = await fetch(`/api/stream?${params}`, {
          signal: controller.signal,
        });

        // Read body regardless of status so we can extract the error message
        const data = await res.json().catch(() => ({
          url: null, subtitles: [], intro: null, outro: null,
          source: null, error: `Server returned ${res.status}`,
        }));

        if (controller.signal.aborted) return;

        console.log("[useStreamUrl] Response:", {
          status: res.status,
          url:    data.url ? data.url.slice(0, 80) : null,
          error:  data.error,
          source: data.source,
        });

        setStreamUrl(  data.url       ?? null);
        setSubtitles(  data.subtitles ?? []);
        setSourceLabel(data.source    ?? null);
        setIntro(      data.intro     ?? null);
        setOutro(      data.outro     ?? null);
        setStreamHeaders({
          referer: data.referer,
          headers: data.headers,
        });

        // Set error only if there's no URL
        if (!data.url) {
          setError(data.error ?? "No stream found for this episode");
        } else {
          setError(null);
        }

      } catch (err: any) {
        if (err.name === "AbortError") {
          console.warn("[useStreamUrl] Aborted (timeout or navigation)");
          if (!controller.signal.aborted) {
            setError("Request timed out. Please try again.");
          }
          return;
        }

        console.error("[useStreamUrl] Fetch error:", err.message);

        if (!controller.signal.aborted) {
          setError(err.message ?? "Unknown error fetching stream");
        }
      } finally {
        clearTimeout(timeoutId);
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    fetchStream();

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };

    // Re-fetch whenever any of these change
  }, [malId, episode, lang, season]); // intentionally omit `title` — cosmetic only

  return {
    streamUrl,
    subtitles,
    streamHeaders,
    loading,
    error,
    intro,
    outro,
    sourceLabel,
  };
}
