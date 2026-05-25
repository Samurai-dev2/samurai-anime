// src/hooks/useStreamUrl.ts
import { useState, useEffect, useRef } from "react";

export interface SubtitleTrack {
  url: string;
  lang: string;
  label: string;
}

export interface StreamHeaders {
  referer?: string;
  headers?: Record<string, string>;
}

interface StreamResult {
  streamUrl: string | null;
  subtitles: SubtitleTrack[];
  streamHeaders: StreamHeaders;
  loading: boolean;
  error: string | null;
  intro: null;
  outro: null;
  sourceLabel: string | null;
}

export function useStreamUrl(
  title: string | null,
  episode: number,
  lang: "sub" | "dub",
  malId?: number,
  season?: number
): StreamResult {
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [streamHeaders, setStreamHeaders] = useState<StreamHeaders>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);

  // Track in-flight request to cancel it on re-render
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!title) {
      setStreamUrl(null);
      setSubtitles([]);
      setStreamHeaders({});
      setSourceLabel(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Cancel any previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    async function fetchStream() {
      setLoading(true);
      setError(null);
      setStreamUrl(null);
      setSubtitles([]);
      setStreamHeaders({});
      setSourceLabel(null);

      try {
        const params = new URLSearchParams({
          title,
          episode: String(episode),
          lang,
          season: String(season ?? 1),
          ...(malId != null ? { malId: String(malId) } : {}),
        });

        const res = await fetch(`/api/stream?${params}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`Stream API returned ${res.status}`);
        }

        const data = await res.json();

        setStreamUrl(data.url ?? null);
        setSubtitles(data.subtitles ?? []);
        setSourceLabel(data.source ?? null);
        setStreamHeaders({
          referer: data.referer,
          headers: data.headers,
        });

        if (!data.url) {
          setError(data.error ?? "No stream returned from server");
        }
      } catch (err: any) {
        if (err.name === "AbortError") return; // component unmounted / deps changed
        setError(err.message ?? "Unknown error fetching stream");
      } finally {
        // Only clear loading if this request wasn't aborted
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    fetchStream();

    return () => {
      controller.abort();
    };
  }, [title, episode, lang, malId, season]);

  return {
    streamUrl,
    subtitles,
    streamHeaders,
    loading,
    error,
    intro: null,
    outro: null,
    sourceLabel,
  };
}
