import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { SeriesDetail, type TitleChoice } from "@/components/SeriesDetail";
import { SeriesSearch } from "@/components/SeriesSearch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useSeriesDetail } from "@/hooks/useSeriesDetail";
import type { SeriesMatch } from "@/lib/api";
import { libraryAddSeries, type Series } from "@/lib/library";

interface AddSeriesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (series: Series) => void;
}

/**
 * Search for a series and add it to the library.
 *
 * Adding also pulls the published volume layout, which is what turns the
 * library from a list of files into something that can say what is missing.
 */
export function AddSeriesDialog({ open, onOpenChange, onAdded }: AddSeriesDialogProps) {
  const [session, setSession] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SeriesMatch | null>(null);
  const [titleChoice, setTitleChoice] = useState<TitleChoice>("english");
  const [chosenCover, setChosenCover] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const detail = useSeriesDetail(selected, setError);

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
    setTitleChoice(
      match.title_english ? "english" : match.title_romaji ? "romaji" : "native",
    );
  }, []);

  const add = useCallback(async () => {
    if (!selected) return;
    setAdding(true);
    setError(null);
    try {
      // The title choice and the chosen cover ride along on the match, so the
      // backend stores what the user picked rather than re-deciding for itself.
      const title =
        (titleChoice === "english"
          ? selected.title_english
          : titleChoice === "romaji"
            ? selected.title_romaji
            : selected.title_native) ?? selected.title_english;

      const added = await libraryAddSeries({
        ...selected,
        title_english: title,
        thumbnail_url: chosenCover ?? selected.thumbnail_url,
      });
      onAdded(added);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }, [selected, titleChoice, chosenCover, onAdded, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-4xl">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>Add a series</DialogTitle>
          <DialogDescription>
            Searches MangaDex, falling back to Kitsu. Adding also pulls the
            published volume layout, so the library can tell you what is missing.
          </DialogDescription>
        </div>

        <div className="flex min-h-0 flex-1">
          <SeriesSearch
            initialQuery=""
            session={session}
            selected={selected}
            onSelect={choose}
            onError={setError}
          />

          <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-4">
            <SeriesDetail
              selected={selected}
              detail={detail}
              titleChoice={titleChoice}
              onTitleChoice={setTitleChoice}
              chosenCover={chosenCover}
              onChooseCover={setChosenCover}
            >
              {detail.layout.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {detail.layout.length} published volumes,{" "}
                  {detail.layout.reduce((n, v) => n + v.chapters.length, 0)}{" "}
                  chapters.
                </p>
              )}
            </SeriesDetail>
          </div>
        </div>

        <Separator />

        <div className="flex items-center gap-3 px-4 py-3">
          {error && (
            <p className="flex-1 truncate text-xs text-destructive" title={error}>
              {error}
            </p>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void add()} disabled={!selected || adding}>
              {adding ? <Loader2 className="animate-spin" /> : <Plus />}
              Add to library
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
