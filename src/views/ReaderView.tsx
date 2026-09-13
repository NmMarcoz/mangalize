import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Cloud,
  ExternalLink,
  Loader2,
  Settings2,
  TriangleAlert,
} from "lucide-react";

import { ReaderSettings } from "@/components/ReaderSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  cachedPage,
  clearPages,
  loadPage,
  loadPrefs,
  readerChapter,
  readerOnlineChapter,
  readerTrackOnline,
  savePrefs,
  saveReadingProgress,
  type FitMode,
  type ReaderPrefs,
  type ReaderTarget,
} from "@/lib/reader";
import { isMobile } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface ReaderViewProps {
  target: ReaderTarget;
  /** Move to another chapter without leaving the reader. */
  onNavigate: (target: ReaderTarget) => void;
  onExit: () => void;
}

/** How many pages either side of the current one to fetch ahead of time. */
const PRELOAD = 2;

/** How long to sit still before writing the reading position. */
const SAVE_DELAY = 600;

/** Pixels a touch must travel across the page before it counts as a turn. */
const SWIPE_MIN = 50;

/**
 * A chapter, flattened to the handful of things the reader draws.
 *
 * Both sources normalise to this, so nothing below here branches on where the
 * pages came from except to decide who to ask for the bytes.
 */
interface OpenChapter {
  seriesTitle: string;
  number: string;
  title: string | null;
  direction: string;
  /** File paths when local, URLs when streamed. */
  pages: string[];
  online: boolean;
  startPage: number;
  previous: ReaderTarget | null;
  next: ReaderTarget | null;
  /** Where to record progress. Absent for a series not in the library. */
  progress: { seriesId: number; chapter: string } | null;
}

/**
 * The reader.
 *
 * Three layouts, because manga is drawn in three shapes: single pages, facing
 * pairs, and the unbroken vertical strip a webtoon is. Direction comes from the
 * series, so a right-to-left title turns the way it was drawn to.
 *
 * Reads from the library or straight from the source. Streaming is what makes
 * sampling a series possible without committing a few hundred megabytes to it,
 * and a chapter read that way can be downloaded afterwards if it is worth
 * keeping.
 */
