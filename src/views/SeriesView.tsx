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
} from "lucide-react";

import { BatchDownloadDialog } from "@/components/BatchDownloadDialog";
import { ChapterFetchDialog } from "@/components/ChapterFetchDialog";
import { RemoveSeriesDialog } from "@/components/RemoveSeriesDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { useThumbnail } from "@/hooks/useThumbnail";
import type { Volume } from "@/lib/api";
import {
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
export function SeriesView({ seriesId, onBack, onEditVolume, onError }: SeriesViewProps) {
  const [series, setSeries] = useState<Series | null>(null);
  const [volumes, setVolumes] = useState<VolumeStatus[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [building, setBuilding] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [batching, setBatching] = useState(false);

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
        <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-5">
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
                  selected={selected === volume.number}
                  building={building === volume.number}
                  onSelect={() =>
                    setSelected((current) =>
                      current === volume.number ? null : volume.number,
                    )
                  }
                  onBuild={() => void edit(volume.number)}
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
            onImport={(chapter) => void importFolder(chapter)}
            onRemove={(chapter) => void removeChapter(chapter)}
          />
        )}
      </div>

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
  selected,
  building,
  onSelect,
  onBuild,
}: {
  volume: VolumeStatus;
  selected: boolean;
  building: boolean;
  onSelect: () => void;
  onBuild: () => void;
}) {
  const have = downloadedCount(volume);
  const complete = isComplete(volume);
  const total = volume.chapters.length;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-card transition-colors",
        selected ? "border-primary" : "border-border hover:border-muted-foreground/40",
      )}
    >
      <button onClick={onSelect} className="flex w-full flex-col text-left">
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
          onClick={onBuild}
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

/** The selected volume's chapters. */
function VolumePanel({
  volume,
  building,
  onClose,
  onBuild,
  onGet,
  onImport,
  onRemove,
}: {
  volume: VolumeStatus;
  building: boolean;
  onClose: () => void;
  onBuild: () => void;
  onGet: (chapter: string) => void;
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
              onGet={() => onGet(chapter.number)}
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
  onGet,
  onImport,
  onRemove,
}: {
  chapter: ChapterStatus;
  onGet: () => void;
  onImport: () => void;
  onRemove: () => void;
}) {
  const have = chapter.folder !== null;

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
        {chapter.title ? ` · ${chapter.title}` : ""}
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
        </>
      ) : (
        <>
          <Hint label="Import a folder you already have">
            <Button variant="ghost" size="icon-sm" onClick={onImport}>
              <FolderInput className="size-3" />
            </Button>
          </Hint>
          <Button variant="outline" size="sm" onClick={onGet}>
            <Download className="size-3" />
            Get
          </Button>
        </>
      )}
    </div>
  );
}
