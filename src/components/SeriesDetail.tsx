import type { ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";

import { RemoteImage } from "@/components/RemoteImage";
import { Chip } from "@/components/ui/chip";
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

const OVERLINE = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

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
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <p className={OVERLINE}>Title to use</p>
        <div role="radiogroup" aria-label="Title to use" className="flex flex-wrap gap-1.5">
          {(
            [
              ["english", selected.title_english],
              ["romaji", selected.title_romaji],
              ["native", selected.title_native],
            ] as const
          ).map(([choice, value]) =>
            value ? (
              <Chip
                key={choice}
                selected={titleChoice === choice}
                onClick={() => onTitleChoice(choice)}
              >
                {value}
                <span className="opacity-50">{choice}</span>
              </Chip>
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
              <p className={OVERLINE}>Cover ({detail.covers.length} volumes)</p>
              <div className="grid grid-cols-6 gap-3">
                {detail.covers.map((cover) => (
                  <button
                    key={cover.url}
                    onClick={() => onChooseCover(cover.url)}
                    className={cn(
                      "relative overflow-hidden rounded-md transition-shadow",
                      chosenCover === cover.url
                        ? "ring-2 ring-primary"
                        : "ring-1 ring-transparent hover:ring-border",
                    )}
                  >
                    <RemoteImage
                      url={cover.thumbnail_url}
                      max={256}
                      alt={`Volume ${cover.volume ?? "?"}`}
                      className="aspect-[10/15] w-full"
                    />
                    <span className="absolute bottom-0 left-0 right-0 bg-black/70 py-0.5 text-center text-[9px] text-white">
                      {cover.volume ? `v${cover.volume}` : "—"}
                    </span>
                    {chosenCover === cover.url && (
                      <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5">
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
        <section className="flex flex-col gap-2">
          <p className={OVERLINE}>Description</p>
          <p className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">
            {selected.description}
          </p>
        </section>
      )}
    </div>
  );
}
