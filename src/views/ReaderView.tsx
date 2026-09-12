import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Settings2,
} from "lucide-react";

import { ReaderSettings } from "@/components/ReaderSettings";
import { Button } from "@/components/ui/button";
import {
  cachedPage,
  clearPages,
  loadPage,
  loadPrefs,
  readerChapter,
  savePrefs,
  saveReadingProgress,
  type FitMode,
  type ReaderChapter,
  type ReaderPrefs,
} from "@/lib/reader";
import { cn } from "@/lib/utils";

interface ReaderViewProps {
  seriesId: number;
  chapter: string;
  /** Move to another chapter of the same series without leaving the reader. */
  onChapter: (chapter: string) => void;
  onExit: () => void;
  onError: (message: string | null) => void;
}

/** How many pages either side of the current one to decode ahead of time. */
const PRELOAD = 2;

/** How long to sit still before writing the reading position. */
const SAVE_DELAY = 600;

/**
 * The reader.
 *
 * Three shapes because manga is drawn in three: single pages, facing pairs, and
 * the unbroken vertical strip a webtoon is. Direction comes from the series, so
 * a right-to-left title turns the way it was drawn to without being told.
 *
 * Position is written back as you go, debounced, so closing the window mid
 * chapter and coming back lands on the page you left.
 */
export function ReaderView({
  seriesId,
  chapter,
  onChapter,
  onExit,
  onError,
}: ReaderViewProps) {
  const [loaded, setLoaded] = useState<ReaderChapter | null>(null);
  const [page, setPage] = useState(0);
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs);
  const [showChrome, setShowChrome] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  const scroller = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number | null>(null);

  const rtl = (prefs.direction ?? loaded?.direction) === "right-to-left";
  const total = loaded?.pages.length ?? 0;

  /* ------------------------------------------------------------- loading */

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    onError(null);

    readerChapter(seriesId, chapter)
      .then((found) => {
        if (cancelled) return;
        setLoaded(found);
        setPage(found.last_page);
      })
      .catch((e) => {
        if (!cancelled) onError(String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [seriesId, chapter, onError]);

  // Decoded pages are large; holding a whole series' worth would be a leak.
  useEffect(() => clearPages, []);

  // Decode a little ahead so a page turn is instant rather than a flash of
  // nothing. Backwards too: re-reading a panel is as common as moving on.
  useEffect(() => {
    if (!loaded) return;
    for (let offset = -PRELOAD; offset <= PRELOAD; offset += 1) {
      const target = loaded.pages[page + offset];
      if (target) void loadPage(target).catch(() => {});
    }
  }, [loaded, page]);

  /* ------------------------------------------------------------ progress */

  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);

    // The last page counts as finished: nothing else marks it, and requiring a
    // separate action to say "done" is the sort of bookkeeping nobody does.
    const finished = page >= loaded.pages.length - 1;
    saveTimer.current = window.setTimeout(() => {
      void saveReadingProgress(seriesId, loaded.number, page, finished).catch(() => {});
    }, SAVE_DELAY);

    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [seriesId, loaded, page]);

  // Leaving mid-page would otherwise lose up to SAVE_DELAY of progress.
  useEffect(() => {
    return () => {
      if (!loaded) return;
      void saveReadingProgress(
        seriesId,
        loaded.number,
        page,
        page >= loaded.pages.length - 1,
      ).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, page]);

  /* ----------------------------------------------------------- navigation */

  const step = prefs.mode === "double" ? 2 : 1;

  const advance = useCallback(
    (delta: number) => {
      if (!loaded) return;
      const next = page + delta * step;

      if (next < 0) {
        if (loaded.previous) onChapter(loaded.previous);
        return;
      }
      if (next >= loaded.pages.length) {
        if (loaded.next) onChapter(loaded.next);
        return;
      }
      setPage(next);

      if (prefs.mode === "webtoon") {
        scroller.current
          ?.querySelector(`[data-page="${next}"]`)
          ?.scrollIntoView({ behavior: "auto", block: "start" });
      }
    },
    [loaded, page, step, prefs.mode, onChapter],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.isContentEditable)) return;

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
    if (!loaded) return [];
    if (prefs.mode !== "double") return [page];
    // Facing pair. In a right-to-left book the earlier page sits on the right.
    const pair = [page, page + 1].filter((i) => i < loaded.pages.length);
    return rtl ? pair.reverse() : pair;
  }, [loaded, page, prefs.mode, rtl]);

  if (!loaded) {
    return (
      <div className={cn("flex h-full items-center justify-center", surface)}>
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
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
            <p className="truncate text-sm font-medium">{loaded.series_title}</p>
            <p className="truncate text-[11px] text-white/60">
              Chapter {loaded.number}
              {loaded.title ? ` · ${loaded.title}` : ""}
            </p>
          </div>
          <span className="shrink-0 font-mono text-xs text-white/70">
            {page + 1} / {total}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="text-white"
            onClick={() => setShowSettings((open) => !open)}
          >
            <Settings2 />
          </Button>
        </header>
      )}

      {prefs.mode === "webtoon" ? (
        <WebtoonPages
          ref={scroller}
          chapter={loaded}
          fit={prefs.fit}
          onVisiblePage={setPage}
          onToggleChrome={() => setShowChrome((v) => !v)}
        />
      ) : (
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          onClick={(event) => {
            // Thirds: outer edges turn, the middle shows and hides the chrome.
            const { left, width } = event.currentTarget.getBoundingClientRect();
            const position = (event.clientX - left) / width;
            if (position < 0.33) advance(rtl ? 1 : -1);
            else if (position > 0.67) advance(rtl ? -1 : 1);
            else setShowChrome((v) => !v);
          }}
        >
          {visible.map((index) => (
            <PageImage
              key={loaded.pages[index]}
              path={loaded.pages[index]}
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
            title={loaded.previous ? "Previous page or chapter" : "Previous page"}
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
            title={loaded.next ? "Next page or chapter" : "Next page"}
          >
            {rtl ? <ChevronLeft /> : <ChevronRight />}
          </Button>
        </footer>
      )}

      {showSettings && (
        <ReaderSettings
          prefs={prefs}
          seriesDirection={loaded.direction}
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
  path,
  fit,
  paired,
}: {
  path: string;
  fit: FitMode;
  paired: boolean;
}) {
  const [url, setUrl] = useState<string | undefined>(() => cachedPage(path));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const hit = cachedPage(path);
    setUrl(hit);
    setFailed(false);
    if (hit) return;

    let cancelled = false;
    loadPage(path)
      .then((next) => !cancelled && setUrl(next))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-white/50">
        This page could not be opened.
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
  chapter: ReaderChapter;
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
      {chapter.pages.map((path, index) => (
        <div key={path} data-page={index} className="w-full max-w-4xl">
          <LazyStripPage path={path} fit={fit} />
        </div>
      ))}
    </div>
  );
}

/**
 * A strip page, decoded only once it is near the viewport.
 *
 * A long webtoon chapter is a hundred tall images; decoding them all up front
 * would stall for seconds and hold a great deal of memory.
 */
function LazyStripPage({ path, fit }: { path: string; fit: FitMode }) {
  const [url, setUrl] = useState<string | undefined>(() => cachedPage(path));
  const holder = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (url) return;
    const node = holder.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void loadPage(path).then(setUrl).catch(() => {});
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [path, url]);

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
