import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { ChapterSidebar } from "@/components/ChapterSidebar";
import { MetadataDialog, type AppliedMetadata } from "@/components/MetadataDialog";
import { MetadataPanel } from "@/components/MetadataPanel";
import { PageGrid, type PageGroup } from "@/components/PageGrid";
import { Toolbar } from "@/components/Toolbar";
import {
  buildVolume,
  effectiveCover,
  suggestFilename,
  volumePageCount,
  withExtension,
  type BuildReport,
  type Format,
  type Metadata,
  type Page,
  type Volume,
} from "@/lib/api";
import { resolveBuildPath } from "@/lib/settings";
import { sendFiles } from "@/lib/send";

interface EditorViewProps {
  volume: Volume;
  setVolume: React.Dispatch<React.SetStateAction<Volume | null>>;
  scanning: boolean;
  onRescan: () => void;
  onOpenFolder: () => void;
  /** Return to wherever this volume came from: a series, or the library. */
  onBack: () => void;
  /** From settings; pre-selects the format for a freshly opened volume. */
  defaultFormat: string;
  onError: (message: string | null) => void;
}

/**
 * The volume editor: pick pages, split spreads, choose a cover, export.
 *
 * Reached two ways — from a scanned folder, or from a volume the library
 * assembled — and deliberately cannot tell the difference. Once there is a
 * `Volume`, everything downstream is the code that already existed.
 */
export function EditorView({
  volume,
  setVolume,
  scanning,
  onRescan,
  onOpenFolder,
  onBack,
  defaultFormat,
  onError,
}: EditorViewProps) {
  const [activeChapter, setActiveChapter] = useState<number | null>(null);
  const [showExcluded, setShowExcluded] = useState(true);
  const [thumbWidth, setThumbWidth] = useState(150);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const [lookupOpen, setLookupOpen] = useState(false);
  const [format, setFormat] = useState<Format>(defaultFormat as Format);
  const [building, setBuilding] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<BuildReport | null>(null);

  /** Empty means "use whatever the metadata suggests". */
  const [fileName, setFileName] = useState("");
  const [suggested, setSuggested] = useState("");
  const [sending, setSending] = useState(false);

  // A different volume means the previous one's selection is meaningless, and
  // an export name typed for it certainly is.
  useEffect(() => {
    setActiveChapter(null);
    setSelection(new Set());
    setAnchor(null);
    setReport(null);
    setFileName("");
  }, [volume.root]);

  /**
   * Keep the suggested name in step with the metadata.
   *
   * Derived in the backend rather than here so there is one definition of what
   * a volume file is called, shared with the CLI. Only the fields it actually
   * uses are watched, so typing a description does not re-derive it.
   */
  useEffect(() => {
    let cancelled = false;
    suggestFilename(volume, format)
      .then((name) => {
        if (!cancelled) setSuggested(name);
      })
      .catch(() => {
        if (!cancelled) setSuggested("");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume.metadata.series, volume.metadata.volume, format]);

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
    () => volume.chapters.flatMap((c) => c.pages),
    [volume],
  );

  /* ---------------------------------------------------------------- editing */

  const mutate = useCallback(
    (paths: string[], fn: (page: Page) => Page) => {
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
    },
    [setVolume],
  );

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

  const setCover = useCallback(
    (path: string) => {
      setVolume((current) => (current ? { ...current, cover: path } : current));
    },
    [setVolume],
  );

  /**
   * Merge a lookup result in without clobbering anything the user already typed
   * that the source had no value for.
   */
  const applyLookup = useCallback(
    (applied: AppliedMetadata) => {
      setVolume((current) =>
        current
          ? {
              ...current,
              cover: applied.cover ?? current.cover,
              metadata: {
                ...current.metadata,
                series: applied.series || current.metadata.series,
                author: applied.author || current.metadata.author,
                description: applied.description || current.metadata.description,
              },
            }
          : current,
      );
    },
    [setVolume],
  );

  const patchMetadata = useCallback(
    (patch: Partial<Metadata>) => {
      setVolume((current) =>
        current ? { ...current, metadata: { ...current.metadata, ...patch } } : current,
      );
    },
    [setVolume],
  );

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
  }, [selection, visiblePaths, toggleExclude, toggleSplit, setCover]);

  /* ---------------------------------------------------------------- export */

  /**
   * Write the volume out.
   *
   * `askWhere` is the difference between Build and Build as…. Build only asks
   * when there is no configured output folder to write to, so the common case
   * is one click.
   */
  const handleExport = useCallback(
    async (askWhere: boolean): Promise<BuildReport | null> => {
      onError(null);
      try {
        // What the user typed wins; the derived name is only ever a default.
        const chosen = fileName.trim()
          ? withExtension(fileName, format)
          : suggested || (await suggestFilename(volume, format));

        let out: string | null = null;
        if (!askWhere) {
          const configured = await resolveBuildPath(volume, format);
          // A typed name still applies, so replace only the last component.
          if (configured && fileName.trim()) {
            out = configured.replace(/[^/\\]+$/, chosen);
          } else {
            out = configured;
          }
        }

        if (!out) {
          out = await save({
            defaultPath: chosen,
            filters: [{ name: format.toUpperCase(), extensions: [format] }],
          });
        }
        if (!out) return null;

        setReport(null);
        setBuilding({ done: 0, total: volumePageCount(volume) });
        const result = await buildVolume(volume, out, format);
        setReport(result);
        return result;
      } catch (e) {
        onError(String(e));
        return null;
      } finally {
        setBuilding(null);
      }
    },
    [volume, format, fileName, suggested, onError],
  );

  /**
   * Build if needed, then mail the result.
   *
   * Reuses the last build when there is one — re-encoding a few hundred pages
   * just to attach them again would be a long wait for no difference.
   */
  const handleSend = useCallback(async () => {
    onError(null);
    const built = report ?? (await handleExport(false));
    if (!built) return;

    setSending(true);
    try {
      const result = await sendFiles([built.path]);
      if (result.failed.length > 0) {
        onError(`Could not send: ${result.failed[0].error}`);
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setSending(false);
    }
  }, [report, handleExport, onError]);

  const pickCover = useCallback(async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif"] }],
    });
    if (typeof picked === "string") setCover(picked);
  }, [setCover]);

  return (
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
        onOpenFolder={onOpenFolder}
        onBack={onBack}
        onRescan={onRescan}
        onExport={() => void handleExport(false)}
        onExportAs={() => void handleExport(true)}
        onSend={() => void handleSend()}
        sending={sending}
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
          onFetchMetadata={() => setLookupOpen(true)}
          onClearCover={() => setVolume((c) => (c ? { ...c, cover: null } : c))}
          fileName={fileName}
          suggestedFileName={suggested}
          onFileName={setFileName}
        />
      </div>

      <MetadataDialog
        open={lookupOpen}
        onOpenChange={setLookupOpen}
        initialQuery={volume.metadata.series}
        volumeNumber={volume.metadata.volume}
        chapterCount={volume.chapters.length}
        onApply={applyLookup}
      />
    </>
  );
}
