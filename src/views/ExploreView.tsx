import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  Cloud,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";

import { BrowseFilters, FilterSummary } from "@/components/BrowseFilters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Hint } from "@/components/ui/tooltip";
import { useSeriesDetail } from "@/hooks/useSeriesDetail";
import { sourceLabel, type ChapterRef, type SeriesMatch } from "@/lib/api";
import {
  browseSeries,
  defaultQuery,
  isFiltered,
  mangadexTags,
  PAGE_SIZE,
  type BrowseQuery,
  type Tag,
} from "@/lib/browse";
import {
  downloadChapterFromSource,
  libraryAddSeries,
  librarySeries,
  type Series,
} from "@/lib/library";
import type { ReaderTarget } from "@/lib/reader";
import { cn } from "@/lib/utils";

interface ExploreViewProps {
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
 */
export function ExploreView({ onOpenSeries, onRead, onError }: ExploreViewProps) {
  const [query, setQuery] = useState<BrowseQuery>(defaultQuery);
  const [text, setText] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const [results, setResults] = useState<SeriesMatch[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SeriesMatch | null>(null);

  const [owned, setOwned] = useState<Series[]>([]);
  const [adding, setAdding] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);

  const detail = useSeriesDetail(selected, onError);

  /** Guards against a slow earlier page landing after a newer one. */
  const request = useRef(0);

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

  /** Run a browse. `append` keeps what is on screen and adds the next page. */
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
    setSelected(null);
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

  const existing = useMemo(
    () =>
      selected
        ? owned.find(
            (s) => s.source === selected.source && s.source_id === selected.id,
          ) ?? null
        : null,
    [owned, selected],
  );

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

  /**
   * Open a chapter in the reader without downloading it.
   *
   * The whole series' chapters are flattened first so the reader can move on to
   * the next one, including across a volume boundary.
   */
  const readChapter = useCallback(
    (chapter: ChapterRef) => {
      if (!selected || !chapter.id) return;

      const flat = detail.layout.flatMap((volume) => volume.chapters);
      const at = flat.findIndex((c) => c.number === chapter.number);
      const sibling = (index: number) => {
        const found = flat[index];
        return found?.id && !found.unavailable
          ? { id: found.id, number: found.number }
          : null;
      };

      onRead({
        kind: "online",
        source: selected.source,
        chapterId: chapter.id,
        seriesTitle:
          selected.title_english ?? selected.title_romaji ?? selected.title_native ?? "",
        chapterNumber: chapter.number,
        // MangaDex does not publish a reading direction, and nearly everything
        // it carries is drawn right to left.
        direction: "right-to-left",
        previous: at > 0 ? sibling(at - 1) : null,
        next: at >= 0 ? sibling(at + 1) : null,
        librarySeriesId: existing?.id ?? null,
      });
    },
    [selected, detail.layout, existing, onRead],
  );

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
            setSelected(null);
            setQuery(defaultQuery());
          }}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-5">
          {results.length === 0 && loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          ) : results.length === 0 ? (
            <p className="mt-16 text-center text-xs text-muted-foreground">
              Nothing matches those filters.
            </p>
          ) : (
            <>
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
          <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-card/40">
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
              <h2 className="text-sm font-semibold">
                {selected.title_english ?? selected.title_romaji ?? selected.title_native}
              </h2>
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
                  <ExternalLink className="size-3" /> View on{" "}
                  {sourceLabel(selected.source)}
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
                            onRead={() => readChapter(chapter)}
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
  onRead,
}: {
  chapter: ChapterRef;
  busy: boolean;
  onGet: () => void;
  onRead: () => void;
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
        <>
          <Hint label="Read now, streaming from the source">
            <Button variant="ghost" size="sm" onClick={onRead} disabled={busy}>
              <Cloud className="size-3" />
              Read
            </Button>
          </Hint>
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
        </>
      ) : (
        <Badge variant="outline" className="text-[9px]">
          URL only
        </Badge>
      )}
    </div>
  );
}
