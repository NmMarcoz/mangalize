import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, X } from "lucide-react";

import { ChapterSidebar } from "@/components/ChapterSidebar";
import { EmptyState } from "@/components/EmptyState";
import { MetadataPanel } from "@/components/MetadataPanel";
import { PageGrid, type PageGroup } from "@/components/PageGrid";
import { Toolbar } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  buildVolume,
  scanFolder,
  suggestFilename,
  effectiveCover,
  volumePageCount,
  type BuildReport,
  type Format,
  type Metadata,
  type Page,
  type Volume,
} from "@/lib/api";
import { clearThumbnails } from "@/lib/thumbs";

export default function App() {
  const [volume, setVolume] = useState<Volume | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeChapter, setActiveChapter] = useState<number | null>(null);
  const [showExcluded, setShowExcluded] = useState(true);
  const [thumbWidth, setThumbWidth] = useState(150);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const [format, setFormat] = useState<Format>("epub");
  const [building, setBuilding] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<BuildReport | null>(null);

  /* ---------------------------------------------------------------- scanning */

  const runScan = useCallback(async (path: string) => {
    setScanning(true);
    setError(null);
    try {
      const next = await scanFolder(path);
      // Thumbnails are keyed by path; a different folder invalidates all of them.
      clearThumbnails();
      setVolume(next);
      setActiveChapter(null);
      setSelection(new Set());
      setAnchor(null);
      setReport(null);
      if (next.chapters.length === 0) {
        setError("No images found in that folder.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  const pickFolder = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") await runScan(picked);
  }, [runScan]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          const first = event.payload.paths[0];
          if (first) void runScan(first);
        } else {
          setDragging(false);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runScan]);

  useEffect(() => {
    const pending = listen<{ done: number; total: number }>("build-progress", (e) => {
      // Ignore stragglers that arrive after the build promise resolved.
      setBuilding((prev) => (prev ? e.payload : null));
    });
    return () => {
      void pending.then((fn) => fn());
    };
  }, []);

  /* ---------------------------------------------------------------- derived */

  const groups = useMemo<PageGroup[]>(() => {
    if (!volume) return [];
    const scope =
      activeChapter === null
        ? volume.chapters.map((chapter, chapterIndex) => ({ chapter, chapterIndex }))
        : [{ chapter: volume.chapters[activeChapter], chapterIndex: activeChapter }];

    return scope
      .filter((g) => g.chapter)
      .map(({ chapter, chapterIndex }) => ({
        chapterIndex,
        chapter,
        pages: showExcluded
          ? chapter.pages
          : chapter.pages.filter((p) => p.excluded === null),
      }))
      .filter((g) => g.pages.length > 0);
  }, [volume, activeChapter, showExcluded]);

  const visiblePaths = useMemo(
    () => groups.flatMap((g) => g.pages.map((p) => p.path)),
    [groups],
  );

  /**
   * Position of each page in the exported volume, numbered across chapters.
   *
   * A split spread occupies two output pages, so it advances the counter twice;
   * the badge shows the first of the pair.
   */
  const numbers = useMemo(() => {
    const map = new Map<string, number>();
    if (!volume) return map;
    let n = 0;
    for (const chapter of volume.chapters) {
      for (const page of chapter.pages) {
        if (page.excluded !== null) continue;
        map.set(page.path, ++n);
        if (page.kind === "spread" && page.split) n += 1;
      }
    }
    return map;
  }, [volume]);

  const allPages = useMemo(
    () => volume?.chapters.flatMap((c) => c.pages) ?? [],
    [volume],
  );

  /* ---------------------------------------------------------------- editing */

  const mutate = useCallback((paths: string[], fn: (page: Page) => Page) => {
    const targets = new Set(paths);
    setVolume((current) =>
      current
        ? {
            ...current,
            chapters: current.chapters.map((chapter) => ({
              ...chapter,
              pages: chapter.pages.map((page) =>
                targets.has(page.path) ? fn(page) : page,
              ),
            })),
          }
        : current,
    );
  }, []);

  const toggleExclude = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const targets = new Set(paths);
      const touched = allPages.filter((p) => targets.has(p.path));
      // Mixed selections resolve to excluding, which is the less destructive
      // reading of "toggle" here: nothing is lost, it can be brought back.
      const excluding = touched.some((p) => p.excluded === null);

      mutate(paths, (page) => {
        // An unreadable file cannot be restored; including it would fail export.
        if (!excluding && page.excluded?.reason === "unreadable") return page;
        return { ...page, excluded: excluding ? { reason: "manual" } : null };
      });
    },
    [allPages, mutate],
  );

  const toggleSplit = useCallback(
    (paths: string[]) => {
      const targets = new Set(paths);
      const spreads = allPages.filter(
        (p) => targets.has(p.path) && p.kind === "spread",
      );
      if (spreads.length === 0) return;
      const splitting = spreads.some((p) => !p.split);
      mutate(
        spreads.map((p) => p.path),
        (page) => ({ ...page, split: splitting }),
      );
    },
    [allPages, mutate],
  );

  const setCover = useCallback((path: string) => {
    setVolume((current) => (current ? { ...current, cover: path } : current));
  }, []);

  const patchMetadata = useCallback((patch: Partial<Metadata>) => {
    setVolume((current) =>
      current ? { ...current, metadata: { ...current.metadata, ...patch } } : current,
    );
  }, []);

  const handleSelect = useCallback(
    (path: string, event: React.MouseEvent) => {
      if (event.shiftKey && anchor) {
        const from = visiblePaths.indexOf(anchor);
        const to = visiblePaths.indexOf(path);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          const range = visiblePaths.slice(lo, hi + 1);
          setSelection((prev) => new Set([...prev, ...range]));
          return;
        }
      }
      if (event.metaKey || event.ctrlKey) {
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        setAnchor(path);
        return;
      }
      setSelection(new Set([path]));
      setAnchor(path);
    },
    [anchor, visiblePaths],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!volume) return;

      if (event.key === "Escape") {
        setSelection(new Set());
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelection(new Set(visiblePaths));
        return;
      }

      const selected = [...selection];
      if (selected.length === 0) return;

      switch (event.key.toLowerCase()) {
        case "x":
          event.preventDefault();
          toggleExclude(selected);
          break;
        case "s":
          event.preventDefault();
          toggleSplit(selected);
          break;
        case "c":
          event.preventDefault();
          setCover(selected[0]);
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [volume, selection, visiblePaths, toggleExclude, toggleSplit, setCover]);

  /* ---------------------------------------------------------------- export */

  const handleExport = useCallback(async () => {
    if (!volume) return;
    setError(null);
    try {
      const suggested = await suggestFilename(volume, format);
      const out = await save({
        defaultPath: suggested,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!out) return;

      setReport(null);
      setBuilding({ done: 0, total: volumePageCount(volume) });
      const result = await buildVolume(volume, out, format);
      setReport(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBuilding(null);
    }
  }, [volume, format]);

  const pickCover = useCallback(async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif"] }],
    });
    if (typeof picked === "string") setCover(picked);
  }, [setCover]);

  /* ---------------------------------------------------------------- render */

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        {volume && volume.chapters.length > 0 ? (
          <>
            <Toolbar
              volume={volume}
              format={format}
              showExcluded={showExcluded}
              thumbWidth={thumbWidth}
              building={building}
              report={report}
              scanning={scanning}
              onFormat={setFormat}
              onShowExcluded={setShowExcluded}
              onThumbWidth={setThumbWidth}
              onOpenFolder={pickFolder}
              onRescan={() => void runScan(volume.root)}
              onExport={() => void handleExport()}
              onReveal={() => report && void revealItemInDir(report.path)}
            />

            <div className="flex min-h-0 flex-1">
              <ChapterSidebar
                volume={volume}
                active={activeChapter}
                onSelect={(index) => {
                  setActiveChapter(index);
                  setSelection(new Set());
                }}
              />

              <main
                className="scrollbar-thin min-w-0 flex-1 overflow-y-auto"
                onClick={(e) => {
                  // A click on the backdrop clears the selection.
                  if (e.target === e.currentTarget) setSelection(new Set());
                }}
              >
                <PageGrid
                  groups={groups}
                  numbers={numbers}
                  selection={selection}
                  coverPath={effectiveCover(volume)}
                  thumbWidth={thumbWidth}
                  showHeaders={activeChapter === null}
                  onSelect={handleSelect}
                  onToggleExclude={toggleExclude}
                  onToggleSplit={toggleSplit}
                  onSetCover={setCover}
                />
              </main>

              <MetadataPanel
                volume={volume}
                onChange={patchMetadata}
                onPickCover={() => void pickCover()}
                onClearCover={() =>
                  setVolume((c) => (c ? { ...c, cover: null } : c))
                }
              />
            </div>
          </>
        ) : (
          <EmptyState
            dragging={dragging}
            scanning={scanning}
            error={error}
            onOpenFolder={() => void pickFolder()}
          />
        )}

        {dragging && volume && (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="rounded-xl border-2 border-dashed border-primary px-10 py-8 text-center">
              <p className="text-sm font-medium">Drop to open this folder</p>
            </div>
          </div>
        )}

        {error && volume && (
          <div className="absolute bottom-4 left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1" data-selectable>
              {error}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-my-0.5 shrink-0"
              onClick={() => setError(null)}
            >
              <X className="size-3" />
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
