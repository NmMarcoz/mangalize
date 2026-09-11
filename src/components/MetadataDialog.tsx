import { useCallback, useEffect, useState } from "react";
import { Check, CircleAlert, ExternalLink, Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  saveCover,
  searchSeries,
  seriesChapters,
  seriesCovers,
  sourceLabel,
  type SeriesMatch,
  type VolumeChapters,
  type VolumeCover,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/** Which of a series' three titles to write into the Series field. */
type TitleChoice = "english" | "romaji" | "native";

export interface AppliedMetadata {
  series: string;
  author: string;
  description: string;
  /** Local path of a downloaded cover, when one was chosen. */
  cover?: string;
}

interface MetadataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Seeds the search box. */
  initialQuery: string;
  /** Volume number being assembled, used to preselect a cover and check chapters. */
  volumeNumber: number | null;
  /** How many chapters the folder actually has, for the structure check. */
  chapterCount: number;
  onApply: (applied: AppliedMetadata) => void;
}

export function MetadataDialog({
  open,
  onOpenChange,
  initialQuery,
  volumeNumber,
  chapterCount,
  onApply,
}: MetadataDialogProps) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SeriesMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<SeriesMatch | null>(null);
  const [titleChoice, setTitleChoice] = useState<TitleChoice>("english");
  const [covers, setCovers] = useState<VolumeCover[]>([]);
  const [layout, setLayout] = useState<VolumeChapters[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [chosenCover, setChosenCover] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Reopening should not show the previous session's results.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setResults(null);
    setSelected(null);
    setCovers([]);
    setLayout([]);
    setChosenCover(null);
    setError(null);
  }, [open, initialQuery]);

  // Auto-run the search when opened with a title already filled in.
  useEffect(() => {
    if (open && initialQuery.trim()) void runSearch();
    // Only on open: re-running as the user edits the box would spam the API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = useCallback(
    async (match: SeriesMatch) => {
      setSelected(match);
      setLoadingDetail(true);
      setCovers([]);
      setLayout([]);
      setChosenCover(null);
      // Prefer whichever title form this entry actually has.
      setTitleChoice(
        match.title_english ? "english" : match.title_romaji ? "romaji" : "native",
      );

      try {
        const [foundCovers, foundLayout] = await Promise.all([
          seriesCovers(match.source, match.id),
          seriesChapters(match.source, match.id),
        ]);
        setCovers(foundCovers);
        setLayout(foundLayout);

        // Preselect the cover for the volume being assembled.
        const wanted =
          volumeNumber !== null
            ? foundCovers.find((c) => c.volume === String(volumeNumber))
            : undefined;
        setChosenCover((wanted ?? foundCovers[0])?.url ?? null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoadingDetail(false);
      }
    },
    [volumeNumber],
  );

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setSelected(null);
    try {
      const hits = await searchSeries(query);
      setResults(hits);
      if (hits.length === 0) {
        setError("No matches. Try the original Japanese title.");
      } else {
        void choose(hits[0]);
      }
    } catch (e) {
      setError(String(e));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, choose]);

  const apply = useCallback(async () => {
    if (!selected) return;
    setApplying(true);
    setError(null);
    try {
      const series =
        (titleChoice === "english"
          ? selected.title_english
          : titleChoice === "romaji"
            ? selected.title_romaji
            : selected.title_native) ?? "";

      // The artist is worth keeping when it differs; manga is usually a pair.
      const author = [selected.author, selected.artist]
        .filter((n, i, all) => n && all.indexOf(n) === i)
        .join(", ");

      let cover: string | undefined;
      if (chosenCover) cover = await saveCover(chosenCover);

      onApply({
        series,
        author,
        description: selected.description ?? "",
        cover,
      });
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  }, [selected, titleChoice, chosenCover, onApply, onOpenChange]);

  const expected = volumeNumber !== null
    ? layout.find((v) => v.volume === String(volumeNumber))
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>Fetch series metadata</DialogTitle>
          <DialogDescription>
            Searches MangaDex, falling back to Kitsu. Nothing is sent anywhere
            except the search term.
          </DialogDescription>
        </div>

        <div className="flex items-center gap-2 px-4 py-3">
          <Input
            autoFocus
            value={query}
            placeholder="Series name…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch();
            }}
          />
          <Button onClick={() => void runSearch()} disabled={searching}>
            {searching ? <Loader2 className="animate-spin" /> : <Search />}
            Search
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 border-t border-border">
          <div className="scrollbar-thin w-72 shrink-0 overflow-y-auto border-r border-border">
            {results === null && !searching && (
              <p className="p-4 text-xs text-muted-foreground">
                Press Enter to search.
              </p>
            )}
            {results?.map((match) => (
              <button
                key={`${match.source}-${match.id}`}
                onClick={() => void choose(match)}
                className={cn(
                  "flex w-full gap-2.5 border-b border-border/50 p-2.5 text-left transition-colors",
                  selected?.id === match.id ? "bg-primary/10" : "hover:bg-accent",
                )}
              >
                {match.thumbnail_url ? (
                  <img
                    src={match.thumbnail_url}
                    alt=""
                    loading="lazy"
                    className="h-16 w-12 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-16 w-12 shrink-0 rounded bg-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">
                    {match.title_english ?? match.title_romaji ?? match.title_native}
                  </p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {match.author ?? "Unknown author"}
                    {match.year ? ` · ${match.year}` : ""}
                  </p>
                  <Badge variant="outline" className="mt-1">
                    {sourceLabel(match.source)}
                  </Badge>
                </div>
              </button>
            ))}
          </div>

          <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-4">
            {!selected ? (
              <p className="text-xs text-muted-foreground">
                Select a result to see titles, covers and the published volume
                layout.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                <section className="flex flex-col gap-2">
                  <Label>Title to use</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ["english", selected.title_english],
                        ["romaji", selected.title_romaji],
                        ["native", selected.title_native],
                      ] as const
                    ).map(([choice, value]) =>
                      value ? (
                        <button
                          key={choice}
                          onClick={() => setTitleChoice(choice)}
                          className={cn(
                            "rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                            titleChoice === choice
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border hover:bg-accent",
                          )}
                        >
                          {value}
                          <span className="ml-1.5 opacity-50">{choice}</span>
                        </button>
                      ) : null,
                    )}
                  </div>
                </section>

                {loadingDetail ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Loading covers…
                  </div>
                ) : (
                  <>
                    {volumeNumber !== null && layout.length > 0 && (
                      <ChapterCheck
                        volumeNumber={volumeNumber}
                        expected={expected}
                        actual={chapterCount}
                      />
                    )}

                    {covers.length > 0 && (
                      <section className="flex flex-col gap-2">
                        <Label>Cover ({covers.length} volumes)</Label>
                        <div className="grid grid-cols-6 gap-2">
                          {covers.map((cover) => (
                            <button
                              key={cover.url}
                              onClick={() => setChosenCover(cover.url)}
                              className={cn(
                                "relative overflow-hidden rounded border-2 transition-colors",
                                chosenCover === cover.url
                                  ? "border-primary"
                                  : "border-transparent hover:border-border",
                              )}
                            >
                              <img
                                src={cover.thumbnail_url}
                                alt={`Volume ${cover.volume ?? "?"}`}
                                loading="lazy"
                                className="aspect-[10/15] w-full object-cover"
                              />
                              <span className="absolute bottom-0 left-0 right-0 bg-black/70 py-0.5 text-center text-[9px] text-white">
                                {cover.volume ? `v${cover.volume}` : "—"}
                              </span>
                              {chosenCover === cover.url && (
                                <span className="absolute right-0.5 top-0.5 rounded-full bg-primary p-0.5">
                                  <Check className="size-2.5 text-primary-foreground" />
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      </section>
                    )}
                  </>
                )}

                {selected.description && (
                  <section className="flex flex-col gap-1.5">
                    <Label>Description</Label>
                    <p className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                      {selected.description}
                    </p>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>

        <Separator />

        <div className="flex items-center gap-3 px-4 py-3">
          {error && (
            <p className="flex-1 truncate text-xs text-destructive" title={error}>
              {error}
            </p>
          )}
          {!error && selected?.site_url && (
            <a
              href={selected.site_url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3" /> View source
            </a>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void apply()} disabled={!selected || applying}>
              {applying && <Loader2 className="animate-spin" />}
              Apply
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compares the folder's chapter count against the published volume. */
function ChapterCheck({
  volumeNumber,
  expected,
  actual,
}: {
  volumeNumber: number;
  expected: VolumeChapters | undefined;
  actual: number;
}) {
  if (!expected) {
    return (
      <p className="text-xs text-muted-foreground">
        No published layout for volume {volumeNumber}.
      </p>
    );
  }

  const matches = expected.chapters.length === actual;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        matches
          ? "border-primary/30 bg-primary/5 text-foreground"
          : "border-amber-500/40 bg-amber-500/5 text-foreground",
      )}
    >
      {matches ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
      ) : (
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      )}
      <div>
        <p className="font-medium">
          Volume {volumeNumber} has {expected.chapters.length} chapters
          {matches ? " — matches your folder" : ` — your folder has ${actual}`}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          Chapters {expected.chapters.join(", ")}
        </p>
      </div>
    </div>
  );
}
