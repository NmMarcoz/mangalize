import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Check, Compass, Loader2, Search, SlidersHorizontal } from "lucide-react";

import { BrowseFilters, FilterSummary } from "@/components/BrowseFilters";
import { SeriesModal } from "@/components/SeriesModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SeriesMatch } from "@/lib/api";
import {
  browseSeries,
  defaultQuery,
  isFiltered,
  mangadexTags,
  PAGE_SIZE,
  type BrowseQuery,
  type Tag,
} from "@/lib/browse";
import { useRestoredScroll } from "@/hooks/useRestoredScroll";
import { librarySeries, type Series } from "@/lib/library";
import type { ReaderTarget } from "@/lib/reader";

/** What a visit to Explore is, so it can be picked up where it was left. */
export interface BrowseState {
  query: BrowseQuery;
  text: string;
}

export const emptyBrowse = (): BrowseState => ({ query: defaultQuery(), text: "" });

interface ExploreViewProps {
  browse: BrowseState;
  onBrowseChange: (update: (current: BrowseState) => BrowseState) => void;
  /** Jump to a series' page in the library. */
  onOpenSeries: (id: number) => void;
  /** Read a chapter straight from the source, without downloading it. */
  onRead: (target: ReaderTarget) => void;
  onError: (message: string | null) => void;
}

/**
 * Browse the catalogue, not just search it.
 *
 * Opening on an empty search box asks the user to already know what they want,
 * which is the opposite of exploring. This opens on the most-followed series and
 * gives sorting, tags and content rating to move around with; the search box is
 * one more filter rather than the way in.
 *
 * Picking a series opens it as a dialog. Everything worth knowing about one —
 * rating, tags, a readable description, every translation it has — does not fit
 * in a panel narrow enough to leave this grid usable.
 */
export function ExploreView({
  browse,
  onBrowseChange,
  onOpenSeries,
  onRead,
  onError,
}: ExploreViewProps) {
  // Held by the app rather than here: leaving for a series unmounts this view,
  // and coming back to a cleared filter bar and the top of the catalogue is not
  // "back", it is starting again.
  const { query, text } = browse;
  const setQuery = useCallback(
    (next: BrowseQuery | ((current: BrowseQuery) => BrowseQuery)) =>
      onBrowseChange((current) => ({
        ...current,
        query: typeof next === "function" ? next(current.query) : next,
      })),
    [onBrowseChange],
  );
  const setText = useCallback(
    (next: string) => onBrowseChange((current) => ({ ...current, text: next })),
    [onBrowseChange],
  );
  const [tags, setTags] = useState<Tag[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const [results, setResults] = useState<SeriesMatch[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SeriesMatch | null>(null);
  const [owned, setOwned] = useState<Series[]>([]);

  /** Guards against a slow earlier page landing after a newer one. */
  const request = useRef(0);

  // Restored once the first page of results is on screen; before that there is
  // nothing tall enough to scroll.
  const scroll = useRestoredScroll<HTMLElement>("explore", results.length > 0);

  const refreshOwned = useCallback(() => {
    librarySeries()
      .then(setOwned)
      .catch(() => {});
  }, []);

  useEffect(refreshOwned, [refreshOwned]);

  // The tag list is effectively static, so it is fetched once rather than with
  // every browse.
  useEffect(() => {
    mangadexTags()
      .then(setTags)
      .catch(() => {});
  }, []);

  const run = useCallback(
    async (next: BrowseQuery, append: boolean) => {
      const ticket = ++request.current;
      setLoading(true);
      onError(null);
      try {
        const page = await browseSeries(next);
        // A filter changed while this was in flight; its results are stale.
        if (ticket !== request.current) return;
        setResults((current) => (append ? [...current, ...page.series] : page.series));
        setTotal(page.total);
      } catch (e) {
        if (ticket === request.current) onError(String(e));
      } finally {
        if (ticket === request.current) setLoading(false);
      }
    },
    [onError],
  );

  // Any change to the query starts a fresh first page.
  useEffect(() => {
    void run({ ...query, offset: 0 }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    query.title,
    query.sort,
    query.descending,
    query.included_tags,
    query.excluded_tags,
    query.content_ratings,
    query.status,
    query.demographic,
  ]);

  const patch = useCallback((fields: Partial<BrowseQuery>) => {
    setQuery((current) => ({ ...current, ...fields, offset: 0 }));
  }, []);

  const submitSearch = useCallback(() => {
    const trimmed = text.trim();
    patch({
      title: trimmed || null,
      // Relevance is only meaningful with a term; dropping it on clear restores
      // an ordering that actually means something.
      sort: trimmed ? "relevance" : "follows",
      descending: true,
    });
  }, [text, patch]);

  const loadMore = useCallback(() => {
    const offset = results.length;
    setQuery((current) => ({ ...current, offset }));
    void run({ ...query, offset }, true);
  }, [results.length, query, run]);

  const ownedFor = useCallback(
    (match: SeriesMatch) =>
      owned.find((s) => s.source === match.source && s.source_id === match.id) ?? null,
    [owned],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card/60 px-4 py-2.5">
        <h1 className="mr-2 text-sm font-semibold">Explore</h1>
        <Input
          value={text}
          placeholder="Search by title, or just browse…"
          className="max-w-sm"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitSearch();
          }}
        />
        <Button variant="outline" size="icon" onClick={submitSearch}>
          <Search />
        </Button>

        <Button
          variant={showFilters || isFiltered(query) ? "default" : "ghost"}
          size="sm"
          onClick={() => setShowFilters((open) => !open)}
        >
          <SlidersHorizontal />
          Filters
        </Button>

        {!showFilters && <FilterSummary query={query} tags={tags} />}

        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {total > 0 && `${total.toLocaleString()} series`}
        </span>
      </header>

      {showFilters && (
        <BrowseFilters
          query={query}
          tags={tags}
          onChange={patch}
          onReset={() => {
            setText("");
            setQuery(defaultQuery());
          }}
        />
      )}

      <main
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5"
      >
        {results.length === 0 && loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        ) : results.length === 0 ? (
          <div className="mx-auto mt-20 max-w-md text-center">
            <Compass className="mx-auto size-8 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-medium">Nothing matches those filters</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Try widening the content rating, or clearing a tag or two.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
              {results.map((match) => (
                <ResultCard
                  key={`${match.source}-${match.id}`}
                  match={match}
                  owned={ownedFor(match) !== null}
                  onSelect={() => setSelected(match)}
                />
              ))}
            </div>

            {results.length < total && (
              <div className="mt-5 flex justify-center">
                <Button variant="outline" onClick={loadMore} disabled={loading}>
                  {loading && <Loader2 className="animate-spin" />}
                  Load {Math.min(PAGE_SIZE, total - results.length)} more
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      {selected && (
        <SeriesModal
          series={selected}
          owned={ownedFor(selected)}
          onClose={() => setSelected(null)}
          onOpenSeries={onOpenSeries}
          onRead={onRead}
          // Following a tag suggestion replaces what the dialog is showing
          // rather than stacking another one on top of it.
          onPick={setSelected}
          onAdded={refreshOwned}
          onError={onError}
        />
      )}
    </div>
  );
}

function ResultCard({
  match,
  owned,
  onSelect,
}: {
  match: SeriesMatch;
  owned: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-muted-foreground/40"
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