export function ReaderView({ target, onNavigate, onExit }: ReaderViewProps) {
  const [open, setOpen] = useState<OpenChapter | null>(null);
  /**
   * Why the chapter could not be shown.
   *
   * Kept here rather than pushed to the app's error toast: the reader fills the
   * window, and a chapter that will not open has to say so *and* offer a way
   * out in the same place. An endless spinner is not a failure state.
   */
  const [failure, setFailure] = useState<{
    message: string;
    externalUrl: string | null;
  } | null>(null);
  const [page, setPage] = useState(0);
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs);
  const [showChrome, setShowChrome] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  const scroller = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number | null>(null);

  const rtl = (prefs.direction ?? open?.direction) === "right-to-left";
  const total = open?.pages.length ?? 0;

  /* ------------------------------------------------------------- loading */

  useEffect(() => {
    let cancelled = false;
    setOpen(null);
    setFailure(null);

    const run = async () => {
      if (target.kind === "library") {
        const found = await readerChapter(target.seriesId, target.chapter);
        if (cancelled) return;
        setOpen({
          seriesTitle: found.series_title,
          number: found.number,
          title: found.title,
          direction: found.direction,
          pages: found.pages,
          online: false,
          startPage: found.last_page,
          previous: found.previous
            ? { kind: "library", seriesId: target.seriesId, chapter: found.previous }
            : null,
          next: found.next
            ? { kind: "library", seriesId: target.seriesId, chapter: found.next }
            : null,
          progress: { seriesId: target.seriesId, chapter: found.number },
        });
        setPage(found.last_page);
        return;
      }

      const found = await readerOnlineChapter(target.source, target.chapterId);
      if (cancelled) return;

      // Not an error: the source indexes the chapter but the publisher hosts
      // it. Nothing in the chapter list marks this reliably, so it can only be
      // discovered by asking, and the honest response is to say where it lives.
      if (found.pages.length === 0) {
        setFailure({
          message: found.message ?? "This chapter has no pages.",
          externalUrl: found.external_url,
        });
        return;
      }

      const sibling = (at: { id: string; number: string } | null): ReaderTarget | null =>
        at
          ? { ...target, chapterId: at.id, chapterNumber: at.number, kind: "online" }
          : null;

      // Recorded whether or not the series is in the library, so history is
      // the same question however the pages were reached. Failing to record is
      // not worth refusing to read over — it costs the history entry, nothing
      // more.
      const seriesId = await readerTrackOnline({
        source: target.source,
        seriesSourceId: target.seriesSourceId,
        title: target.seriesTitle,
        coverUrl: target.coverUrl,
        chapter: target.chapterNumber,
        chapterSourceId: target.chapterId,
        pages: found.pages.length,
      }).catch(() => target.librarySeriesId);
      if (cancelled) return;

      setOpen({
        seriesTitle: target.seriesTitle,
        number: target.chapterNumber,
        title: null,
        direction: target.direction,
        pages: found.pages,
        online: true,
        startPage: 0,
        previous: sibling(target.previous),
        next: sibling(target.next),
        progress: seriesId ? { seriesId, chapter: target.chapterNumber } : null,
      });
      setPage(0);
    };

    run().catch((e) => {
      if (!cancelled) setFailure({ message: String(e), externalUrl: null });
    });

    return () => {
      cancelled = true;
    };
  }, [target]);

  // Decoded pages are large; holding a whole series' worth would be a leak.
  useEffect(() => clearPages, []);

  // Fetch a little ahead so a page turn is instant rather than a flash of
  // nothing. Backwards too: re-reading a panel is as common as moving on. This
  // matters far more when streaming, where a miss is a round trip.
  useEffect(() => {
    if (!open) return;
    for (let offset = -PRELOAD; offset <= PRELOAD; offset += 1) {
      const source = open.pages[page + offset];
      if (source) void loadPage(source, open.online).catch(() => {});
    }
  }, [open, page]);

  /* ------------------------------------------------------------ progress */

  const record = useCallback(
    (chapter: OpenChapter, at: number) => {
      if (!chapter.progress) return;
      // The last page counts as finished: nothing else marks it, and requiring
      // a separate action to say "done" is bookkeeping nobody does.
      const finished = at >= chapter.pages.length - 1;
      void saveReadingProgress(
        chapter.progress.seriesId,
        chapter.progress.chapter,
        at,
        finished,
      ).catch(() => {});
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => record(open, page), SAVE_DELAY);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [open, page, record]);

  // Leaving mid-page would otherwise lose up to SAVE_DELAY of progress.
  useEffect(() => {
    return () => {
      if (open) record(open, page);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, page]);

  /* ----------------------------------------------------------- navigation */

  const step = prefs.mode === "double" ? 2 : 1;

  const advance = useCallback(
    (delta: number) => {
      if (!open) return;
      const next = page + delta * step;

      if (next < 0) {
        if (open.previous) onNavigate(open.previous);
        return;
      }
      if (next >= open.pages.length) {
        if (open.next) onNavigate(open.next);
        return;
      }
      setPage(next);

      if (prefs.mode === "webtoon") {
        scroller.current
          ?.querySelector(`[data-page="${next}"]`)
          ?.scrollIntoView({ behavior: "auto", block: "start" });
      }
    },
    [open, page, step, prefs.mode, onNavigate],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const node = event.target as HTMLElement | null;
      if (node && (node.tagName === "INPUT" || node.isContentEditable)) return;

      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onExit();
          break;
        case "ArrowRight":
          event.preventDefault();
          // In a right-to-left book the right-hand side is where you came from.
          advance(rtl ? -1 : 1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          advance(rtl ? 1 : -1);
          break;
        case "ArrowDown":
        case " ":
          if (prefs.mode !== "webtoon") {
            event.preventDefault();
            advance(1);
          }
          break;
        case "ArrowUp":
          if (prefs.mode !== "webtoon") {
            event.preventDefault();
            advance(-1);
          }
          break;
        case "Home":
          event.preventDefault();
          setPage(0);
          break;
        case "End":
          event.preventDefault();
          setPage(Math.max(0, total - 1));
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, onExit, rtl, prefs.mode, total]);

  // Where a touch started, and whether the gesture that just ended was a swipe
  // rather than a tap. Refs because neither ever needs to paint anything.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);

  const patchPrefs = useCallback((patch: Partial<ReaderPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  /* --------------------------------------------------------------- render */

  const surface =
    prefs.background === "white"
      ? "bg-white"
      : prefs.background === "grey"
        ? "bg-neutral-800"
        : "bg-black";

  const visible = useMemo(() => {
    if (!open) return [];
    if (prefs.mode !== "double") return [page];
    // Facing pair. In a right-to-left book the earlier page sits on the right.
    const pair = [page, page + 1].filter((i) => i < open.pages.length);
    return rtl ? pair.reverse() : pair;
  }, [open, page, prefs.mode, rtl]);

  // Loading and failure both need the way out. Being unable to leave a screen
  // that will never finish is worse than the thing that went wrong.
  if (!open) {
    return (
      <div className={cn("relative flex h-full flex-col", surface)}>
        <header className="flex items-center gap-3 bg-black/70 px-4 py-2.5 text-white">
          <Button variant="ghost" size="icon" onClick={onExit} className="text-white">
            <ArrowLeft />
          </Button>
          <p className="flex-1 truncate text-sm font-medium">
            {target.kind === "online" ? target.seriesTitle : "Opening chapter"}
          </p>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          {failure ? (
            <div className="max-w-md text-center">
              <TriangleAlert className="mx-auto size-7 text-amber-500" />
              <h2 className="mt-3 text-sm font-medium text-white">
                This chapter cannot be read here
              </h2>
              {/* The message ends in a publisher URL, which has no spaces in
                  it to wrap at and runs off both edges of a phone without this. */}
              <p className="mt-1.5 break-words text-xs leading-relaxed text-white/60">
                {failure.message}
              </p>

              <div className="mt-5 flex items-center justify-center gap-2">
                <Button variant="outline" onClick={onExit}>
                  <ArrowLeft />
                  Go back
                </Button>
                {failure.externalUrl && (
                  <Button asChild>
                    <a
                      href={failure.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink />
                      Read at the publisher
                    </a>
                  </Button>
                )}
              </div>

              <p className="mt-4 text-[10px] text-white/35">
                {isMobile ? "Back also closes the reader." : "Esc also closes the reader."}
              </p>
            </div>
          ) : (
            <Loader2 className="size-5 animate-spin text-white/50" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative flex h-full flex-col", surface)}>
      {showChrome && (
        <header className="absolute inset-x-0 top-0 z-20 flex items-center gap-3 bg-black/70 px-4 py-2.5 text-white backdrop-blur-sm">
          <Button variant="ghost" size="icon" onClick={onExit} className="text-white">
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{open.seriesTitle}</p>
            <p className="truncate text-[11px] text-white/60">
              Chapter {open.number}
              {open.title ? ` · ${open.title}` : ""}
            </p>
          </div>
          {open.online && (
            <Badge variant="outline" className="shrink-0 border-white/30 text-white/70">
              <Cloud className="size-2.5" />
              streaming
            </Badge>
          )}
          <span className="shrink-0 font-mono text-xs text-white/70">
            {page + 1} / {total}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="text-white"
            onClick={() => setShowSettings((v) => !v)}
          >
            <Settings2 />
          </Button>
        </header>
      )}

      {prefs.mode === "webtoon" ? (
        <WebtoonPages
          ref={scroller}
          chapter={open}
          fit={prefs.fit}
          onVisiblePage={setPage}
          onToggleChrome={() => setShowChrome((v) => !v)}
        />
      ) : (
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          onClick={(event) => {
            // A swipe ends in a click too, and turning the page twice for one
            // gesture is worse than either behaviour on its own.
            if (swiped.current) {
              swiped.current = false;
              return;
            }
            // Thirds: outer edges turn, the middle shows and hides the chrome.
            const { left, width } = event.currentTarget.getBoundingClientRect();
            const position = (event.clientX - left) / width;
            if (position < 0.33) advance(rtl ? 1 : -1);
            else if (position > 0.67) advance(rtl ? -1 : 1);
            else setShowChrome((v) => !v);
          }}
          onTouchStart={(event) => {
            const touch = event.touches[0];
            swipe.current = { x: touch.clientX, y: touch.clientY };
          }}
          onTouchEnd={(event) => {
            const from = swipe.current;
            swipe.current = null;
            if (!from) return;
            const touch = event.changedTouches[0];
            const dx = touch.clientX - from.x;
            const dy = touch.clientY - from.y;
            // Mostly-horizontal and far enough to be deliberate. A drifting
            // thumb on a tap moves a few pixels in every direction.
            if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy)) return;
            swiped.current = true;
            // Dragging left pulls the next page in from the right, which is the
            // previous page in a right-to-left book.
            advance(dx < 0 ? (rtl ? -1 : 1) : rtl ? 1 : -1);
          }}
        >
          {visible.map((index) => (
            <PageImage
              key={open.pages[index]}
              source={open.pages[index]}
              online={open.online}
              fit={prefs.fit}
              paired={prefs.mode === "double" && visible.length > 1}
            />
          ))}
        </div>
      )}

      {showChrome && (
        <footer className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 bg-black/70 px-4 py-2.5 backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon"
            className="text-white"
            onClick={() => advance(rtl ? 1 : -1)}
          >
            {rtl ? <ChevronRight /> : <ChevronLeft />}
          </Button>

          {/* Reversed for a right-to-left book, so dragging right goes back. */}
          <input
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={page}
            onChange={(e) => setPage(Number(e.target.value))}
            className={cn(
              "h-1 flex-1 cursor-pointer appearance-none rounded-full bg-white/25 accent-primary",
              rtl && "[direction:rtl]",
            )}
          />

          <Button
            variant="ghost"
            size="icon"
            className="text-white"
            onClick={() => advance(rtl ? -1 : 1)}
          >
            {rtl ? <ChevronLeft /> : <ChevronRight />}
          </Button>
        </footer>
      )}

      {showSettings && (
        <ReaderSettings
          prefs={prefs}
          seriesDirection={open.direction}
          onChange={patchPrefs}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

/** Tailwind for each fit mode, shared by both layouts. */
function fitClass(fit: FitMode): string {
  switch (fit) {
    case "width":
      return "w-full h-auto";
    case "height":
      return "h-full w-auto";
    case "original":
      return "max-w-none";
    default:
      return "max-h-full max-w-full object-contain";
  }
}

function PageImage({
  source,
  online,
  fit,
  paired,
}: {
  source: string;
  online: boolean;
  fit: FitMode;
  paired: boolean;
}) {
  const [url, setUrl] = useState<string | undefined>(() => cachedPage(source, online));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const hit = cachedPage(source, online);
    setUrl(hit);
    setFailed(false);
    if (hit) return;

    let cancelled = false;
    loadPage(source, online)
      .then((next) => !cancelled && setUrl(next))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [source, online]);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-white/50">
        This page could not be opened.
        {online && (
          <>
            <br />
            The source may be rate limiting; try again in a moment.
          </>
        )}
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-white/40" />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      draggable={false}
      className={cn(fitClass(fit), paired && "max-w-[50%]")}
    />
  );
}

/** The continuous strip a webtoon is drawn as. */
function WebtoonPages({
  chapter,
  fit,
  onVisiblePage,
  onToggleChrome,
  ref,
}: {
  chapter: OpenChapter;
  fit: FitMode;
  onVisiblePage: (page: number) => void;
  onToggleChrome: () => void;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const container = useRef<HTMLDivElement | null>(null);

  // Which page is being looked at, so progress reflects scrolling rather than
  // only explicit page turns.
  useEffect(() => {
    const node = container.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (top) {
          const index = Number((top.target as HTMLElement).dataset.page);
          if (!Number.isNaN(index)) onVisiblePage(index);
        }
      },
      { root: node, threshold: [0.25, 0.5, 0.75] },
    );

    node.querySelectorAll("[data-page]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [chapter, onVisiblePage]);

  return (
    <div
      ref={(node) => {
        container.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.RefObject<HTMLDivElement | null>).current = node;
      }}
      onClick={onToggleChrome}
      className="scrollbar-thin flex min-h-0 flex-1 flex-col items-center overflow-y-auto"
    >
      {chapter.pages.map((source, index) => (
        <div key={source} data-page={index} className="w-full max-w-4xl">
          <LazyStripPage source={source} online={chapter.online} fit={fit} />
        </div>
      ))}
    </div>
  );
}

/**
 * A strip page, fetched only once it is near the viewport.
 *
 * A long webtoon chapter is a hundred tall images; loading them all up front
 * would stall for seconds and, when streaming, hammer the source for pages
 * nobody has scrolled to yet.
 */
function LazyStripPage({
  source,
  online,
  fit,
}: {
  source: string;
  online: boolean;
  fit: FitMode;
}) {
  const [url, setUrl] = useState<string | undefined>(() => cachedPage(source, online));
  const holder = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (url) return;
    const node = holder.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void loadPage(source, online)
          .then(setUrl)
          .catch(() => {});
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [source, online, url]);

  return (
    <div ref={holder} className="flex min-h-32 w-full items-center justify-center">
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className={cn("w-full", fit === "original" && "max-w-none")}
        />
      ) : (
        <Loader2 className="size-4 animate-spin text-white/30" />
      )}
    </div>
  );
}
