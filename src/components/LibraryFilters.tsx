import { useMemo } from "react";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Series } from "@/lib/library";
import { cn } from "@/lib/utils";

/** How the grid is cut into sections, if at all. */
export type GroupBy = "none" | "tag" | "rating" | "status";

export interface LibraryFilter {
  /** Every one of these must be present. Narrowing, not widening. */
  tags: string[];
  /** Empty means every rating; otherwise only these. */
  ratings: string[];
  status: string | null;
  group: GroupBy;
}

export const noFilter = (): LibraryFilter => ({
  tags: [],
  ratings: [],
  status: null,
  group: "none",
});

export const isFiltering = (f: LibraryFilter) =>
  f.tags.length > 0 || f.ratings.length > 0 || f.status !== null;

/** Content ratings, mildest first — the same four MangaDex publishes. */
const RATINGS = ["safe", "suggestive", "erotica", "pornographic"];

/** Does this series pass? */
export function matches(series: Series, f: LibraryFilter): boolean {
  if (f.tags.some((t) => !series.tags.includes(t))) return false;
  if (f.ratings.length > 0 && !f.ratings.includes(series.content_rating ?? "")) {
    return false;
  }
  if (f.status && series.status !== f.status) return false;
  return true;
}

/**
 * Which section a series belongs in.
 *
 * A series has many tags but goes in one section, so grouping by tag uses the
 * first tag the filter asked for, falling back to the series' own first. That
 * makes "filter to Action, group by tag" mean what it looks like it means.
 */
export function sectionOf(series: Series, f: LibraryFilter): string {
  switch (f.group) {
    case "tag": {
      const preferred = f.tags.find((t) => series.tags.includes(t));
      return preferred ?? series.tags[0] ?? "Untagged";
    }
    case "rating":
      return series.content_rating ?? "Unrated";
    case "status":
      return series.status ?? "Unknown";
    default:
      return "";
  }
}

interface LibraryFiltersProps {
  filter: LibraryFilter;
  onChange: (next: LibraryFilter) => void;
  /** Everything in the library, to work out what is worth offering. */
  series: Series[];
}

/**
 * Narrowing a library down, and optionally cutting it into sections.
 *
 * The choices are built from what is actually in the library rather than from
 * the source's full vocabulary: a tag nothing carries is a dead option, and
 * MangaDex has a few hundred of them.
 */
export function LibraryFilters({ filter, onChange, series }: LibraryFiltersProps) {
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of series) {
      for (const tag of s.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  }, [series]);

  const ratings = useMemo(
    () => RATINGS.filter((r) => series.some((s) => s.content_rating === r)),
    [series],
  );

  const statuses = useMemo(
    () =>
      [...new Set(series.map((s) => s.status).filter((s): s is string => !!s))].sort(),
    [series],
  );

  const toggleTag = (tag: string) =>
    onChange({
      ...filter,
      tags: filter.tags.includes(tag)
        ? filter.tags.filter((t) => t !== tag)
        : [...filter.tags, tag],
    });

  const toggleRating = (rating: string) =>
    onChange({
      ...filter,
      ratings: filter.ratings.includes(rating)
        ? filter.ratings.filter((r) => r !== rating)
        : [...filter.ratings, rating],
    });

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-card/30 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">Tags</span>
        {tags.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">
            None recorded yet — re-add or refresh a series to pull them.
          </span>
        ) : (
          // Scrolled rather than wrapped to twenty rows: a big library has a lot
          // of tags, and the filter row should not push the grid off screen.
          <div className="scrollbar-thin flex max-h-16 flex-wrap gap-1 overflow-y-auto">
            {tags.map((tag) => (
              <button key={tag} onClick={() => toggleTag(tag)}>
                <Badge
                  variant={filter.tags.includes(tag) ? "default" : "outline"}
                  className={cn("cursor-pointer", !filter.tags.includes(tag) && "opacity-70")}
                >
                  {tag}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {ratings.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">Rating</span>
            {ratings.map((rating) => (
              <button key={rating} onClick={() => toggleRating(rating)}>
                <Badge
                  variant={filter.ratings.includes(rating) ? "default" : "outline"}
                  className="cursor-pointer"
                >
                  {rating}
                </Badge>
              </button>
            ))}
          </div>
        )}

        {statuses.length > 0 && (
          <Select
            value={filter.status ?? "any"}
            onValueChange={(v) => onChange({ ...filter, status: v === "any" ? null : v })}
          >
            <SelectTrigger className="h-7 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any status</SelectItem>
              {statuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select
          value={filter.group}
          onValueChange={(v) => onChange({ ...filter, group: v as GroupBy })}
        >
          <SelectTrigger className="h-7 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grouping</SelectItem>
            <SelectItem value="tag">Group by tag</SelectItem>
            <SelectItem value="rating">Group by rating</SelectItem>
            <SelectItem value="status">Group by status</SelectItem>
          </SelectContent>
        </Select>

        {isFiltering(filter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange({ ...noFilter(), group: filter.group })}
          >
            <X />
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
