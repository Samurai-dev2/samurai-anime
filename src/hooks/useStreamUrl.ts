// src/hooks/useStreamUrl.ts
import { useState, useEffect } from "react";

export interface SubtitleTrack {
  url:    string;
  lang:   string;
  label?: string;
}

export interface IntroOutro {
  start: number;
  end:   number;
}

interface StreamResult {
  streamUrl:    string | null;
  subtitles:    SubtitleTrack[];
  loading:      boolean;
  error:        string | null;
  intro:        IntroOutro | null;
  outro:        IntroOutro | null;
  sourceLabel:  string | null;
}

export function useStreamUrl(
  title:   string | null,
  episode: number,
  lang:    "sub" | "dub",
  malId?:  number,
): StreamResult {
  const [streamUrl,   setStreamUrl]   = useState<string | null>(null);
  const [subtitles,   setSubtitles]   = useState<SubtitleTrack[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [intro,       setIntro]       = useState<IntroOutro | null>(null);
  const [outro,       setOutro]       = useState<IntroOutro | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!title) return;

    let cancelled = false;

    async function fetchStream() {
      setLoading(true);
      setError(null);
      setStreamUrl(null);
      setSubtitles([]);
      setIntro(null);
      setOutro(null);
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
          setStreamUrl(data.url         ?? null);
          setSubtitles(data.subtitles   ?? []);
          setIntro(    data.intro       ?? null);
          setOutro(    data.outro       ?? null);
          setSourceLabel(data.source    ?? null);

          if (!data.url) {
            setError("No stream URL returned");
          }
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message ?? "Unknown error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchStream();
    return () => { cancelled = true; };
  }, [title, episode, lang, malId]);

  return { streamUrl, subtitles, loading, error, intro, outro, sourceLabel };
}
