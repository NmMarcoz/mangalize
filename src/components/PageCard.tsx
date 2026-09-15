import { memo } from "react";
import { BookImage, EyeOff, ImageOff, Scissors, Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { useThumbnail } from "@/hooks/useThumbnail";
import { excludeLabel, fileName, type Page } from "@/lib/api";
import { isMobile } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface PageCardProps {
  page: Page;
  /** Position within the exported volume; blank for excluded pages. */
  number: number | null;
  selected: boolean;
  isCover: boolean;
  width: number;
  onSelect: (event: React.MouseEvent) => void;
  onToggleExclude: () => void;
  onToggleSplit: () => void;
  onSetCover: () => void;
}

function PageCardImpl({
  page,
  number,
  selected,
  isCover,
  width,
  onSelect,
  onToggleExclude,
  onToggleSplit,
  onSetCover,
}: PageCardProps) {
  // Request roughly double the display size so the grid stays sharp on HiDPI.
  const { ref, url, failed } = useThumbnail(page.path, Math.round(width * 2));
  const excluded = page.excluded !== null;
  const isSpread = page.kind === "spread";

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-lg border bg-card transition-all",
        selected
          ? "border-primary ring-2 ring-primary/60"
          : "border-border hover:border-primary/40",
        excluded && "opacity-45 saturate-0",
      )}
      style={{ width }}
    >
      <div
        className="relative flex items-center justify-center overflow-hidden bg-black/25"
        style={{ height: Math.round(width * 1.45) }}
      >
        {url ? (
          <img
            src={url}
            alt={fileName(page.path)}
            draggable={false}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
            {failed ? (
              <ImageOff className="size-5" />
            ) : (
              <BookImage className="size-5 animate-pulse opacity-50" />
            )}
          </div>
        )}

        <div className="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
          {number !== null && (
            <span className="rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] leading-none text-white">
              {number}
            </span>
          )}
          {isCover && (
            <span className="flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-foreground">
              <Star className="size-2.5 fill-current" />
              Cover
            </span>
          )}
        </div>

        <div className="pointer-events-none absolute right-1.5 top-1.5 flex flex-col items-end gap-1">
          {isSpread && (
            <Badge variant={page.split ? "warning" : "default"}>
              {page.split ? "Split" : "Spread"}
            </Badge>
          )}
          {excluded && page.excluded && (
            <Badge variant="destructive">{excludeLabel(page.excluded)}</Badge>
          )}
        </div>

        {/* Kept out of the flow so cards do not reflow. Revealed on hover on a
            desktop; always there on a touch screen, which has no hover and so
            had no way to include or exclude a page at all. */}
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-gradient-to-t from-black/85 to-transparent p-1.5 transition-opacity",
            !isMobile && "opacity-0 group-hover:opacity-100",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Hint label={excluded ? "Include (X)" : "Exclude (X)"}>
            <Button
              variant="secondary"
              size="icon-sm"
              onClick={onToggleExclude}
              aria-label={excluded ? "Include page" : "Exclude page"}
            >
              <EyeOff className="size-3.5" />
            </Button>
          </Hint>
          {isSpread && (
            <Hint label={page.split ? "Keep whole (S)" : "Split in two (S)"}>
              <Button
                variant={page.split ? "default" : "secondary"}
                size="icon-sm"
                onClick={onToggleSplit}
                aria-label="Toggle spread split"
              >
                <Scissors className="size-3.5" />
              </Button>
            </Hint>
          )}
          <Hint label="Use as cover (C)">
            <Button
              variant="secondary"
              size="icon-sm"
              onClick={onSetCover}
              disabled={excluded}
              aria-label="Use as cover"
            >
              <Star className="size-3.5" />
            </Button>
          </Hint>
        </div>
      </div>

      <div className="truncate px-2 py-1.5 text-[10px] text-muted-foreground">
        {fileName(page.path)}
      </div>
    </div>
  );
}

export const PageCard = memo(PageCardImpl);
