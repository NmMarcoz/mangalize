import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Check, Cloud, Download, Loader2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Hint } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import {
  mangaDetailsSource,
  volumesSource,
  type ChapterRef,
  type SourceManga,
  type SourceMangaDetails,
  type VolumeChapters,
} from "@/lib/api";
import {
  addSeriesFromSource,
  downloadChapterFromSource,
  type Series,
} from "@/lib/library";
import type { ReaderTarget } from "@/lib/reader";
import { isMobile } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface SourceSeriesModalProps {
  source: string;
  manga: SourceManga;
  /** The library entry, when this series has already been added. */
  owned: Series | null;
  onClose: () => void;
  onOpenSeries: (id: number) => void;
  onRead: (target: ReaderTarget) => void;
  onAdded: () => void;
  onError: (message: string | null) => void;
}

/**
 * The registered-`Source` counterpart of `SeriesModal`.
 *
 * Deliberately simpler: a `Source` only ever answers a flat `manga_details` +
 * `volumes` pair, not MangaDex's statistics, tag-based similar-series search,
 * or per-translation chapter lists — so there is no rating, no "more like
 * this", and no language picker here.
 */
export function SourceSeriesModal({
  source,
  manga,
  owned,
  onClose,
  onOpenSeries,
  onRead,
  onAdded,
  onError,
}: SourceSeriesModalProps) {
  const t = useT();
  const [details, setDetails] = useState<SourceMangaDetails | null>(null);
  const [layout, setLayout] = useState<VolumeChapters[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setLayout(null);

    mangaDetailsSource(source, manga.id)
      .then((found) => !cancelled && setDetails(found))
      .catch((e) => !cancelled && onError(String(e)));

    volumesSource(source, manga.id)
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
  }, [source, manga.id, onError]);

  const flat = useMemo(
    () => (layout ?? []).flatMap((volume) => volume.chapters),
    [layout],
  );

  const title = details?.title ?? manga.title;

  const ensureAdded = useCallback(async (): Promise<Series | null> => {
    if (owned) return owned;
    const added = await addSeriesFromSource(source, manga.id, manga.title);
    onAdded();
    return added;
  }, [owned, source, manga.id, onAdded]);

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
      onRead({
        kind: "online",
        source,
        chapterId: chapter.id,
        seriesTitle: title,
        chapterNumber: chapter.number,
        // Nothing in `MangaDetails` says otherwise, and nearly every site a
        // `Source` extension targets is drawn right to left.
        direction: "right-to-left",
        language: "",
        chapters: flat
          .filter((c) => c.id && !c.unavailable)
          .map((c) => ({ id: c.id as string, number: c.number })),
        seriesSourceId: manga.id,
        coverUrl: details?.cover_url ?? manga.cover_url,
        librarySeriesId: owned?.id ?? null,
      });
    },
    [flat, source, manga.id, manga.cover_url, details?.cover_url, title, owned, onRead],
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
          <div className={cn("flex gap-4 p-5", isMobile && "flex-col")}>
            <div
              className={cn(
                "flex items-center justify-center overflow-hidden rounded-lg bg-muted/40",
                isMobile ? "h-52 w-36 self-start" : "h-56 w-40 shrink-0",
              )}
            >
              {(details?.cover_url ?? manga.cover_url) ? (
                <img
                  src={details?.cover_url ?? manga.cover_url ?? undefined}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <BookOpen className="size-6 text-muted-foreground" />
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <DialogTitle className="text-base leading-tight">{title}</DialogTitle>

              <p className="text-[11px] text-muted-foreground">
                {[details?.title_romaji, details?.title_native]
                  .filter((t) => t && t !== title)
                  .join(" · ")}
              </p>

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{details?.author ?? t("sourceSeriesModal.unknownAuthor")}</span>
                {details?.artist && details.artist !== details.author && (
                  <span>· {details.artist}</span>
                )}
              </div>

              {details?.content_rating && (
                <Badge
                  variant={details.content_rating === "safe" ? "outline" : "default"}
                  className="w-fit capitalize"
                >
                  {details.content_rating}
                </Badge>
              )}

              {details && details.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {details.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {details?.description && (
                <p className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                  {details.description}
                </p>
              )}
            </div>
          </div>

          <Separator />

          <div
            className={cn(
              "gap-3 px-5 py-3",
              isMobile ? "flex flex-col items-stretch" : "flex items-end",
            )}
          >
            <p className="flex-1 pb-2 text-[11px] text-muted-foreground">
              {layout && t("sourceSeriesModal.chaptersCount", { count: flat.length })}
            </p>

            {owned ? (
              <Button variant="outline" onClick={() => onOpenSeries(owned.id)}>
                <Check />
                {t("sourceSeriesModal.inLibrary")}
              </Button>
            ) : (
              <Button onClick={() => void add()} disabled={adding}>
                {adding ? <Loader2 className="animate-spin" /> : <Plus />}
                {t("sourceSeriesModal.addToLibrary")}
              </Button>
            )}
          </div>

          <div className="px-5 pb-5">
            {layout === null ? (
              <p className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />{" "}
                {t("sourceSeriesModal.loadingChapters")}
              </p>
            ) : flat.length === 0 ? (
              <p className="py-4 text-xs text-muted-foreground">
                {t("sourceSeriesModal.noChapters")}
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                {layout.map((volume) => (
                  <div key={volume.volume}>
                    <p className="sticky top-0 bg-card/95 px-2.5 py-1 text-[10px] font-medium text-muted-foreground backdrop-blur">
                      {t("sourceSeriesModal.volumeHeading", {
                        number: volume.volume,
                        count: volume.chapters.length,
                      })}
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
  const t = useT();
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
          <span className="text-amber-500/80">{t("sourceSeriesModal.notHosted")}</span>
        )}
      </span>

      {fetchable && (
        <>
          <Hint label={t("sourceSeriesModal.readHint")}>
            <Button variant="ghost" size="sm" onClick={onRead} disabled={busy}>
              <Cloud className="size-3" />
              {t("sourceSeriesModal.read")}
            </Button>
          </Hint>
          <Hint label={t("sourceSeriesModal.getHint")}>
            <Button variant="ghost" size="sm" onClick={onGet} disabled={busy}>
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Download className="size-3" />
              )}
              {t("sourceSeriesModal.get")}
            </Button>
          </Hint>
        </>
      )}
    </div>
  );
}
