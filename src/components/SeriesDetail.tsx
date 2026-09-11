import type { ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";

import { Label } from "@/components/ui/label";
import type { SeriesMatch } from "@/lib/api";
import type { SeriesDetailState } from "@/hooks/useSeriesDetail";
import { cn } from "@/lib/utils";

export type TitleChoice = "english" | "romaji" | "native";

interface SeriesDetailProps {
  selected: SeriesMatch | null;
  detail: SeriesDetailState;
  titleChoice: TitleChoice;
  onTitleChoice: (choice: TitleChoice) => void;
  /** Cover URL currently picked, or `null` for none. */
  chosenCover: string | null;
  onChooseCover: (url: string) => void;
  /** Slot for whatever the surrounding dialog wants to say about this series. */
  children?: ReactNode;
}

/**
 * The right-hand pane of a series lookup: which title to use, which volume
 * cover to take, and the description.
 *
 * Shared because picking a title and a cover is the same decision whether the
 * result is being applied to a scanned folder or added to the library.
 */
export function SeriesDetail({
  selected,
  detail,
  titleChoice,
  onTitleChoice,
  chosenCover,
  onChooseCover,
  children,
}: SeriesDetailProps) {
  if (!selected) {
    return (
      <p className="text-xs text-muted-foreground">
        Select a result to see titles, covers and the published volume layout.
      </p>
    );
  }

  return (
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
                onClick={() => onTitleChoice(choice)}
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

      {detail.loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading covers…
        </div>
      ) : (
        <>
          {children}

          {detail.covers.length > 0 && (
            <section className="flex flex-col gap-2">
              <Label>Cover ({detail.covers.length} volumes)</Label>
              <div className="grid grid-cols-6 gap-2">
                {detail.covers.map((cover) => (
                  <button
                    key={cover.url}
                    onClick={() => onChooseCover(cover.url)}
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
  );
}
