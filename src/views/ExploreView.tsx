import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpen, Check, Compass, Loader2, Search, SlidersHorizontal } from "lucide-react";

import { BrowseFilters, FilterSummary } from "@/components/BrowseFilters";
import { RemoteImage } from "@/components/RemoteImage";
import { SeriesModal } from "@/components/SeriesModal";
import { SourceSeriesModal } from "@/components/SourceSeriesModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n";
import {
  latestSource,
  listSources,
  popularSource,
  searchSource,
  type SeriesMatch,
  type SourceInfo,
  type SourceManga,
} from "@/lib/api";
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

/** The id `MangaDex` is registered under, and Explore's own default. */
const MANGADEX = "mangadex";

/** What a visit to Explore is, so it can be picked up where it was left. */
export interface BrowseState {
  query: BrowseQuery;
  text: string;
  /** `"mangadex"`, or a registered `Source`'s own id. */
  source: string;
}

export const emptyBrowse = (): BrowseState => ({
  query: defaultQuery(),
  text: "",
  source: MANGADEX,
});

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
 * Browse the catalogue, not just search it — and from whichever source is
 * picked, not only MangaDex.
 *
 * MangaDex keeps its own rich tag/rating/status filtering (`MangaDexExplore`,
 * below), since nothing else registered offers anything close to it. A
 * registered `Source` — built in beyond MangaDex, or a `.lua` extension —
 * only ever answers a flat Popular/Latest/Search, so it gets the simpler
 * `RegisteredSourceExplore` instead. The picker between them lives here, one
 * level up, so switching source doesn't remount the MangaDex view's own
 * state (filters, scroll position) needlessly.
 */
export function ExploreView(props: ExploreViewProps) {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  useEffect(() => {
    listSources()
      .then(setSources)
      .catch(() => {});
  }, []);

  // MangaDex is offered natively, with its own filter UI, rather than as
  // just another registered `Source` — the registry lists it too, under
  // `leaf.mangadex` (so the download path can look it up by the same id
  // space as an extension), but showing it twice in one picker would be
  // confusing.
  const otherSources = useMemo(
    () => sources.filter((s) => s.id !== "leaf.mangadex"),
    [sources],
  );

  const setSource = useCallback(
    (source: string) => props.onBrowseChange((current) => ({ ...current, source })),
    [props.onBrowseChange],
  );

  if (props.browse.source !== MANGADEX && otherSources.some((s) => s.id === props.browse.source)) {
    return (
      <RegisteredSourceExplore
        {...props}
        sourceId={props.browse.source}
        sources={otherSources}
        onSourceChange={setSource}
      />
    );
  }

  return (
    <MangaDexExplore
      {...props}
      sourcePicker={
        otherSources.length > 0 ? (
          <SourcePicker value={MANGADEX} sources={otherSources} onChange={setSource} />
        ) : null
      }
    />
  );
}

