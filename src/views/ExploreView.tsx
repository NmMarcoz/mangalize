import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  Compass,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Hint } from "@/components/ui/tooltip";
import { useSeriesDetail } from "@/hooks/useSeriesDetail";
import {
  searchSeries,
  sourceLabel,
  type ChapterRef,
  type SeriesMatch,
} from "@/lib/api";
import {
  downloadChapterFromSource,
  libraryAddSeries,
  librarySeries,
  type Series,
} from "@/lib/library";
import { cn } from "@/lib/utils";

interface ExploreViewProps {
  /** Jump to a series' page in the library. */
  onOpenSeries: (id: number) => void;
  onError: (message: string | null) => void;
}

/**
 * Search the metadata sources and pull chapters without leaving the app.
 *
 * The library is for things you have; this is for finding things you do not.
 * Adding is idempotent, so downloading a chapter from here quietly adds the
 * series first rather than making that a separate step.
 */
export function ExploreView({ onOpenSeries, onError }: ExploreViewProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SeriesMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SeriesMatch | null>(null);

  const [owned, setOwned] = useState<Series[]>([]);
  const [adding, setAdding] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);

  const detail = useSeriesDetail(selected, onError);

  const refreshOwned = useCallback(() => {
    librarySeries()
      .then(setOwned)
      .catch(() => {});
  }, []);

  useEffect(refreshOwned, [refreshOwned]);

  /** The library entry for the selected result, when there is one. */
  const existing = useMemo(
    () =>
      selected
        ? owned.find(
            (s) => s.source === selected.source && s.source_id === selected.id,
          ) ?? null
        : null,
    [owned, selected],
  );

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSelected(null);
    onError(null);
    try {
      const hits = await searchSeries(query);
      setResults(hits);
      if (hits.length === 0) {
        onError("No matches. Try the original Japanese title.");
      }
    } catch (e) {
      onError(String(e));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, onError]);

  /** Add to the library, returning the entry so a download can follow. */
  const ensureAdded = useCallback(async (): Promise<Series | null> => {
    if (!selected) return null;
    if (existing) return existing;
    const added = await libraryAddSeries(selected);
    refreshOwned();
    return added;
  }, [selected, existing, refreshOwned]);

  const add = useCallback(async () => {
    setAdding(true);
    onError(null);
    try {
      const series = await ensureAdded();
      if (series) onOpenSeries(series.id);
    } catch (e) {
      onError(String(e));
    } finally {
      setAdding(false);
    }
  }, [ensureAdded, onOpenSeries, onError]);

  const getChapter = useCallback(
    async (chapter: ChapterRef) => {
      setFetching(chapter.number);
      onError(null);
      try {
        // Adding first rather than asking the user to: a chapter has to live
        // in a series folder, and they have already said what they want.
        const series = await ensureAdded();
        if (!series) return;
        await downloadChapterFromSource(series.id, chapter.number);
        refreshOwned();
      } catch (e) {
        onError(String(e));
      } finally {
        setFetching(null);
      }
    },
    [ensureAdded, refreshOwned, onError],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card/60 px-4 py-2.5">
        <h1 className="mr-2 text-sm font-semibold">Explore</h1>
        <Input
          autoFocus
          value={query}
          placeholder="Search MangaDex…"
          className="max-w-md"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
        />
        <Button onClick={() => void runSearch()} disabled={searching || !query.trim()}>
          {searching ? <Loader2 className="animate-spin" /> : <Search />}
          Search
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-5">
          {results === null ? (
            <div className="mx-auto mt-20 max-w-md text-center">
              <Compass className="mx-auto size-8 text-muted-foreground" />
              <h2 className="mt-3 text-sm font-medium">Find something to read</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Search MangaDex by title. Anything it hosts can be pulled
                straight in; anything it only indexes will say so, and you can
                still fetch it by pasting a URL from the series page.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
              {results.map((match) => (
                <ResultCard
                  key={`${match.source}-${match.id}`}
                  match={match}
                  selected={selected?.id === match.id}
                  owned={owned.some(
                    (s) => s.source === match.source && s.source_id === match.id,
                  )}
                  onSelect={() => setSelected(match)}
                />
              ))}
            </div>
          )}
        </main>

        {selected && (
          <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-card/40">
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
              <h2 className="text-sm font-semibold">{selected.title_english ?? selected.title_romaji ?? selected.title_native}</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {[selected.author, selected.year, selected.status]
                  .filter(Boolean)
                  .join(" · ")}
              </p>

              {selected.description && (
                <p className="mt-3 line-clamp-6 text-xs leading-relaxed text-muted-foreground">
                  {selected.description}
                </p>
              )}

              {selected.site_url && (
                <a
                  href={selected.site_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3" /> View on {sourceLabel(selected.source)}
                </a>
              )}

              <div className="mt-4">
                {detail.loading ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Loading chapters…
                  </p>
                ) : detail.layout.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No published volume layout for this series.
                  </p>
                ) : (
                  detail.layout.map((volume) => (
                    <section key={volume.volume} className="mb-4">
                      <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">
                        Volume {volume.volume} · {volume.chapters.length} chapters
                      </h3>
                      <div className="overflow-hidden rounded-md border border-border">
                        {volume.chapters.map((chapter) => (
                          <ChapterRow
                            key={chapter.number}
                            chapter={chapter}
                            busy={fetching === chapter.number}
                            onGet={() => void getChapter(chapter)}
                          />
                        ))}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>

            <div className="border-t border-border p-3">
              {existing ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => onOpenSeries(existing.id)}
                >
                  <Check />
                  In your library — open it
                </Button>
              ) : (
                <Button className="w-full" onClick={() => void add()} disabled={adding}>
                  {adding ? <Loader2 className="animate-spin" /> : <Plus />}
                  Add to library
                </Button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function ResultCard({
  match,
  selected,
  owned,
  onSelect,
}: {
  match: SeriesMatch;
  selected: boolean;
  owned: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors",
        selected
          ? "border-primary ring-2 ring-primary/40"
          : "border-border hover:border-muted-foreground/40",
      )}
    >
      <div className="relative flex aspect-[10/15] items-center justify-center bg-muted/40">
        {match.thumbnail_url ? (
          <img
            src={match.thumbnail_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <BookOpen className="size-5 text-muted-foreground" />
        )}
        {owned && (
          <span className="absolute right-1 top-1 rounded-full bg-primary p-1">
            <Check className="size-2.5 text-primary-foreground" />
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-2">
        <p className="truncate text-xs font-medium">
          {match.title_english ?? match.title_romaji ?? match.title_native}
        </p>
        <p className="truncate text-[10px] text-muted-foreground">
          {match.author ?? "Unknown author"}
          {match.year ? ` · ${match.year}` : ""}
        </p>
      </div>
    </button>
  );
}

function ChapterRow({
  chapter,
  busy,
  onGet,
}: {
  chapter: ChapterRef;
  busy: boolean;
  onGet: () => void;
}) {
  const fetchable = chapter.id !== null && !chapter.unavailable;

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border/50 px-2.5 py-1 text-[11px] last:border-b-0",
        !fetchable && "bg-amber-500/[0.03]",
      )}
    >
      <span className="w-10 shrink-0 font-mono">{chapter.number}</span>

      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {fetchable ? (
          ""
        ) : (
          // The source lists it but the publisher hosts it. Saying so here is
          // what stops this looking like something that failed.
          <span className="text-amber-500/80">not hosted by the source</span>
        )}
      </span>

      {fetchable ? (
        <Hint label="Download this chapter into your library">
          <Button variant="ghost" size="sm" onClick={onGet} disabled={busy}>
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Download className="size-3" />
            )}
            Get
          </Button>
        </Hint>
      ) : (
        <Badge variant="outline" className="text-[9px]">
          URL only
        </Badge>
      )}
    </div>
  );
}
