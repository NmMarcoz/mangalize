import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  Cloud,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  Star,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Hint } from "@/components/ui/tooltip";
import {
  languageName,
  seriesChaptersIn,
  seriesStatistics,
  similarSeries,
  sourceLabel,
  type ChapterRef,
  type SeriesMatch,
  type Statistics,
  type VolumeChapters,
} from "@/lib/api";
import {
  downloadChapterFromSource,
  libraryAddSeries,
  type Series,
} from "@/lib/library";
import type { ReaderTarget } from "@/lib/reader";
import { isMobile } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface SeriesModalProps {
  series: SeriesMatch;
  /** The library entry, when this series has already been added. */
  owned: Series | null;
  onClose: () => void;
  onOpenSeries: (id: number) => void;
  onRead: (target: ReaderTarget) => void;
  /** Switch the modal to another series without closing it. */
  onPick: (series: SeriesMatch) => void;
  onAdded: () => void;
  onError: (message: string | null) => void;
}

/**
 * Everything about one series, over the browse rather than beside it.
 *
 * A side panel had to be narrow enough to leave the grid usable, which left no
 * room for the things that actually decide whether you want to read something —
 * the rating, the tags, a description you can read without a magnifying glass.
 */
export function SeriesModal({
  series,
  owned,
  onClose,
  onOpenSeries,
  onRead,
  onPick,
  onAdded,
  onError,
}: SeriesModalProps) {
  const [stats, setStats] = useState<Statistics | null>(null);
  const [similar, setSimilar] = useState<SeriesMatch[]>([]);
  const [layout, setLayout] = useState<VolumeChapters[] | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const title =
    series.title_english ?? series.title_romaji ?? series.title_native ?? "Untitled";

  /**
   * Which translation to show first.
   *
   * A series already in the library keeps whatever was chosen for it, so its
   * chapters stay consistent with what has been downloaded. Otherwise English
   * if it exists, else whatever does — an empty chapter list is a worse first
   * impression than one in a language you did not ask for.
   */
  useEffect(() => {
    const available = series.available_languages;
    const preferred =
      (owned?.language && available.includes(owned.language) && owned.language) ||
      (available.includes("en") ? "en" : available[0]) ||
      null;
    setLanguage(preferred);
    setExpanded(false);
  }, [series.id, series.available_languages, owned?.language]);

  // Rating and neighbours are independent of language and only fetched once.
  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setSimilar([]);

    seriesStatistics(series.source, series.id)
      .then((found) => !cancelled && setStats(found))
      .catch(() => {});

    const genres = series.tags.filter((t) => t.group === "genre").map((t) => t.id);
    similarSeries(series.source, genres, series.id)
      .then((found) => !cancelled && setSimilar(found))
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [series.source, series.id, series.tags]);

  // Chapters follow the chosen language.
  useEffect(() => {
    let cancelled = false;
    setLayout(null);

    seriesChaptersIn(series.source, series.id, language)
      .then((found) => !cancelled && setLayout(found))
      .catch((e) => {
        if (!cancelled) {
          onError(String(e));
          setLayout([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [series.source, series.id, language, onError]);

  const flat = useMemo(
    () => (layout ?? []).flatMap((volume) => volume.chapters),
    [layout],
  );

  const ensureAdded = useCallback(async (): Promise<Series | null> => {
    if (owned) return owned;
    const added = await libraryAddSeries(series, language);
    onAdded();
    return added;
  }, [owned, series, language, onAdded]);

  const add = useCallback(async () => {
    setAdding(true);
    onError(null);
    try {
      const entry = await ensureAdded();
      if (entry) onOpenSeries(entry.id);
    } catch (e) {
      onError(String(e));
    } finally {
      setAdding(false);
    }
  }, [ensureAdded, onOpenSeries, onError]);

  const readChapter = useCallback(
    (chapter: ChapterRef) => {
      if (!chapter.id) return;
      const at = flat.findIndex((c) => c.number === chapter.number);
      const sibling = (index: number) => {
        const found = flat[index];
        return found?.id && !found.unavailable
          ? { id: found.id, number: found.number }
          : null;
      };

      onRead({
        kind: "online",
        source: series.source,
        chapterId: chapter.id,
        seriesTitle: title,
        chapterNumber: chapter.number,
        // MangaDex publishes no reading direction, and nearly everything it
        // carries is drawn right to left.
        direction: "right-to-left",
        previous: at > 0 ? sibling(at - 1) : null,
        next: at >= 0 ? sibling(at + 1) : null,
        seriesSourceId: series.id,
        coverUrl: series.thumbnail_url ?? null,
        librarySeriesId: owned?.id ?? null,
      });
    },
    [flat, series.source, series.id, series.thumbnail_url, title, owned, onRead],
  );

  const getChapter = useCallback(
    async (chapter: ChapterRef) => {
      setFetching(chapter.number);
      onError(null);
      try {
        const entry = await ensureAdded();
        if (!entry) return;
        await downloadChapterFromSource(entry.id, chapter.number);
      } catch (e) {
        onError(String(e));
      } finally {
        setFetching(null);
      }
    },
    [ensureAdded, onError],
  );

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[88dvh] max-w-4xl">
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {/* ------------------------------------------------------ header */}
          {/* A 160px cover next to a text column leaves a phone barely 180px to
              set a description in, so there the cover goes above it instead. */}
          <div className={cn("flex gap-4 p-5", isMobile && "flex-col")}>
            <div
              className={cn(
                "flex items-center justify-center overflow-hidden rounded-lg bg-muted/40",
                isMobile ? "h-52 w-36 self-start" : "h-56 w-40 shrink-0",
              )}
            >
              {series.thumbnail_url ? (
                <img
                  src={series.thumbnail_url}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <BookOpen className="size-6 text-muted-foreground" />
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <DialogTitle className="text-base leading-tight">{title}</DialogTitle>

              {/* Alternate titles only when they add something. */}
              <p className="text-[11px] text-muted-foreground">
                {[series.title_romaji, series.title_native]
                  .filter((t) => t && t !== title)
                  .join(" · ")}
              </p>

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{series.author ?? "Unknown author"}</span>
                {series.artist && series.artist !== series.author && (
                  <span>· {series.artist}</span>
                )}
                {series.year && <span>· {series.year}</span>}
                {series.status && <span className="capitalize">· {series.status}</span>}
                {series.demographic && (
                  <span className="capitalize">· {series.demographic}</span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {stats?.rating != null && (
                  <Badge variant="outline">
                    <Star className="size-2.5" />
                    {stats.rating.toFixed(2)}
                  </Badge>
                )}
                {stats?.follows != null && (
                  <Badge variant="outline">
                    <Users className="size-2.5" />
                    {compact(stats.follows)}
                  </Badge>
                )}
                {series.content_rating && (
                  <Badge
                    variant={series.content_rating === "safe" ? "outline" : "default"}
                    className="capitalize"
                  >
                    {series.content_rating}
                  </Badge>
                )}
                {series.site_url && (
                  <a
                    href={series.site_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="size-3" />
                    {sourceLabel(series.source)}
                  </a>
                )}
              </div>

              {series.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {series.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}

              {series.description && (
                <div>
                  <p
                    className={cn(
                      "text-xs leading-relaxed text-muted-foreground",
                      !expanded && "line-clamp-4",
                    )}
                  >
                    {series.description}
                  </p>
                  {series.description.length > 300 && (
                    <button
                      onClick={() => setExpanded((v) => !v)}
                      className="mt-0.5 text-[11px] text-primary hover:underline"
                    >
                      {expanded ? "Show less" : "Show more"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* ---------------------------------------------------- chapters */}
          <div
            className={cn(
              "gap-3 px-5 py-3",
              isMobile ? "flex flex-col items-stretch" : "flex items-end",
            )}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="language">Translation</Label>
              <Select
                value={language ?? ""}
                onValueChange={(v) => setLanguage(v)}
                disabled={series.available_languages.length === 0}
              >
                <SelectTrigger id="language" className={isMobile ? "w-full" : "w-56"}>
                  <SelectValue placeholder="No translations listed" />
                </SelectTrigger>
                <SelectContent>
                  {series.available_languages.map((code) => (
                    <SelectItem key={code} value={code}>
                      {languageName(code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <p className={cn("text-[11px] text-muted-foreground", isMobile ? "-mt-1" : "flex-1 pb-2")}>
              {series.available_languages.length > 1 &&
                `${series.available_languages.length} translations available. `}
              {layout && `${flat.length} chapters in this one.`}
            </p>

            {owned ? (
              <Button variant="outline" onClick={() => onOpenSeries(owned.id)}>
                <Check />
                In your library
              </Button>
            ) : (
              <Button onClick={() => void add()} disabled={adding}>
                {adding ? <Loader2 className="animate-spin" /> : <Plus />}
                Add to library
              </Button>
            )}
          </div>

          <div className="px-5 pb-4">
            {layout === null ? (
              <p className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading chapters…
              </p>
            ) : flat.length === 0 ? (
              <p className="py-4 text-xs text-muted-foreground">
                No chapters in this translation.
                {series.available_languages.length > 1 && " Try another one."}
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                {layout.map((volume) => (
                  <div key={volume.volume}>
                    <p className="sticky top-0 bg-card/95 px-2.5 py-1 text-[10px] font-medium text-muted-foreground backdrop-blur">
                      Volume {volume.volume} · {volume.chapters.length}
                    </p>
                    {volume.chapters.map((chapter) => (
                      <ChapterRow
                        key={`${volume.volume}-${chapter.number}`}
                        chapter={chapter}
                        busy={fetching === chapter.number}
                        onRead={() => readChapter(chapter)}
                        onGet={() => void getChapter(chapter)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ----------------------------------------------------- similar */}
          {similar.length > 0 && (
            <>
              <Separator />
              <div className="px-5 py-4">
                <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                  {/* Deliberately not called "similar": this is a tag search,
                      and MangaDex publishes no similarity ranking. */}
                  More with these tags
                </p>
                <div className="scrollbar-thin flex gap-3 overflow-x-auto pb-1">
                  {similar.map((other) => (
                    <button
                      key={other.id}
                      onClick={() => onPick(other)}
                      className="w-24 shrink-0 text-left"
                    >
                      <div className="flex aspect-[10/15] items-center justify-center overflow-hidden rounded bg-muted/40">
                        {other.thumbnail_url ? (
                          <img
                            src={other.thumbnail_url}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover transition-opacity hover:opacity-80"
                          />
                        ) : (
                          <BookOpen className="size-4 text-muted-foreground" />
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[10px] leading-tight">
                        {other.title_english ?? other.title_romaji ?? other.title_native}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChapterRow({
  chapter,
  busy,
  onRead,
  onGet,
}: {
  chapter: ChapterRef;
  busy: boolean;
  onRead: () => void;
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
      <span className="w-12 shrink-0 font-mono">{chapter.number}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {!fetchable && (
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
          <Hint label="Download into your library">
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

/** 213106 -> 213k. Exact follow counts are noise. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
