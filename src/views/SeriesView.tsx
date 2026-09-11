import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  BookOpen,
  Check,
  Download,
  FolderInput,
  Loader2,
  PenLine,
  RefreshCw,
  Trash2,
} from "lucide-react";

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
 * One series: its volumes, which chapters are present, and which are not.
 *
 * This is the view the library exists for. Everything else — adding a series,
 * pulling a layout — is in service of being able to look at a volume and see
 * the gaps.
 */
export function SeriesView({ seriesId, onBack, onEditVolume, onError }: SeriesViewProps) {
  const [series, setSeries] = useState<Series | null>(null);
  const [volumes, setVolumes] = useState<VolumeStatus[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [building, setBuilding] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [all, found] = await Promise.all([librarySeries(), libraryVolumes(seriesId)]);
      setSeries(all.find((s) => s.id === seriesId) ?? null);
      setVolumes(found);
    } catch (e) {
      onError(String(e));
    }
  }, [seriesId, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sync = useCallback(async () => {
    setSyncing(true);
    onError(null);
    try {
      await librarySyncSeries(seriesId);
      await refresh();
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

  const toggle = useCallback((number: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4 py-2.5">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            {series?.title ?? "…"}
          </h1>
          <p className="truncate text-[11px] text-muted-foreground">
            {series
              ? `${series.author || "Unknown author"} · ${series.have_chapters}/${
                  series.known_chapters || "?"
                } chapters`
              : ""}
          </p>
        </div>
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

      <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
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
          <div className="flex flex-col gap-3">
            {volumes.map((volume) => (
              <VolumeRow
                key={volume.number}
                volume={volume}
                open={expanded.has(volume.number)}
                building={building === volume.number}
                onToggle={() => toggle(volume.number)}
                onEdit={() => void edit(volume.number)}
                onGet={setFetching}
                onImport={(chapter) => void importFolder(chapter)}
                onRemove={(chapter) => void removeChapter(chapter)}
              />
            ))}
          </div>
        )}
      </main>

      <RemoveSeriesDialog
        series={removing ? series : null}
        onOpenChange={(next) => setRemoving(next)}
        onRemoved={onBack}
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

function VolumeRow({
  volume,
  open,
  building,
  onToggle,
  onEdit,
  onGet,
  onImport,
  onRemove,
}: {
  volume: VolumeStatus;
  open: boolean;
  building: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onGet: (chapter: string) => void;
  onImport: (chapter: string) => void;
  onRemove: (chapter: string) => void;
}) {
  const have = downloadedCount(volume);
  const missing = missingChapters(volume);
  const complete = isComplete(volume);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 p-3">
        <VolumeCover volume={volume} />

        <button onClick={onToggle} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">{volumeLabel(volume)}</h2>
            {complete ? (
              <Badge>
                <Check className="size-2.5" />
                complete
              </Badge>
            ) : (
              <Badge variant="outline">
                {have}/{volume.chapters.length} chapters
              </Badge>
            )}
          </div>
          {missing.length > 0 && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              missing {summariseRuns(missing.map((c) => c.number))}
            </p>
          )}
        </button>

        <Button
          variant={complete ? "default" : "outline"}
          size="sm"
          onClick={onEdit}
          disabled={have === 0 || building}
          title={have === 0 ? "Nothing downloaded yet" : "Open in the volume editor"}
        >
          {building ? <Loader2 className="animate-spin" /> : <PenLine />}
          Build
        </Button>
      </div>

      {open && (
        <div className="border-t border-border">
          {volume.chapters.map((chapter) => (
            <ChapterRow
              key={chapter.number}
              chapter={chapter}
              onGet={() => onGet(chapter.number)}
              onImport={() => onImport(chapter.number)}
              onRemove={() => onRemove(chapter.number)}
            />
          ))}
          {volume.chapters.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              No chapters are listed for this volume.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function VolumeCover({ volume }: { volume: VolumeStatus }) {
  const { ref, url } = useThumbnail(volume.cover_path ?? "", 120);
  const src = volume.cover_path ? url : (volume.cover_url ?? undefined);

  return (
    <div
      ref={ref}
      className="flex h-16 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/40"
    >
      {src ? (
        <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <BookOpen className="size-4 text-muted-foreground" />
      )}
    </div>
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
        "flex items-center gap-3 border-b border-border/50 px-3 py-1.5 last:border-b-0",
        !have && "bg-amber-500/[0.03]",
      )}
    >
      <span
        className={cn(
          "w-16 shrink-0 font-mono text-xs",
          have ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {chapter.number}
      </span>

      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
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
