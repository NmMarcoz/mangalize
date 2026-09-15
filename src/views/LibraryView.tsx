import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  SlidersHorizontal,
} from "lucide-react";

import { AddSeriesDialog } from "@/components/AddSeriesDialog";
import { RemoveSeriesDialog } from "@/components/RemoveSeriesDialog";
import {
  isFiltering,
  LibraryFilters,
  matches,
  noFilter,
  sectionOf,
  type LibraryFilter,
} from "@/components/LibraryFilters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { useRestoredScroll } from "@/hooks/useRestoredScroll";
import { useThumbnail } from "@/hooks/useThumbnail";
import {
  libraryRoot,
  librarySeries,
  setLibraryRoot,
  type Series,
} from "@/lib/library";
import { canPickFolders, isMobile } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** What a visit to the library is, so it survives opening a series. */
export interface ShelfState {
  filter: LibraryFilter;
  showFilters: boolean;
}

export const emptyShelf = (): ShelfState => ({ filter: noFilter(), showFilters: false });

interface LibraryViewProps {
  shelf: ShelfState;
  onShelfChange: (update: (current: ShelfState) => ShelfState) => void;
  onOpenSeries: (id: number) => void;
  /** Escape hatch to the original scan-a-folder path. */
  onOpenFolder: () => void;
  onError: (message: string | null) => void;
}

/** The shelf: every series in the library, and the way to add another. */
export function LibraryView({
  shelf,
  onShelfChange,
  onOpenSeries,
  onOpenFolder,
  onError,
}: LibraryViewProps) {
  const [root, setRoot] = useState<string | null>(null);
  const [series, setSeries] = useState<Series[] | null>(null);
  const [adding, setAdding] = useState(false);
  // Held by the app: opening a series unmounts this view, and a filter you set
  // two taps ago should still be set when you come back.
  const { filter, showFilters } = shelf;
  const setFilter = useCallback(
    (next: LibraryFilter) => onShelfChange((current) => ({ ...current, filter: next })),
    [onShelfChange],
  );

  /**
   * The grid, narrowed and optionally cut into sections.
   *
   * One list of `[heading, entries]` either way: ungrouped is a single section
   * with no heading, so the grid does not need to know which mode it is in.
   */
  const scroll = useRestoredScroll<HTMLElement>("library", (series?.length ?? 0) > 0);

  const sections = useMemo<[string, Series[]][]>(() => {
    const kept = (series ?? []).filter((s) => matches(s, filter));
    if (filter.group === "none") return kept.length > 0 ? [["", kept]] : [];

    const buckets = new Map<string, Series[]>();
    for (const entry of kept) {
      const label = sectionOf(entry, filter);
      const bucket = buckets.get(label);
      if (bucket) bucket.push(entry);
      else buckets.set(label, [entry]);
    }
    // Biggest first: the sections that say most about a library go at the top,
    // and a tail of one-series groups is not what anyone is looking for.
    return [...buckets.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
  }, [series, filter]);
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
          {canPickFolders ? (
            <button
              onClick={() => void relocate()}
              className="block w-full truncate text-left text-[11px] text-muted-foreground hover:text-foreground"
              title={root ? `${root} — click to move the library` : undefined}
            >
              {root ?? "…"}
            </button>
          ) : (
            // Nowhere to move it to. See `canPickFolders`.
            <p className="truncate text-[11px] text-muted-foreground">{root ?? "…"}</p>
          )}
        </div>

        {canPickFolders && (
          <Hint label="Build a volume from a folder instead">
            <Button variant="ghost" size="icon" onClick={onOpenFolder}>
              <FolderOpen />
            </Button>
          </Hint>
        )}
        <Hint label="Reload the library">
          <Button variant="ghost" size="icon" onClick={() => void refresh()}>
            <RefreshCw />
          </Button>
        </Hint>
        <Button
          variant={showFilters || isFiltering(filter) ? "default" : "ghost"}
          size="sm"
          onClick={() =>
            onShelfChange((current) => ({ ...current, showFilters: !current.showFilters }))
          }
        >
          <SlidersHorizontal />
          Filters
        </Button>

        <Button onClick={() => setAdding(true)}>
          <Plus />
          Add series
        </Button>
      </header>

      {showFilters && series !== null && (
        <LibraryFilters filter={filter} onChange={setFilter} series={series} />
      )}

      <main
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5"
      >
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
          sections.length === 0 ? (
            <div className="mx-auto mt-20 max-w-md text-center">
              <BookOpen className="mx-auto size-8 text-muted-foreground" />
              <h2 className="mt-3 text-sm font-medium">Nothing matches those filters</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Try clearing a tag, or widening the content rating.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {sections.map(([label, entries]) => (
                <section key={label} className="flex flex-col gap-3">
                  {label && (
                    <div className="flex items-center gap-2">
                      <h2 className="text-xs font-semibold">{label}</h2>
                      <span className="text-[11px] text-muted-foreground">
                        {entries.length}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
                    {entries.map((entry) => (
                      <SeriesCard
                        key={entry.id}
                        series={entry}
                        onOpen={() => onOpenSeries(entry.id)}
                        onRemove={() => setRemoving(entry)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )
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
        className={cn(
          "absolute right-1.5 top-1.5 rounded-md bg-background/80 p-1.5 text-muted-foreground backdrop-blur-sm transition-opacity hover:text-destructive focus-visible:opacity-100",
          !isMobile && "opacity-0 group-hover:opacity-100",
        )}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
