// src/hooks/useStreamUrl.ts
import { useState, useEffect } from "react";

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
  intro:         null;
  outro:         null;
  sourceLabel:   string | null;
}

export function useStreamUrl(
  title:   string | null,
  episode: number,
  lang:    "sub" | "dub",
  malId?:  number,
): StreamResult {
  const [streamUrl,     setStreamUrl]     = useState<string | null>(null);
  const [subtitles,     setSubtitles]     = useState<SubtitleTrack[]>([]);
  const [streamHeaders, setStreamHeaders] = useState<StreamHeaders>({});
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [sourceLabel,   setSourceLabel]   = useState<string | null>(null);

  useEffect(() => {
    if (!title) return;

    let cancelled = false;

    async function fetchStream() {
      setLoading(true);
      setError(null);
      setStreamUrl(null);
      setSubtitles([]);
      setStreamHeaders({});
      setSourceLabel(null);

      try {
        const params = new URLSearchParams({
          title:   title!,
          episode: String(episode),
          lang,
          ...(malId ? { malId: String(malId) } : {}),
        });

        const res = await fetch(`/api/stream?${params}`);

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `API error ${res.status}`);
        }

        const data = await res.json();

        if (!cancelled) {
          setStreamUrl(   data.url      ?? null);
          setSubtitles(   data.subtitles ?? []);
          setSourceLabel( data.source   ?? null);
          setStreamHeaders({
            referer: data.referer,
            headers: data.headers,
          });

          if (!data.url) {
            setError(data.error ?? "No stream URL returned");
          }
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchStream();
    return () => { cancelled = true; };
  }, [title, episode, lang, malId]);

  return {
    streamUrl,
    subtitles,
    streamHeaders,
    loading,
    error,
    intro:       null,
    outro:       null,
    sourceLabel,
  };
}
