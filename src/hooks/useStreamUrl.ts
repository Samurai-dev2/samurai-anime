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
    // Need at least a malId to fetch
    if (!malId) {
      setStreamUrl(null);
      setError("No anime ID available");
      return;
    }

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
      setIntro(null);
      setOutro(null);

      try {
        const params = new URLSearchParams({
          malId:   String(malId),
          episode: String(episode),
          lang,
          season:  String(season ?? 1),
          ...(title ? { title } : {}),
        });

        const res = await fetch(`/api/stream?${params}`, {
          signal: controller.signal,
        });

        if (!res.ok) throw new Error(`Stream API returned ${res.status}`);

        const data = await res.json();

        if (!controller.signal.aborted) {
          setStreamUrl(  data.url       ?? null);
          setSubtitles(  data.subtitles ?? []);
          setSourceLabel(data.source    ?? null);
          setIntro(      data.intro     ?? null);
          setOutro(      data.outro     ?? null);
          setStreamHeaders({
            referer: data.referer,
            headers: data.headers,
          });
          if (!data.url) setError(data.error ?? "No stream returned");
        }
      } catch (err: any) {
        if (err.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setError(err.message ?? "Unknown error");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    fetchStream();
    return () => controller.abort();
  }, [malId, episode, lang, season]);

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
