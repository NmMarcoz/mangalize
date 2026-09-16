import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  BookOpen,
  Check,
  Download,
  FolderInput,
  Layers,
  Loader2,
  PenLine,
  RefreshCw,
  Trash2,
  X,
  PackageCheck,
  ExternalLink,
  Cloud,
} from "lucide-react";

import { BatchDownloadDialog } from "@/components/BatchDownloadDialog";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  type ContextMenuPosition,
} from "@/components/ContextMenu";
import { ChapterFetchDialog } from "@/components/ChapterFetchDialog";
import { RemoveSeriesDialog } from "@/components/RemoveSeriesDialog";
import { SourceDownloadDialog } from "@/components/SourceDownloadDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Hint } from "@/components/ui/tooltip";
import { useThumbnail } from "@/hooks/useThumbnail";
import {
  languageName,
  deliverBuilt,
  DELIVER_LABEL,
  type MetaSource,
  formatBytes,
  type Format,
  type Volume,
} from "@/lib/api";
import {
  buildLibraryVolumes,
} from "@/lib/settings";
import {
  canFetchDirectly,
  downloadChapterFromSource,
  downloadedCount,
  importChapter,
  isComplete,
  libraryBuildVolume,
  libraryDeleteChapter,
  libraryDownloadCovers,
  librarySeries,
  librarySyncSeries,
  libraryLanguages,
  librarySetLanguage,
  libraryVolumes,
  missingChapters,
  summariseRuns,
  volumeLabel,
  type ChapterStatus,
  type Series,
  type VolumeStatus,
} from "@/lib/library";
import type { ReaderTarget } from "@/lib/reader";
import {
  clearSeriesHistory,
  resumePoint,
  seriesHistory,
  type HistoryEntry,
} from "@/lib/reader";
import { isMobile } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface SeriesViewProps {
  seriesId: number;
  onBack: () => void;
  /** Hand a built volume to the editor. */
  onEditVolume: (volume: Volume, source: { seriesId: number; number: string }) => void;
  /** From settings; what a batch build writes. */
  defaultFormat: string;
  /** Open a downloaded chapter in the reader. */
  /**
   * Open a chapter, however it can be reached.
   *
   * A finished target rather than a chapter number: whether it opens from disk
   * or streams depends on what is actually there, and this view is the one
   * holding both the chapter and the series it belongs to.
   */
  onRead: (target: ReaderTarget) => void;
  onError: (message: string | null) => void;
  /** The queue changed; the app should show it. */
  onTasksChanged: () => void;
}

/**
 * One series as a shelf of volumes, with the gaps visible at a glance.
 *
 * The gallery is the point: published cover art makes a volume recognisable in a
 * way "Volume 7" never does, and the completeness badge turns "what am I
 * missing" into something answerable by looking rather than reading. Selecting a
 * volume opens its chapters in the side panel.
 */
