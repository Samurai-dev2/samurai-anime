// src/pages/WatchPage.tsx
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  ArrowLeft, ChevronLeft, ChevronRight,
  AlertTriangle, Loader2, List, RefreshCw,
} from "lucide-react";
import {
  LIBRARY_ANIME, AnimeEntry,
  saveContinueWatching, addToWatchHistory,
} from "../data/animeData";
import { useAnimeById }    from "../hooks/useJikan";
import { getAnimeMapping } from "../hooks/useFribbMapper";
import { useStreamUrl }    from "../hooks/useStreamUrl";
import VideoPlayer         from "../components/VideoPlayer";

type Lang = "sub" | "dub";

// ─── Episode List ─────────────────────────────────────────────
interface EpisodeListProps {
  total:          number;
  current:        number;
  season:         number;
  seasons:        number;
  onSelect:       (ep: number) => void;
  onSeasonChange: (s: number) => void;
}

function EpisodeList({
  total, current, season, seasons, onSelect, onSeasonChange,
}: EpisodeListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-ep="${current}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <div className="bg-gray-900/80 rounded-2xl border border-white/10 overflow-hidden">
      <div className="p-4 border-b border-white/10 flex items-center justify-between">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <List className="w-4 h-4 text-red-400" /> Episodes
        </h3>
        <select
          value={season}
          onChange={(e) => onSeasonChange(Number(e.target.value))}
          className="bg-black/40 border border-white/10 text-white text-sm rounded-lg px-2 py-1 focus:outline-none focus:border-red-500"
        >
          {Array.from({ length: Math.max(seasons, 1) }, (_, i) => i + 1).map((s) => (
            <option key={s} value={s}>Season {s}</option>
          ))}
        </select>
      </div>
      <div
        ref={listRef}
        className="max-h-80 overflow-y-auto p-3 grid grid-cols-5 sm:grid-cols-6 gap-1.5"
      >
        {Array.from({ length: total }, (_, i) => i + 1).map((ep) => (
          <button
            key={ep}
            data-ep={ep}
            onClick={() => onSelect(ep)}
            className={`h-10 rounded-lg text-sm font-medium transition-all ${
              ep === current
                ? "bg-red-600 text-white shadow-lg shadow-red-900/40"
                : "bg-white/5 hover:bg-white/15 text-gray-400 hover:text-white border border-white/5"
            }`}
          >
            {ep}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Sub / Dub Toggle ─────────────────────────────────────────
function LangToggle({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <div className="flex items-center rounded-lg overflow-hidden border border-white/10 text-xs font-semibold">
      <button
        onClick={() => onChange("sub")}
        className={`px-3 py-1.5 transition-colors ${
          lang === "sub"
            ? "bg-green-600 text-white"
            : "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
        }`}
      >
        SUB <span className="opacity-60 font-normal normal-case">JP</span>
      </button>
      <button
        onClick={() => onChange("dub")}
        className={`px-3 py-1.5 transition-colors ${
          lang === "dub"
            ? "bg-blue-600 text-white"
            : "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
        }`}
      >
        DUB <span className="opacity-60 font-normal normal-case">EN</span>
      </button>
    </div>
  );
}

// ─── Loading Screen ───────────────────────────────────────────
function LoadingScreen() {
  return (
    <div className="bg-black min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="w-10 h-10 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-gray-400 text-sm">Loading anime…</p>
      </div>
    </div>
  );
}

// ─── No Stream Screen ─────────────────────────────────────────
function NoStreamScreen({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="bg-black min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md text-center">
        <div className="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
          <AlertTriangle className="w-8 h-8 text-yellow-400" />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">No Stream Available</h2>
        <p className="text-gray-400 text-sm mb-6 leading-relaxed">
          We couldn't find a stream for this title right now. Please try again later.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-5 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-xl transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Go Back
          </button>
          <button
            onClick={() => navigate("/library")}
            className="flex items-center gap-2 px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl transition-colors"
          >
            Browse Library
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main WatchPage ───────────────────────────────────────────
export default function WatchPage() {
  const { malId }                       = useParams<{ malId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate                        = useNavigate();

  const id = parseInt(malId || "0");

  const localAnime = LIBRARY_ANIME.find((a) => a.malId === id) as AnimeEntry | undefined;
  const { data: jikanAnime, loading: jikanLoading } = useAnimeById(
    localAnime ? null : id,
  );

  const mapping      = getAnimeMapping(id);
  const movie        = mapping?.type?.toLowerCase() === "movie";

  const title =
    localAnime?.englishTitle  ||
    jikanAnime?.title_english ||
    jikanAnime?.title         ||
    "Anime";

  const totalEpisodes = movie ? 1 : (localAnime?.episodes || jikanAnime?.episodes || 24);
  const totalSeasons  = localAnime?.season || 1;
  const coverImage    =
    localAnime?.coverImage ||
    jikanAnime?.images?.jpg?.large_image_url ||
    "";

  // ── State ──────────────────────────────────────────────────
  const mappedSeason = mapping?.season ?? 1;

  const [season,        setSeason]     = useState(parseInt(searchParams.get("season")  || String(mappedSeason)));
  const [episode,       setEpisode]    = useState(parseInt(searchParams.get("episode") || "1"));
  const [lang,          setLang]       = useState<Lang>((searchParams.get("lang") as Lang) || "sub");
  const [showEpList,    setShowEpList] = useState(true);
  const [reloadKey,     setReloadKey]  = useState(0);

  // ── Stream ─────────────────────────────────────────────────
const {
  streamUrl,
  subtitles,
  streamHeaders,
  loading:     streamLoading,
  error:       streamError,
  sourceLabel,
} = useStreamUrl(
  title,
  episode,
  lang,
  id,
  season,   // ← add this
);
  // ── Sync URL + save progress ───────────────────────────────
  useEffect(() => {
    if (!id) return;
    addToWatchHistory(id);
    saveContinueWatching({
      malId: id, season, episode,
      timestamp: Date.now(), percent: 0,
    });
    setSearchParams(
      { season: String(season), episode: String(episode), lang },
      { replace: true },
    );
  }, [id, season, episode, lang, setSearchParams]);

  // ── Handlers ───────────────────────────────────────────────
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const handleLangChange = useCallback((l: Lang) => {
    setLang(l);
    setReloadKey((k) => k + 1);
  }, []);

  const prevEp = useCallback(() => {
    if (episode > 1)        setEpisode((e) => e - 1);
    else if (season > 1) { setSeason((s) => s - 1); setEpisode(1); }
  }, [episode, season]);

  const nextEp = useCallback(() => {
    if (episode < totalEpisodes)         setEpisode((e) => e + 1);
    else if (season < totalSeasons) { setSeason((s) => s + 1); setEpisode(1); }
  }, [episode, totalEpisodes, season, totalSeasons]);

  const selectEp     = useCallback((ep: number) => setEpisode(ep),     []);
  const selectSeason = useCallback((s: number)  => { setSeason(s); setEpisode(1); }, []);

  // ── Guards ─────────────────────────────────────────────────
  if (!id || isNaN(id)) {
    return (
      <div className="bg-black min-h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="w-8 h-8 text-yellow-400 mx-auto mb-3" />
          <p className="text-white font-semibold">Invalid anime ID</p>
          <button
            onClick={() => navigate(-1)}
            className="mt-4 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-xl text-sm"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  if (!localAnime && jikanLoading) return <LoadingScreen />;

  // ── UI ─────────────────────────────────────────────────────
  return (
    <div className="bg-black min-h-screen">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-20 pb-10">

        {/* ── Top bar ── */}
        <div className="flex items-center gap-4 mb-5 flex-wrap">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm"
          >
            <ArrowLeft className="w-5 h-5" /> Back
          </button>

          <div className="h-4 w-px bg-white/10" />

          <div className="min-w-0 flex-1">
            <span className="text-white font-semibold text-sm sm:text-base truncate">
              {title}
            </span>
            <span className="text-gray-500 text-sm ml-2">
              {movie ? "— Movie" : `— Season ${season}, Episode ${episode}`}
            </span>
          </div>

          {/* lang badge */}
          <span className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-widest ${
            lang === "dub"
              ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
              : "bg-green-500/20 text-green-400 border border-green-500/30"
          }`}>
            {lang === "dub" ? "🎙 EN Dub" : "🎌 JP Sub"}
          </span>

          {/* ad-free badge — always on now */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border bg-green-500/10 border-green-500/20 text-green-400">
            ✨ Ad-Free
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">

          {/* ── Left: Player ── */}
          <div>

            {/* ── Player area ── */}
            {streamLoading ? (
              <div className="aspect-video w-full bg-zinc-900/80 rounded-2xl ring-1 ring-white/10 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-10 h-10 text-red-500 animate-spin" />
                  <p className="text-gray-400 text-sm">Fetching stream…</p>
                  <p className="text-gray-600 text-xs">This may take a few seconds</p>
                </div>
              </div>

            ) : streamUrl ? (
              <VideoPlayer
                key={reloadKey}
                streamUrl={streamUrl}
                subtitles={subtitles}
                poster={coverImage}
                title={movie ? title : `${title} S${season}E${episode}`}
                referer={streamHeaders?.referer}
              />

            ) : (
              // Nothing found
              <div className="aspect-video w-full bg-zinc-900/80 rounded-2xl ring-1 ring-white/10 flex items-center justify-center">
                <div className="text-center px-6">
                  <AlertTriangle className="w-10 h-10 text-yellow-400 mx-auto mb-3" />
                  <p className="text-white font-semibold mb-1">Stream unavailable</p>
                  <p className="text-gray-400 text-sm mb-4">
                    {streamError ?? "Couldn't find a stream for this title right now."}
                  </p>
                  <button
                    onClick={reload}
                    className="flex items-center gap-2 mx-auto px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-sm font-semibold transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" /> Try Again
                  </button>
                </div>
              </div>
            )}

            {/* ── Controls ── */}
            <div className="mt-4 flex flex-wrap items-center gap-3">

              {/* prev / next */}
              {!movie && (
                <div className="flex gap-2">
                  <button
                    onClick={prevEp}
                    disabled={season === 1 && episode === 1}
                    className="flex items-center gap-1 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" /> Prev
                  </button>
                  <button
                    onClick={nextEp}
                    disabled={season >= totalSeasons && episode >= totalEpisodes}
                    className="flex items-center gap-1 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Next <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* sub / dub */}
              <LangToggle lang={lang} onChange={handleLangChange} />

              {/* utility */}
              <div className="ml-auto flex gap-2">
                <button
                  onClick={reload}
                  title="Reload player"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-gray-400 hover:text-white transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Reload
                </button>

                {!movie && (
                  <button
                    onClick={() => setShowEpList((s) => !s)}
                    className="lg:hidden flex items-center gap-1 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    <List className="w-3.5 h-3.5" /> Episodes
                  </button>
                )}
              </div>
            </div>

            {/* dub notice */}
            {lang === "dub" && (
              <div className="mt-3 flex items-start gap-2 p-3 bg-blue-500/5 border border-blue-500/10 rounded-xl text-xs text-blue-400">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <p>
                  Not all anime have an English dub. If Japanese audio plays,
                  a dub doesn't exist for this title yet.
                </p>
              </div>
            )}

            {/* status bar */}
            <div className="mt-3 p-3 bg-white/3 rounded-xl border border-white/5 text-xs text-gray-500">
              {streamLoading && (
                <span className="text-yellow-400">Fetching stream…</span>
              )}
              {streamUrl && !streamLoading && (
                <span>
                  <span className="text-green-400 font-medium">✓ Stream active</span>
                  {sourceLabel && (
                    <span className="text-gray-500"> via {sourceLabel}</span>
                  )}
                  {subtitles.length > 0 && (
                    <span className="text-gray-600">
                      {" "}— {subtitles.length} subtitle track{subtitles.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </span>
              )}
              {streamError && !streamUrl && !streamLoading && (
                <span className="text-red-400">Error: {streamError}</span>
              )}
            </div>

            {/* mobile episode list */}
            {!movie && showEpList && (
              <div className="lg:hidden mt-4">
                <EpisodeList
                  total={totalEpisodes} current={episode}
                  season={season}       seasons={totalSeasons}
                  onSelect={selectEp}   onSeasonChange={selectSeason}
                />
              </div>
            )}
          </div>

          {/* ── Right sidebar ── */}
          <div className="space-y-5">
            <div className="bg-gray-900/80 rounded-2xl border border-white/10 p-4 flex gap-4">
              {coverImage && (
                <img
                  src={coverImage}
                  alt={title}
                  className="w-16 h-24 rounded-xl object-cover flex-shrink-0"
                />
              )}
              <div className="min-w-0">
                <p className="text-white font-semibold text-sm leading-tight mb-1">{title}</p>
                <p className="text-gray-500 text-xs">
                  {movie ? "Movie" : `S${season} · E${episode} of ${totalEpisodes}`}
                </p>

                {/* badges */}
                <div className="inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border bg-green-500/15 text-green-400 border-green-500/20">
                  ✨ Ad-Free
                </div>

                <span className={`flex mt-1.5 w-fit items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                  lang === "dub"
                    ? "bg-blue-500/15 text-blue-400 border border-blue-500/20"
                    : "bg-green-500/15 text-green-400 border border-green-500/20"
                }`}>
                  {lang === "dub" ? "🎙 English Dub" : "🎌 Japanese Sub"}
                </span>

                {sourceLabel && (
                  <p className="text-gray-600 text-xs mt-2">
                    Source: <span className="text-gray-500">{sourceLabel}</span>
                  </p>
                )}

                <button
                  onClick={() => navigate(`/anime/${id}`)}
                  className="mt-2 text-red-400 text-xs hover:text-red-300 transition-colors"
                >
                  View Details →
                </button>
              </div>
            </div>

            {!movie && (
              <div className="hidden lg:block">
                <EpisodeList
                  total={totalEpisodes} current={episode}
                  season={season}       seasons={totalSeasons}
                  onSelect={selectEp}   onSeasonChange={selectSeason}
                />
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
