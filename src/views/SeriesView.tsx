import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { useThumbnail } from "@/hooks/useThumbnail";
import { formatBytes, type Format, type Volume } from "@/lib/api";
import { sendFiles } from "@/lib/send";
import {
  buildLibraryVolumes,
  cancelBuild,
  type BuildBatchProgress,
  type BuildBatchReport,
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
  libraryVolumes,
  missingChapters,
  summariseRuns,
  volumeLabel,
  type ChapterStatus,
  type Series,
  type VolumeStatus,
} from "@/lib/library";
import { cn } from "@/lib/utils";

interface SeriesViewProps {
  seriesId: number;
  onBack: () => void;
  /** Hand a built volume to the editor. */
  onEditVolume: (volume: Volume, source: { seriesId: number; number: string }) => void;
  /** From settings; what a batch build writes. */
  defaultFormat: string;
  /** Open a downloaded chapter in the reader. */
  onRead: (chapter: string) => void;
  onError: (message: string | null) => void;
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
}: SeriesViewProps) {
  const [series, setSeries] = useState<Series | null>(null);
  const [volumes, setVolumes] = useState<VolumeStatus[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [building, setBuilding] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [batching, setBatching] = useState(false);

  // Volume numbers picked for a batch build, plus the anchor shift-click extends
  // from. Mirrors how the page grid in the editor already behaves.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);
  const [buildProgress, setBuildProgress] = useState<BuildBatchProgress | null>(null);
  const [buildReport, setBuildReport] = useState<BuildBatchReport | null>(null);
  const [sending, setSending] = useState(false);
  const [fetchingDirect, setFetchingDirect] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [all, found] = await Promise.all([librarySeries(), libraryVolumes(seriesId)]);
      setSeries(all.find((s) => s.id === seriesId) ?? null);
      setVolumes(found);
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
      setFetchingDirect(chapter);
      onError(null);
      try {
        await downloadChapterFromSource(seriesId, chapter);
        await refresh();
      } catch (e) {
        onError(String(e));
      } finally {
        setFetchingDirect(null);
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

  useEffect(() => {
    const pending = listen<BuildBatchProgress>("build-batch-progress", (e) => {
      setBuildProgress(e.payload);
    });
    return () => {
      void pending.then((fn) => fn());
    };
  }, []);

  const runBuild = useCallback(
    async (askWhere: boolean): Promise<BuildBatchReport | null> => {
      const chosen = order.filter((n) => picked.has(n) && buildable.has(n));
      if (chosen.length === 0) return null;

      let outDir: string | null = null;
      if (askWhere) {
        const folder = await openDialog({ directory: true, multiple: false });
        if (typeof folder !== "string") return null;
        outDir = folder;
      }

      onError(null);
      setBuildReport(null);
      setBuildProgress({
        volume: chosen[0],
        index: 1,
        total: chosen.length,
        done: 0,
        pages: 0,
      });
      try {
        const report = await buildLibraryVolumes({
          id: seriesId,
          volumes: chosen,
          format: defaultFormat as Format,
          outDir,
        });
        setBuildReport(report);
        return report;
      } catch (e) {
        onError(String(e));
        return null;
      } finally {
        setBuildProgress(null);
      }
    },
    [order, picked, buildable, seriesId, defaultFormat, onError],
  );

  /**
   * Build the selection, then mail each volume to the device.
   *
   * Built to the configured folder first rather than to a temporary file: a
   * volume worth sending is worth keeping, and the send is the part most likely
   * to fail.
   */
  const runBuildAndSend = useCallback(async () => {
    const built = await runBuild(false);
    if (!built || built.built.length === 0) return;

    setSending(true);
    try {
      const result = await sendFiles(built.built.map((b) => b.path));
      if (result.failed.length > 0) {
        onError(
          `Sent ${result.sent.length}, failed ${result.failed.length}: ${result.failed[0].error}`,
        );
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setSending(false);
    }
  }, [runBuild, onError]);

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
          onClick={() => setBatching(true)}
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

      <div className="flex min-h-0 flex-1">
        <main
          className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-5"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPicked(new Set());
          }}
        >
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
            onBuild={() => void edit(detail.number)}
            onGet={setFetching}
            onRead={onRead}
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
            disabled={pickedBuildable.length === 0 || sending}
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

      {(buildProgress || buildReport || sending) && (
        <BuildStatus
          progress={buildProgress}
          sending={sending}
          report={buildReport}
          onDismiss={() => setBuildReport(null)}
        />
      )}

      <RemoveSeriesDialog
        series={removing ? series : null}
        onOpenChange={setRemoving}
        onRemoved={onBack}
      />

      <BatchDownloadDialog
        open={batching}
        onOpenChange={setBatching}
        seriesId={seriesId}
        missing={missing}
        onFinished={() => void refresh()}
      />

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
          className="absolute right-1.5 top-1.5 rounded-md bg-background/85 p-1.5 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
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
function BuildStatus({
  progress,
  sending,
  report,
  onDismiss,
}: {
  progress: BuildBatchProgress | null;
  sending: boolean;
  report: BuildBatchReport | null;
  onDismiss: () => void;
}) {
  return (
    <div className="absolute bottom-4 left-1/2 z-40 flex w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 shadow-lg">
      {sending ? (
        <>
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          <p className="min-w-0 flex-1 text-xs font-medium">Sending to your Kindle…</p>
        </>
      ) : progress ? (
        <>
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              Building volume {progress.volume} ({progress.index}/{progress.total})
            </p>
            <p className="text-[11px] text-muted-foreground">
              {progress.pages > 0
                ? `${progress.done}/${progress.pages} pages`
                : "assembling…"}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void cancelBuild()}>
            Stop
          </Button>
        </>
      ) : report ? (
        <>
          <Check className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              {report.cancelled ? "Stopped. " : ""}
              {report.built.length} built
              {report.failed.length > 0 && `, ${report.failed.length} failed`}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {report.failed.length > 0
                ? report.failed.map((f) => `v${f.volume}: ${f.error}`).join(" · ")
                : report.built
                    .map((b) => `v${b.volume} ${formatBytes(b.bytes)}`)
                    .join(" · ")}
            </p>
          </div>
          {report.built[0] && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void revealItemInDir(report.built[0].path)}
            >
              Show
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={onDismiss}>
            <X className="size-3" />
          </Button>
        </>
      ) : null}
    </div>
  );
}

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
}: {
  volume: VolumeStatus;
  building: boolean;
  onClose: () => void;
  onBuild: () => void;
  onGet: (chapter: string) => void;
  onRead: (chapter: string) => void;
  onFetchDirect: (chapter: string) => void;
  /** Chapter number currently being pulled from the source, if any. */
  fetchingDirect: string | null;
  onImport: (chapter: string) => void;
  onRemove: (chapter: string) => void;
}) {
  const have = downloadedCount(volume);
  const missing = missingChapters(volume);

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-card/40">
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
              busy={fetchingDirect === chapter.number}
              onGet={() => onGet(chapter.number)}
              onRead={() => onRead(chapter.number)}
              onFetchDirect={() => onFetchDirect(chapter.number)}
              onImport={() => onImport(chapter.number)}
              onRemove={() => onRemove(chapter.number)}
            />
          ))
        )}
      </div>

      <div className="border-t border-border p-3">
        <Button className="w-full" onClick={onBuild} disabled={have === 0 || building}>
          {building ? <Loader2 className="animate-spin" /> : <PenLine />}
          Build this volume
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