export function SeriesView({
  seriesId,
  onBack,
  onEditVolume,
  defaultFormat,
  onRead,
  onError,
  onTasksChanged,
}: SeriesViewProps) {
  const [series, setSeries] = useState<Series | null>(null);
  const [volumes, setVolumes] = useState<VolumeStatus[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [building, setBuilding] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // A "get missing" run, once the user has chosen how to fetch. `wanted` is
  // what will be attempted: the whole series, or just one volume's gap.
  const [batching, setBatching] = useState<string[] | null>(null);
  const [fromSource, setFromSource] = useState<string[] | null>(null);
  // Where to pop the choice of route, and what it would cover.
  const [routing, setRouting] = useState<
    { at: ContextMenuPosition; wanted: string[] } | null
  >(null);
  const [rebuild, setRebuild] = useState<VolumeStatus | null>(null);
  const [resume, setResume] = useState<ChapterStatus | null>(null);
  const [read, setRead] = useState<HistoryEntry[]>([]);
  const [forgetting, setForgetting] = useState(false);
  // Fetched when the picker is first opened rather than with the page: it is a
  // network call for something most visits never look at.
  const [languages, setLanguages] = useState<string[] | null>(null);
  const [switching, setSwitching] = useState(false);

  // Volume numbers picked for a batch build, plus the anchor shift-click extends
  // from. Mirrors how the page grid in the editor already behaves.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);
  // A set, not one chapter. Downloads are started one tap at a time but run
  // together, so a single value made the previous chapter's spinner stop the
  // moment the next was tapped, and the first one to finish stopped all of them.
  const [fetchingDirect, setFetchingDirect] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const refresh = useCallback(async () => {
    try {
      const [all, found, next, log] = await Promise.all([
        librarySeries(),
        libraryVolumes(seriesId),
        // Both are reading state rather than library state, and both are
        // cheap enough to come along rather than needing their own refresh.
        resumePoint(seriesId).catch(() => null),
        seriesHistory(seriesId).catch(() => []),
      ]);
      setSeries(all.find((s) => s.id === seriesId) ?? null);
      setVolumes(found);
      setResume(next);
      setRead(log);
      return found;
    } catch (e) {
      onError(String(e));
      return null;
    }
  }, [seriesId, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Pull any volume covers we do not hold yet, then show them.
   *
   * Done once per series rather than on every render, and silently: a cover that
   * will not download is a cosmetic problem, not something to interrupt over.
   */
  useEffect(() => {
    let cancelled = false;
    libraryDownloadCovers(seriesId)
      .then((fetched) => {
        if (fetched > 0 && !cancelled) void refresh();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [seriesId, refresh]);

  const sync = useCallback(async () => {
    setSyncing(true);
    onError(null);
    try {
      await librarySyncSeries(seriesId);
      await refresh();
      // A sync can introduce volumes whose art we have never fetched.
      if ((await libraryDownloadCovers(seriesId)) > 0) await refresh();
    } catch (e) {
      onError(String(e));
    } finally {
      setSyncing(false);
    }
  }, [seriesId, refresh, onError]);

  const edit = useCallback(
    async (number: string) => {
      setBuilding(number);
      onError(null);
      try {
        const built = await libraryBuildVolume(seriesId, number);
        onEditVolume(built, { seriesId, number });
      } catch (e) {
        onError(String(e));
      } finally {
        setBuilding(null);
      }
    },
    [seriesId, onEditVolume, onError],
  );

  const importFolder = useCallback(
    async (chapter: string) => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      onError(null);
      try {
        await importChapter(seriesId, chapter, picked);
        await refresh();
      } catch (e) {
        onError(String(e));
      }
    },
    [seriesId, refresh, onError],
  );

  /**
   * Pull a chapter straight from the metadata source.
   *
   * Only offered when a sync recorded the source's chapter id and the source
   * actually hosts the images. Everything else falls back to pasting a URL.
   */
  const fetchDirect = useCallback(
    async (chapter: string) => {
      let already = false;
      setFetchingDirect((current) => {
        already = current.has(chapter);
        if (already) return current;
        return new Set(current).add(chapter);
      });
      // Tapping the same chapter twice should not start a second download of it.
      if (already) return;

      onError(null);
      try {
        await downloadChapterFromSource(seriesId, chapter);
        await refresh();
      } catch (e) {
        onError(String(e));
      } finally {
        setFetchingDirect((current) => {
          const next = new Set(current);
          next.delete(chapter);
          return next;
        });
      }
    },
    [seriesId, refresh, onError],
  );

  const removeChapter = useCallback(
    async (chapter: string) => {
      onError(null);
      try {
        await libraryDeleteChapter(seriesId, chapter);
        await refresh();
      } catch (e) {
        onError(String(e));
      }
    },
    [seriesId, refresh, onError],
  );

  /** Every chapter the library knows about but does not hold, in order. */
  const missing = useMemo(
    () =>
      (volumes ?? []).flatMap((volume) =>
        missingChapters(volume).map((chapter) => chapter.number),
      ),
    [volumes],
  );

  const detail = volumes?.find((v) => v.number === selected) ?? null;

  /* ----------------------------------------------------------- selection */

  const order = useMemo(() => (volumes ?? []).map((v) => v.number), [volumes]);

  /** Volumes with at least one chapter on disk; the rest cannot be built. */
  const buildable = useMemo(
    () => new Set((volumes ?? []).filter((v) => downloadedCount(v) > 0).map((v) => v.number)),
    [volumes],
  );

  /**
   * Click to select and open, ctrl/cmd-click to toggle, shift-click to extend.
   *
   * The same three gestures the page grid in the editor uses, so a range of
   * volumes is picked exactly the way a range of pages is.
   */
  const pick = useCallback(
    (number: string, event: React.MouseEvent) => {
      if (event.shiftKey && anchor) {
        const from = order.indexOf(anchor);
        const to = order.indexOf(number);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setPicked((prev) => new Set([...prev, ...order.slice(lo, hi + 1)]));
          return;
        }
      }
      if (event.metaKey || event.ctrlKey) {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(number)) next.delete(number);
          else next.add(number);
          return next;
        });
        setAnchor(number);
        return;
      }
      // A plain click is both "this one" and "show me its chapters".
      setPicked(new Set([number]));
      setAnchor(number);
      setSelected((current) => (current === number ? null : number));
    },
    [anchor, order],
  );

  const openMenu = useCallback(
    (number: string, event: React.MouseEvent) => {
      event.preventDefault();
      // Right-clicking outside the current selection replaces it, which is what
      // every file manager does and what avoids acting on something unseen.
      setPicked((prev) => (prev.has(number) ? prev : new Set([number])));
      setAnchor(number);
      setMenu({ x: event.clientX, y: event.clientY });
    },
    [],
  );

  /* ------------------------------------------------------- batch building */

  /**
   * Queue a build of the selected volumes.
   *
   * Writing a volume is a minute of re-encoding per volume, so it goes on the
   * queue like a download does. The selection is cleared once it is handed
   * over: leaving it ticked invites building the same thing twice.
   */
  const runBuild = useCallback(
    async (askWhere: boolean): Promise<boolean> => {
      const chosen = order.filter((n) => picked.has(n) && buildable.has(n));
      if (chosen.length === 0) return false;

      let outDir: string | null = null;
      if (askWhere) {
        const folder = await openDialog({ directory: true, multiple: false });
        if (typeof folder !== "string") return false;
        outDir = folder;
      }

      onError(null);
      try {
        await buildLibraryVolumes({
          id: seriesId,
          volumes: chosen,
          format: defaultFormat as Format,
          outDir,
        });
        setPicked(new Set());
        onTasksChanged();
        return true;
      } catch (e) {
        onError(String(e));
        return false;
      }
    },
    [order, picked, buildable, seriesId, defaultFormat, onError, onTasksChanged],
  );

  /** Build the selection and mail each volume, as one queued job. */
  const runBuildAndSend = useCallback(async () => {
    const chosen = order.filter((n) => picked.has(n) && buildable.has(n));
    if (chosen.length === 0) return;
    onError(null);
    try {
      await buildLibraryVolumes({
        id: seriesId,
        volumes: chosen,
        format: defaultFormat as Format,
        outDir: null,
        deliver: true,
      });
      setPicked(new Set());
      onTasksChanged();
    } catch (e) {
      onError(String(e));
    }
  }, [order, picked, buildable, seriesId, defaultFormat, onError, onTasksChanged]);

  /**
   * How to open a chapter of this series.
   *
   * Downloaded pages come off disk. Anything else the source indexed is
   * streamed, which needs the series' own id — without it the reader would
   * record a nameless series it could never find again.
   */
  const openChapter = useCallback(
    (chapter: ChapterStatus) => {
      if (chapter.folder || !chapter.source_id || !series?.source_id) {
        onRead({ kind: "library", seriesId, chapter: chapter.number });
        return;
      }
      onRead({
        kind: "online",
        source: (series.source ?? "mangadex") as MetaSource,
        chapterId: chapter.source_id,
        seriesTitle: series.title,
        chapterNumber: chapter.number,
        direction: series.direction === "left-to-right" ? "left-to-right" : "right-to-left",
        language: series.language,
        // The whole series in reading order, so finishing one chapter moves to
        // the next rather than stopping at whatever was opened.
        chapters: (volumes ?? [])
          .flatMap((v) => v.chapters)
          .filter((c) => c.source_id && !c.unavailable)
          .map((c) => ({ id: c.source_id as string, number: c.number })),
        seriesSourceId: series.source_id,
        coverUrl: null,
        librarySeriesId: seriesId,
      });
    },
    [series, seriesId, volumes, onRead],
  );

  const pickedBuildable = order.filter((n) => picked.has(n) && buildable.has(n));

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4 py-2.5">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{series?.title ?? "…"}</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            {series
              ? `${series.author || "Unknown author"} · ${series.have_chapters}/${
                  series.known_chapters || "?"
                } chapters`
              : ""}
          </p>
        </div>

        <Button
          variant={missing.length > 0 ? "default" : "outline"}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setRouting({ at: { x: r.left, y: r.bottom + 4 }, wanted: missing });
          }}
          disabled={missing.length === 0}
          title={
            missing.length === 0
              ? "Nothing is missing"
              : `Find and download the ${missing.length} missing chapters`
          }
        >
          <Layers />
          Get {missing.length > 0 ? missing.length : ""} missing
        </Button>

        <Hint label="Re-pull the published volume layout">
          <Button variant="ghost" size="icon" onClick={() => void sync()} disabled={syncing}>
            {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </Hint>
        <Hint label="Remove this series from the library">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setRemoving(true)}
            disabled={!series}
          >
            <Trash2 />
          </Button>
        </Hint>
      </header>

      {/* `relative` so the volume panel has something to cover when it is an
          overlay rather than a column. */}
      <div className="relative flex min-h-0 flex-1">
        <main
          className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-5"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPicked(new Set());
          }}
        >
          {/* The same things the discover dialog shows, above the shelf rather
              than in a dialog: this page is where a series in the library is
              looked at, and it had nothing to say about the series itself. */}
          {series && (
            <SeriesDetails
              series={series}
              languages={languages}
              switching={switching}
              onLoadLanguages={() => {
                if (languages !== null) return;
                void libraryLanguages(seriesId)
                  .then(setLanguages)
                  .catch(() => setLanguages([]));
              }}
              onLanguage={(code) => {
                setSwitching(true);
                onError(null);
                void librarySetLanguage(seriesId, code)
                  .then(() => refresh())
                  .catch((e) => onError(String(e)))
                  .finally(() => setSwitching(false));
              }}
              resume={resume}
              readCount={read.length}
              onResume={() => resume && openChapter(resume)}
              onForget={() => setForgetting(true)}
            />
          )}

          {volumes === null ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading volumes…
            </div>
          ) : volumes.length === 0 ? (
            <div className="mx-auto mt-16 max-w-md text-center">
              <BookOpen className="mx-auto size-8 text-muted-foreground" />
              <h2 className="mt-3 text-sm font-medium">No volume layout yet</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Nothing published a volume-to-chapter map for this series, or the
                sync has not run. Try refreshing.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
              {volumes.map((volume) => (
                <VolumeCard
                  key={volume.number}
                  volume={volume}
                  open={selected === volume.number}
                  picked={picked.has(volume.number)}
                  building={building === volume.number}
                  onPick={(e) => pick(volume.number, e)}
                  onContextMenu={(e) => openMenu(volume.number, e)}
                  onEdit={() => void edit(volume.number)}
                />
              ))}
            </div>
          )}
        </main>

        {detail && (
          <VolumePanel
            volume={detail}
            building={building === detail.number}
            onClose={() => setSelected(null)}
            onBuild={() => (detail.built ? setRebuild(detail) : void edit(detail.number))}
            onShare={() =>
              detail.built &&
              void deliverBuilt(detail.built.path, volumeLabel(detail)).catch((e) =>
                onError(String(e)),
              )
            }
            onGetMissing={(at) =>
              setRouting({
                at,
                wanted: missingChapters(detail).map((c) => c.number),
              })
            }
            onGet={setFetching}
            onRead={openChapter}
            onFetchDirect={(chapter) => void fetchDirect(chapter)}
            fetchingDirect={fetchingDirect}
            onImport={(chapter) => void importFolder(chapter)}
            onRemove={(chapter) => void removeChapter(chapter)}
          />
        )}
      </div>

      {menu && (
        <ContextMenu at={menu} onClose={() => setMenu(null)}>
          <ContextMenuItem
            onSelect={() => {
              setMenu(null);
              void runBuild(false);
            }}
            disabled={pickedBuildable.length === 0}
            hint={defaultFormat.toUpperCase()}
          >
            Build {pickedBuildable.length > 1 ? `${pickedBuildable.length} volumes` : "volume"}
          </ContextMenuItem>

          <ContextMenuItem
            onSelect={() => {
              setMenu(null);
              void runBuild(true);
            }}
            disabled={pickedBuildable.length === 0}
          >
            Build as…
          </ContextMenuItem>

          <ContextMenuItem
            onSelect={() => {
              setMenu(null);
              void runBuildAndSend();
            }}
            disabled={pickedBuildable.length === 0}
          >
            Build and send to Kindle
          </ContextMenuItem>

          {pickedBuildable.length < picked.size && (
            <ContextMenuItem onSelect={() => {}} disabled>
              {picked.size - pickedBuildable.length} not downloaded yet
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem
            onSelect={() => {
              setPicked(new Set(order.filter((n) => buildable.has(n))));
              setMenu(null);
            }}
          >
            Select all built
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              setPicked(new Set());
              setMenu(null);
            }}
          >
            Clear selection
          </ContextMenuItem>
        </ContextMenu>
      )}

      <RemoveSeriesDialog
        series={removing ? series : null}
        onOpenChange={setRemoving}
        onRemoved={onBack}
      />

      <BatchDownloadDialog
        open={batching !== null}
        onOpenChange={(next) => !next && setBatching(null)}
        seriesId={seriesId}
        missing={batching ?? []}
        onStarted={() => void refresh()}
      />

      {fromSource && (
        <SourceDownloadDialog
          open
          onOpenChange={(next) => !next && setFromSource(null)}
          seriesId={seriesId}
          sourceName={sourceLabel(series?.source)}
          chapters={fromSource}
          onStarted={() => void refresh()}
        />
      )}

      <Dialog open={forgetting} onOpenChange={setForgetting}>
        <DialogContent className="max-w-md">
          <div className="border-b border-border px-4 py-3">
            <DialogTitle>Forget what you read of this series?</DialogTitle>
            <DialogDescription>
              Clears the resume point and every read mark for{" "}
              {series?.title ?? "this series"}. No downloaded pages are deleted.
            </DialogDescription>
          </div>
          <div className="flex items-center justify-end gap-2 px-4 py-3">
            <Button variant="ghost" onClick={() => setForgetting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setForgetting(false);
                void clearSeriesHistory(seriesId)
                  .then(() => refresh())
                  .catch((e) => onError(String(e)));
              }}
            >
              <Trash2 />
              Forget
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Building again costs a minute or more of re-encoding for a file that
          already exists, so the choice is offered rather than assumed. */}
      <Dialog open={rebuild !== null} onOpenChange={(next) => !next && setRebuild(null)}>
        <DialogContent className="max-w-md">
          <div className="border-b border-border px-4 py-3">
            <DialogTitle>{rebuild && volumeLabel(rebuild)} is already built</DialogTitle>
            <DialogDescription>
              {rebuild?.built && (
                <span className="break-all">{rebuild.built.path}</span>
              )}
            </DialogDescription>
          </div>
          <div className="flex items-center justify-end gap-2 px-4 py-3">
            <Button variant="ghost" onClick={() => setRebuild(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const target = rebuild;
                setRebuild(null);
                if (target) void edit(target.number);
              }}
            >
              <PenLine />
              Build again
            </Button>
            <Button
              onClick={() => {
                const built = rebuild?.built;
                const label = rebuild ? volumeLabel(rebuild) : undefined;
                setRebuild(null);
                if (built) {
                  void deliverBuilt(built.path, label).catch((e) => onError(String(e)));
                }
              }}
            >
              {DELIVER_LABEL}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Two ways to reach the same chapters, and which is available depends on
          the series rather than on a preference. */}
      {routing && (
        <ContextMenu at={routing.at} onClose={() => setRouting(null)}>
          <ContextMenuItem
            disabled={!series?.source || routing.wanted.length === 0}
            hint={series?.source ? undefined : "no metadata source"}
            onSelect={() => setFromSource(routing.wanted)}
          >
            From {sourceLabel(series?.source)}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={routing.wanted.length === 0}
            onSelect={() => setBatching(routing.wanted)}
          >
            From a chapter URL…
          </ContextMenuItem>
        </ContextMenu>
      )}

      {fetching !== null && (
        <ChapterFetchDialog
          open
          onOpenChange={(next) => !next && setFetching(null)}
          seriesId={seriesId}
          chapter={fetching}
          onDownloaded={() => {
            setFetching(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/** One volume on the shelf: its art, how much of it we hold, and a way in. */
function VolumeCard({
  volume,
  open,
  picked,
  building,
  onPick,
  onContextMenu,
  onEdit,
}: {
  volume: VolumeStatus;
  /** Its chapters are showing in the side panel. */
  open: boolean;
  /** Included in the current batch selection. */
  picked: boolean;
  building: boolean;
  onPick: (event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onEdit: () => void;
}) {
  const have = downloadedCount(volume);
  const complete = isComplete(volume);
  const total = volume.chapters.length;

  return (
    <div
      onContextMenu={onContextMenu}
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-card transition-colors",
        picked
          ? "border-primary ring-2 ring-primary/40"
          : open
            ? "border-primary"
            : "border-border hover:border-muted-foreground/40",
      )}
    >
      <button onClick={onPick} className="flex w-full flex-col text-left">
        <VolumeArt volume={volume} dimmed={have === 0} />

        <div className="flex flex-col gap-1 p-2">
          <p className="truncate text-xs font-medium">{volumeLabel(volume)}</p>
          <div className="flex items-center gap-1.5">
            {complete ? (
              <Badge>
                <Check className="size-2.5" />
                complete
              </Badge>
            ) : (
              <Badge variant="outline">
                {have}/{total || "?"}
              </Badge>
            )}
            {/* Written out already, and the file is still where it was put. */}
            {volume.built && (
              <Badge variant="outline" title={volume.built.path}>
                <PackageCheck className="size-2.5" />
                built
              </Badge>
            )}
          </div>
        </div>
      </button>

      {/* Progress along the bottom edge: readable without parsing the numbers. */}
      {total > 0 && !complete && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
          <div
            className="h-full bg-primary/70"
            style={{ width: `${(have / total) * 100}%` }}
          />
        </div>
      )}

      {have > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          disabled={building}
          title={`Build ${volumeLabel(volume)}`}
          className={cn(
            "absolute right-1.5 top-1.5 rounded-md bg-background/85 p-1.5 text-muted-foreground backdrop-blur-sm transition-opacity hover:text-primary focus-visible:opacity-100",
            !isMobile && "opacity-0 group-hover:opacity-100",
          )}
        >
          {building ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <PenLine className="size-3.5" />
          )}
        </button>
      )}
    </div>
  );
}

/**
 * The cover, from the library when we hold it and from the source when we do
 * not, so a volume is never a blank rectangle while its art is still arriving.
 */
function VolumeArt({ volume, dimmed }: { volume: VolumeStatus; dimmed: boolean }) {
  const { ref, url } = useThumbnail(volume.cover_path ?? "", 400);
  const src = volume.cover_path ? url : (volume.cover_url ?? undefined);

  return (
    <div
      ref={ref}
      className="flex aspect-[10/15] w-full items-center justify-center bg-muted/40"
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className={cn(
            "h-full w-full object-cover transition-opacity",
            // Nothing downloaded reads as "not yours yet" at a glance.
            dimmed && "opacity-40",
          )}
        />
      ) : (
        <BookOpen className="size-5 text-muted-foreground" />
      )}
    </div>
  );
}

