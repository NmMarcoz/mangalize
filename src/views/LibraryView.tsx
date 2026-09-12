import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { AddSeriesDialog } from "@/components/AddSeriesDialog";
import { RemoveSeriesDialog } from "@/components/RemoveSeriesDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { useThumbnail } from "@/hooks/useThumbnail";
import {
  libraryRoot,
  librarySeries,
  setLibraryRoot,
  type Series,
} from "@/lib/library";

interface LibraryViewProps {
  onOpenSeries: (id: number) => void;
  /** Escape hatch to the original scan-a-folder path. */
  onOpenFolder: () => void;
  onError: (message: string | null) => void;
}

/** The shelf: every series in the library, and the way to add another. */
export function LibraryView({
  onOpenSeries,
  onOpenFolder,
  onError,
}: LibraryViewProps) {
  const [root, setRoot] = useState<string | null>(null);
  const [series, setSeries] = useState<Series[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Series | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [where, all] = await Promise.all([libraryRoot(), librarySeries()]);
      setRoot(where);
      setSeries(all);
    } catch (e) {
      onError(String(e));
      setSeries([]);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const relocate = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      await setLibraryRoot(picked);
      await refresh();
    } catch (e) {
      onError(String(e));
    }
  }, [refresh, onError]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Library</h1>
          <button
            onClick={() => void relocate()}
            className="truncate text-[11px] text-muted-foreground hover:text-foreground"
            title={root ? `${root} — click to move the library` : undefined}
          >
            {root ?? "…"}
          </button>
        </div>

        <Hint label="Build a volume from a folder instead">
          <Button variant="ghost" size="icon" onClick={onOpenFolder}>
            <FolderOpen />
          </Button>
        </Hint>
        <Hint label="Reload the library">
          <Button variant="ghost" size="icon" onClick={() => void refresh()}>
            <RefreshCw />
          </Button>
        </Hint>
        <Button onClick={() => setAdding(true)}>
          <Plus />
          Add series
        </Button>
      </header>

      <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
        {series === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Opening the library…
          </div>
        ) : series.length === 0 ? (
          <div className="mx-auto mt-20 max-w-md text-center">
            <BookOpen className="mx-auto size-8 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-medium">Nothing here yet</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Add a series and Mangalize will pull its published volume layout,
              then tell you which chapters you are missing.
            </p>
            <Button className="mt-4" onClick={() => setAdding(true)}>
              <Plus />
              Add your first series
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
            {series.map((entry) => (
              <SeriesCard
                key={entry.id}
                series={entry}
                onOpen={() => onOpenSeries(entry.id)}
                onRemove={() => setRemoving(entry)}
              />
            ))}
          </div>
        )}
      </main>

      <AddSeriesDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(added) => {
          void refresh();
          onOpenSeries(added.id);
        }}
      />

      <RemoveSeriesDialog
        series={removing}
        onOpenChange={(next) => !next && setRemoving(null)}
        onRemoved={() => void refresh()}
      />
    </div>
  );
}

function SeriesCard({
  series,
  onOpen,
  onRemove,
}: {
  series: Series;
  onOpen: () => void;
  onRemove: () => void;
}) {
  // The cover is a file in the library, so it goes through the same thumbnail
  // cache as page images rather than a second mechanism.
  const { ref, url } = useThumbnail(series.cover_path ?? "", 300);
  const complete =
    series.known_chapters > 0 && series.have_chapters === series.known_chapters;

  // The remove control is a sibling of the card button, not a child: nesting a
  // button inside a button is invalid and the inner one stops being clickable.
  return (
    <div
      ref={ref}
      className="group relative overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-muted-foreground/40"
    >
      <button onClick={onOpen} className="flex w-full flex-col text-left">
        <div className="flex aspect-[10/15] w-full items-center justify-center bg-muted/40">
          {series.cover_path && url ? (
            <img src={url} alt="" className="h-full w-full object-cover" />
          ) : (
            <BookOpen className="size-6 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-col gap-1 p-2">
          <p className="truncate text-xs font-medium" title={series.title}>
            {series.title}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {series.author || "Unknown author"}
          </p>
          <Badge variant={complete ? "default" : "outline"} className="mt-0.5 w-fit">
            {series.have_chapters}/{series.known_chapters || "?"} chapters
          </Badge>
        </div>
      </button>

      <button
        onClick={onRemove}
        title={`Remove ${series.title} from the library`}
        className="absolute right-1.5 top-1.5 rounded-md bg-background/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
