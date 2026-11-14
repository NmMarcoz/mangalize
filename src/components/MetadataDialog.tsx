import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import { SeriesDetail } from "@/components/SeriesDetail";
import { SeriesSearch } from "@/components/SeriesSearch";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { saveCover, type SeriesMatch, type VolumeChapters } from "@/lib/api";
import { useSeriesDetail } from "@/hooks/useSeriesDetail";

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
  const [session, setSession] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SeriesMatch | null>(null);
  const [titleChoice, setTitleChoice] = useState<"english" | "romaji" | "native">(
    "english",
  );
  const [chosenCover, setChosenCover] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const detail = useSeriesDetail(selected, setError);

  // Reopening should not show the previous session's results.
  useEffect(() => {
    if (!open) return;
    setSession((n) => n + 1);
    setSelected(null);
    setChosenCover(null);
    setError(null);
  }, [open]);

  const choose = useCallback((match: SeriesMatch) => {
    setSelected(match);
    setChosenCover(null);
    // Prefer whichever title form this entry actually has.
    setTitleChoice(
      match.title_english ? "english" : match.title_romaji ? "romaji" : "native",
    );
  }, []);

  // Preselect the cover for the volume being assembled, once covers arrive.
  useEffect(() => {
    if (detail.covers.length === 0) return;
    const wanted =
      volumeNumber !== null
        ? detail.covers.find((c) => c.volume === String(volumeNumber))
        : undefined;
    setChosenCover((wanted ?? detail.covers[0]).url);
  }, [detail.covers, volumeNumber]);

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

  const expected =
    volumeNumber !== null
      ? detail.layout.find((v) => v.volume === String(volumeNumber))
      : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-4xl">
        <DialogHeader>
          <DialogTitle>Fetch series metadata</DialogTitle>
          <DialogDescription>
            Searches MangaDex, falling back to Kitsu. Nothing is sent anywhere
            except the search term.
          </DialogDescription>
        </DialogHeader>

        {/* Same fixed-height split as AddSeriesDialog, for the same reason. */}
        <DialogBody className="h-[480px] flex-auto flex-row gap-0 overflow-hidden border-t border-border p-0">
          <SeriesSearch
            initialQuery={initialQuery}
            session={session}
            selected={selected}
            onSelect={choose}
            onError={setError}
          />

          <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-6">
            <SeriesDetail
              selected={selected}
              detail={detail}
              titleChoice={titleChoice}
              onTitleChoice={setTitleChoice}
              chosenCover={chosenCover}
              onChooseCover={setChosenCover}
            >
              {volumeNumber !== null && detail.layout.length > 0 && (
                <ChapterCheck
                  volumeNumber={volumeNumber}
                  expected={expected}
                  actual={chapterCount}
                />
              )}
            </SeriesDetail>
          </div>
        </DialogBody>

        <DialogFooter
          error={error}
          hint={
            selected?.site_url && (
              <a
                href={selected.site_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <ExternalLink className="size-3" /> View source
              </a>
            )
          }
        >
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={!selected || applying}>
            {applying && <Loader2 className="animate-spin" />}
            Apply
          </Button>
        </DialogFooter>
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
    <Callout
      tone={matches ? "success" : "warning"}
      title={
        <>
          Volume {volumeNumber} has {expected.chapters.length} chapters
          {matches ? " — matches your folder" : ` — your folder has ${actual}`}
        </>
      }
    >
      Chapters {expected.chapters.map((c) => c.number).join(", ")}
    </Callout>
  );
}