/** Progress while a batch builds, then what it produced. */

/** The selected volume's chapters. */
function VolumePanel({
  volume,
  building,
  onClose,
  onBuild,
  onGet,
  onRead,
  onFetchDirect,
  fetchingDirect,
  onImport,
  onRemove,
  onShare,
  onGetMissing,
}: {
  volume: VolumeStatus;
  building: boolean;
  onClose: () => void;
  onBuild: () => void;
  onGet: (chapter: string) => void;
  onRead: (chapter: ChapterStatus) => void;
  onFetchDirect: (chapter: string) => void;
  /** Chapter numbers currently being pulled from the source. */
  fetchingDirect: ReadonlySet<string>;
  onImport: (chapter: string) => void;
  onRemove: (chapter: string) => void;
  /** Hand the built file to another app, or reveal it. */
  onShare: () => void;
  /** Fetch only the chapters this volume is still missing. */
  onGetMissing: (at: ContextMenuPosition) => void;
}) {
  const have = downloadedCount(volume);
  const missing = missingChapters(volume);

  return (
    <aside
      className={cn(
        "flex flex-col border-border bg-card/40",
        // A 384px panel beside a grid leaves a phone's grid nothing, so there
        // it covers the grid instead of sitting next to it.
        isMobile
          ? "absolute inset-0 z-30 border-l-0 bg-background"
          : "w-96 shrink-0 border-l",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{volumeLabel(volume)}</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {have}/{volume.chapters.length} chapters
            {missing.length > 0 && ` · missing ${summariseRuns(missing.map((c) => c.number))}`}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {volume.chapters.length === 0 ? (
          <p className="px-4 py-3 text-[11px] text-muted-foreground">
            No chapters are listed for this volume.
          </p>
        ) : (
          volume.chapters.map((chapter) => (
            <ChapterRow
              key={chapter.number}
              chapter={chapter}
              busy={fetchingDirect.has(chapter.number)}
              onGet={() => onGet(chapter.number)}
              onRead={() => onRead(chapter)}
              onFetchDirect={() => onFetchDirect(chapter.number)}
              onImport={() => onImport(chapter.number)}
              onRemove={() => onRemove(chapter.number)}
            />
          ))
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border p-3">
        {/* Offered without having to build again: the work is already done, and
            on a phone this is the only way a volume leaves the app at all. */}
        {volume.built && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
            <PackageCheck className="size-3.5 shrink-0 text-primary" />
            <p
              className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
              title={volume.built.path}
            >
              Built {formatBytes(volume.built.bytes)}
            </p>
            <Button variant="outline" size="sm" onClick={onShare}>
              {DELIVER_LABEL}
            </Button>
          </div>
        )}

        {missing.length > 0 && (
          <Button
            variant="outline"
            className="w-full"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onGetMissing({ x: r.left, y: r.bottom + 4 });
            }}
          >
            <Layers />
            Get {missing.length} missing in this volume
          </Button>
        )}

        <Button className="w-full" onClick={onBuild} disabled={have === 0 || building}>
          {building ? <Loader2 className="animate-spin" /> : <PenLine />}
          {volume.built ? "Build again" : "Build this volume"}
        </Button>
      </div>
    </aside>
  );
}

function ChapterRow({
  chapter,
  busy,
  onGet,
  onRead,
  onFetchDirect,
  onImport,
  onRemove,
}: {
  chapter: ChapterStatus;
  busy: boolean;
  onGet: () => void;
  onRead: () => void;
  onFetchDirect: () => void;
  onImport: () => void;
  onRemove: () => void;
}) {
  const have = chapter.folder !== null;
  const direct = canFetchDirectly(chapter);

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0",
        !have && "bg-amber-500/[0.03]",
      )}
    >
      <span
        className={cn(
          "w-12 shrink-0 font-mono text-xs",
          have ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {chapter.number}
      </span>

      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {have ? `${chapter.page_count} pages` : "missing"}
        {have && chapter.read_at && " · read"}
        {have && !chapter.read_at && chapter.last_page > 0 &&
          ` · page ${chapter.last_page + 1}`}
        {chapter.title ? ` · ${chapter.title}` : ""}
        {have && chapterSource(chapter) && ` · ${chapterSource(chapter)}`}
        {!have && chapter.unavailable && (
          // Not an error: the source indexes the chapter but the publisher
          // hosts it. Saying so stops this looking like a broken download.
          <span className="ml-1.5 text-amber-500/80">· not hosted by the source</span>
        )}
      </span>

      {have ? (
        <>
          <Hint label="Delete these pages and mark the chapter missing again">
            <Button variant="ghost" size="icon-sm" onClick={onRemove}>
              <Trash2 className="size-3" />
            </Button>
          </Hint>
          <Hint label="Replace with a different rip">
            <Button variant="ghost" size="sm" onClick={onGet}>
              Replace
            </Button>
          </Hint>
          <Hint
            label={
              chapter.last_page > 0 && !chapter.read_at
                ? `Resume on page ${chapter.last_page + 1}`
                : "Read this chapter"
            }
          >
            <Button variant="outline" size="sm" onClick={onRead}>
              <BookOpen className="size-3" />
              {chapter.read_at
                ? "Re-read"
                : chapter.last_page > 0
                  ? "Resume"
                  : "Read"}
            </Button>
          </Hint>
        </>
      ) : (
        <>
          <Hint label="Import a folder you already have">
            <Button variant="ghost" size="icon-sm" onClick={onImport} disabled={busy}>
              <FolderInput className="size-3" />
            </Button>
          </Hint>
          {/* A chapter you do not hold is still readable when the source serves
              it. That is what streaming is for, and the library had no way in. */}
          {direct && (
            <Hint label="Read from the source without downloading it">
              <Button variant="ghost" size="sm" onClick={onRead} disabled={busy}>
                <Cloud className="size-3" />
                Read
              </Button>
            </Hint>
          )}
          {direct ? (
            <>
              <Hint label="Paste a URL from somewhere else instead">
                <Button variant="ghost" size="sm" onClick={onGet} disabled={busy}>
                  URL
                </Button>
              </Hint>
              <Hint label="Download straight from the metadata source">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onFetchDirect}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Download className="size-3" />
                  )}
                  Get
                </Button>
              </Hint>
            </>
          ) : (
            <Hint
              label={
                chapter.unavailable
                  ? "The source does not host this one — paste the publisher's page"
                  : "Paste the page holding this chapter's images"
              }
            >
              <Button variant="outline" size="sm" onClick={onGet} disabled={busy}>
                <Download className="size-3" />
                Get
              </Button>
            </Hint>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Where a downloaded chapter's pages came from.
 *
 * Worth showing because a library fills up from more than one place, and the
 * answer decides what "get this again" will do — a chapter the source hosts can
 * be re-fetched with one tap, a scraped one needs its URL again.
 *
 * The host rather than the full URL: the question is which site, and a reader
 * URL is long and mostly opaque ids.
 */
function chapterSource(chapter: ChapterStatus): string | null {
  if (chapter.source_url) {
    try {
      return new URL(chapter.source_url).host.replace(/^www\./, "");
    } catch {
      return null;
    }
  }
  return chapter.source_id ? "MangaDex" : null;
}

/** How to name where a series' chapters come from. */
function sourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "mangadex":
      return "MangaDex";
    case "kitsu":
      return "Kitsu";
    default:
      return "the source";
  }
}

/**
 * What a series is, above its shelf of volumes.
 *
 * The description collapses because a good one runs to a paragraph and the
 * volumes are what the page is for — the detail should be reachable without
 * pushing them below the fold.
 */
function SeriesDetails({
  series,
  languages,
  switching,
  onLoadLanguages,
  onLanguage,
  resume,
  readCount,
  onResume,
  onForget,
}: {
  series: Series;
  /** Translations the source has, once asked for. `null` means not yet. */
  languages: string[] | null;
  switching: boolean;
  onLoadLanguages: () => void;
  onLanguage: (code: string) => void;
  /** Where reading left off, when it did. */
  resume: ChapterStatus | null;
  readCount: number;
  onResume: () => void;
  onForget: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { ref, url } = useThumbnail(series.cover_path ?? "", 320);

  const subtitle = [series.title_romaji, series.title_native]
    .filter((t) => t && t !== series.title)
    .join(" · ");

  return (
    <div ref={ref as React.Ref<HTMLDivElement>} className={cn("mb-6 flex gap-4", isMobile && "flex-col")}>
      <div
        className={cn(
          "flex items-center justify-center overflow-hidden rounded-lg bg-muted/40",
          isMobile ? "h-52 w-36 self-start" : "h-52 w-36 shrink-0",
        )}
      >
        {series.cover_path && url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <BookOpen className="size-6 text-muted-foreground" />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <h2 className="text-base font-semibold">{series.title}</h2>
          {subtitle && (
            <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {[series.author, series.artist !== series.author ? series.artist : null]
            .filter(Boolean)
            .join(" · ") || "Unknown author"}
          {series.year ? ` · ${series.year}` : ""}
          {series.status ? ` · ${series.status}` : ""}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          {series.content_rating && (
            <Badge variant={series.content_rating === "safe" ? "outline" : "default"}>
              {series.content_rating}
            </Badge>
          )}
          {series.site_url && (
            <a
              href={series.site_url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3" />
              {sourceLabel(series.source)}
            </a>
          )}
        </div>

        {series.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {series.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="opacity-75">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* The translation decides which chapters exist and how they are
            numbered, so it belongs next to the chapter list rather than buried
            in settings. */}
        <div className="flex items-center gap-2">
          <Select
            value={series.language}
            onValueChange={onLanguage}
            disabled={switching}
            onOpenChange={(isOpen: boolean) => isOpen && onLoadLanguages()}
          >
            <SelectTrigger className="h-7 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(languages && languages.length > 0
                ? languages
                : [series.language]
              ).map((code) => (
                <SelectItem key={code} value={code}>
                  {languageName(code)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {switching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <span className="text-[11px] text-muted-foreground">
            Translation · changing it re-pulls the chapter list, and keeps what
            you have downloaded.
          </span>
        </div>

        {/* What this series is to *you*: where to pick it up, and how much of
            it you have been through. */}
        {(resume || readCount > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {resume && (
              <Button size="sm" onClick={onResume}>
                <BookOpen className="size-3.5" />
                {resume.opened_at && resume.last_page > 0
                  ? `Continue chapter ${resume.number}, page ${resume.last_page + 1}`
                  : `Read chapter ${resume.number}`}
              </Button>
            )}
            {readCount > 0 && (
              <>
                <span className="text-[11px] text-muted-foreground">
                  {readCount} {readCount === 1 ? "chapter" : "chapters"} in your
                  history
                </span>
                <button
                  onClick={onForget}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Forget
                </button>
              </>
            )}
          </div>
        )}

        {series.description && (
          <div>
            <p
              className={cn(
                "whitespace-pre-line text-xs leading-relaxed text-muted-foreground",
                !expanded && "line-clamp-3",
              )}
              data-selectable
            >
              {series.description}
            </p>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-0.5 text-[11px] text-primary hover:underline"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