function SourcePicker({
  value,
  sources,
  onChange,
}: {
  value: string;
  sources: SourceInfo[];
  onChange: (id: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-40 shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={MANGADEX}>MangaDex</SelectItem>
        {sources.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Opening on an empty search box asks the user to already know what they want,
 * which is the opposite of exploring. This opens on the most-followed series and
 * gives sorting, tags and content rating to move around with; the search box is
 * one more filter rather than the way in.
 *
 * Picking a series opens it as a dialog. Everything worth knowing about one —
 * rating, tags, a readable description, every translation it has — does not fit
 * in a panel narrow enough to leave this grid usable.
 */
function MangaDexExplore({
  browse,
  onBrowseChange,
  onOpenSeries,
  onRead,
  onError,
  sourcePicker,
}: ExploreViewProps & { sourcePicker: ReactNode }) {
  const t = useT();
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
        <h1 className="mr-2 text-sm font-semibold">{t("exploreView.title")}</h1>
        {sourcePicker}
        <Input
          value={text}
          placeholder={t("exploreView.searchPlaceholder")}
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
          {t("exploreView.filters")}
        </Button>

        {!showFilters && <FilterSummary query={query} tags={tags} />}

        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {total > 0 && t("exploreView.totalSeries", { total: total.toLocaleString() })}
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
            <Loader2 className="size-3.5 animate-spin" /> {t("exploreView.loading")}
          </div>
        ) : results.length === 0 ? (
          <div className="mx-auto mt-20 max-w-md text-center">
            <Compass className="mx-auto size-8 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-medium">{t("exploreView.noMatchesTitle")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("exploreView.noMatchesDescription")}
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
                  {t("exploreView.loadMore", { count: Math.min(PAGE_SIZE, total - results.length) })}
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
  const t = useT();
  return (
    <button
      onClick={onSelect}
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-muted-foreground/40"
    >
      <div className="relative flex aspect-[10/15] items-center justify-center bg-muted/40">
        {match.thumbnail_url ? (
          <RemoteImage url={match.thumbnail_url} max={256} className="h-full w-full" />
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
          {match.author ?? t("exploreView.unknownAuthor")}
          {match.year ? ` · ${match.year}` : ""}
        </p>
      </div>
    </button>
  );
}

/**
 * The registered-`Source` counterpart of `MangaDexExplore`.
 *
 * A `Source` only ever answers `popular(page)` / `latest(page)` /
 * `search(query, page)` — three flat lists, no tags, no status, no content
 * rating — so there is no filter panel here, only a Popular/Latest toggle
 * next to the search box. Pagination follows `has_next_page` rather than a
 * total count, since a `Source` is never asked to report one.
 */
function RegisteredSourceExplore({
  sourceId,
  sources,
  onSourceChange,
  onOpenSeries,
  onRead,
  onError,
}: {
  sourceId: string;
  sources: SourceInfo[];
  onSourceChange: (id: string) => void;
  onOpenSeries: (id: number) => void;
  onRead: (target: ReaderTarget) => void;
  onError: (message: string | null) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<"popular" | "latest">("popular");
  const [text, setText] = useState("");
  const [results, setResults] = useState<SourceManga[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SourceManga | null>(null);
  const [owned, setOwned] = useState<Series[]>([]);

  const request = useRef(0);
  const scroll = useRestoredScroll<HTMLElement>("explore-source", results.length > 0);

  const refreshOwned = useCallback(() => {
    librarySeries()
      .then(setOwned)
      .catch(() => {});
  }, []);
  useEffect(refreshOwned, [refreshOwned]);

  const run = useCallback(
    async (searchText: string, targetPage: number, append: boolean) => {
      const ticket = ++request.current;
      setLoading(true);
      onError(null);
      try {
        const found = searchText.trim()
          ? await searchSource(sourceId, searchText, targetPage)
          : mode === "popular"
            ? await popularSource(sourceId, targetPage)
            : await latestSource(sourceId, targetPage);
        if (ticket !== request.current) return;
        setResults((current) => (append ? [...current, ...found.manga] : found.manga));
        setHasMore(found.has_next_page);
      } catch (e) {
        if (ticket === request.current) onError(String(e));
      } finally {
        if (ticket === request.current) setLoading(false);
      }
    },
    [sourceId, mode, onError],
  );

  // A source or mode change starts a fresh first page; the search box is
  // submitted by hand instead, same as MangaDex's.
  useEffect(() => {
    setPage(1);
    void run("", 1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, mode]);

  const submitSearch = useCallback(() => {
    setPage(1);
    void run(text, 1, false);
  }, [text, run]);

  const loadMore = useCallback(() => {
    const next = page + 1;
    setPage(next);
    void run(text, next, true);
  }, [page, text, run]);

  const ownedFor = useCallback(
    (manga: SourceManga) =>
      owned.find((s) => s.source === sourceId && s.source_id === manga.id) ?? null,
    [owned, sourceId],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card/60 px-4 py-2.5">
        <h1 className="mr-2 text-sm font-semibold">{t("exploreView.title")}</h1>
        <SourcePicker value={sourceId} sources={sources} onChange={onSourceChange} />

        <div className="flex shrink-0 rounded-md border border-border p-0.5">
          <Button
            variant={mode === "popular" ? "default" : "ghost"}
            size="sm"
            onClick={() => setMode("popular")}
          >
            {t("exploreView.popular")}
          </Button>
          <Button
            variant={mode === "latest" ? "default" : "ghost"}
            size="sm"
            onClick={() => setMode("latest")}
          >
            {t("exploreView.latest")}
          </Button>
        </div>

        <Input
          value={text}
          placeholder={t("exploreView.searchSourcePlaceholder")}
          className="max-w-sm"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitSearch();
          }}
        />
        <Button variant="outline" size="icon" onClick={submitSearch}>
          <Search />
        </Button>
      </header>

      <main
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5"
      >
        {results.length === 0 && loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {t("exploreView.loading")}
          </div>
        ) : results.length === 0 ? (
          <div className="mx-auto mt-20 max-w-md text-center">
            <Compass className="mx-auto size-8 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-medium">{t("exploreView.emptyTitle")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("exploreView.emptyDescription")}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
              {results.map((manga) => (
                <SourceResultCard
                  key={manga.id}
                  manga={manga}
                  owned={ownedFor(manga) !== null}
                  onSelect={() => setSelected(manga)}
                />
              ))}
            </div>

            {hasMore && (
              <div className="mt-5 flex justify-center">
                <Button variant="outline" onClick={loadMore} disabled={loading}>
                  {loading && <Loader2 className="animate-spin" />}
                  {t("exploreView.loadMorePlain")}
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      {selected && (
        <SourceSeriesModal
          source={sourceId}
          manga={selected}
          owned={ownedFor(selected)}
          onClose={() => setSelected(null)}
          onOpenSeries={onOpenSeries}
          onRead={onRead}
          onAdded={refreshOwned}
          onError={onError}
        />
      )}
    </div>
  );
}

function SourceResultCard({
  manga,
  owned,
  onSelect,
}: {
  manga: SourceManga;
  owned: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-muted-foreground/40"
    >
      <div className="relative flex aspect-[10/15] items-center justify-center bg-muted/40">
        {manga.cover_url ? (
          <RemoteImage url={manga.cover_url} max={256} className="h-full w-full" />
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
        <p className="truncate text-xs font-medium">{manga.title}</p>
      </div>
    </button>
  );
}
