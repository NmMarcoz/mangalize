import { useMemo } from "react";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  DEMOGRAPHICS,
  RATINGS,
  SORTS,
  STATUSES,
  TAG_GROUPS,
  sortKey,
  type BrowseQuery,
  type ContentRating,
  type Tag,
} from "@/lib/browse";
import { cn } from "@/lib/utils";

interface BrowseFiltersProps {
  query: BrowseQuery;
  tags: Tag[];
  onChange: (patch: Partial<BrowseQuery>) => void;
  onReset: () => void;
}

/**
 * The controls that make the panel useful without typing anything.
 *
 * Tags cycle through three states rather than offering two lists: off, include,
 * exclude. "Everything except romance" is a normal thing to want and a second
 * list of checkboxes is a miserable way to ask for it.
 */
export function BrowseFilters({ query, tags, onChange, onReset }: BrowseFiltersProps) {
  const grouped = useMemo(() => {
    const groups = new Map<string, Tag[]>();
    for (const tag of tags) {
      const list = groups.get(tag.group) ?? [];
      list.push(tag);
      groups.set(tag.group, list);
    }
    return [...groups.entries()];
  }, [tags]);

  const cycleTag = (id: string) => {
    if (query.included_tags.includes(id)) {
      onChange({
        included_tags: query.included_tags.filter((t) => t !== id),
        excluded_tags: [...query.excluded_tags, id],
      });
    } else if (query.excluded_tags.includes(id)) {
      onChange({ excluded_tags: query.excluded_tags.filter((t) => t !== id) });
    } else {
      onChange({ included_tags: [...query.included_tags, id] });
    }
  };

  const toggle = <T extends string>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <div className="scrollbar-thin flex max-h-[22rem] flex-col gap-4 overflow-y-auto border-b border-border bg-card/30 p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sort">Sort by</Label>
          <Select
            value={sortKey(query.sort, query.descending)}
            onValueChange={(v) => {
              const found = SORTS.find((s) => sortKey(s.value, s.descending) === v);
              if (found) onChange({ sort: found.value, descending: found.descending });
            }}
          >
            <SelectTrigger id="sort" className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
                <SelectItem key={sortKey(s.value, s.descending)} value={sortKey(s.value, s.descending)}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Content rating</Label>
          <div className="flex flex-wrap gap-1.5">
            {RATINGS.map((rating) => (
              <Chip
                key={rating.value}
                label={rating.label}
                state={query.content_ratings.includes(rating.value) ? "on" : "off"}
                onClick={() =>
                  onChange({
                    content_ratings: toggle<ContentRating>(
                      query.content_ratings,
                      rating.value,
                    ),
                  })
                }
              />
            ))}
          </div>
        </div>

        <Button variant="ghost" size="sm" className="ml-auto" onClick={onReset}>
          <X className="size-3" />
          Reset
        </Button>
      </div>

      <div className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-1.5">
          <Label>Status</Label>
          <div className="flex flex-wrap gap-1.5">
            {STATUSES.map((status) => (
              <Chip
                key={status}
                label={status}
                state={query.status.includes(status) ? "on" : "off"}
                onClick={() => onChange({ status: toggle(query.status, status) })}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Demographic</Label>
          <div className="flex flex-wrap gap-1.5">
            {DEMOGRAPHICS.map((demographic) => (
              <Chip
                key={demographic}
                label={demographic}
                state={query.demographic.includes(demographic) ? "on" : "off"}
                onClick={() =>
                  onChange({ demographic: toggle(query.demographic, demographic) })
                }
              />
            ))}
          </div>
        </div>
      </div>

      {grouped.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-muted-foreground">
              Click a tag to require it, again to exclude it, again to clear.
            </p>
            {grouped.map(([group, list]) => (
              <div key={group} className="flex flex-col gap-1.5">
                <Label>{TAG_GROUPS[group] ?? group}</Label>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((tag) => (
                    <Chip
                      key={tag.id}
                      label={tag.name}
                      state={
                        query.included_tags.includes(tag.id)
                          ? "on"
                          : query.excluded_tags.includes(tag.id)
                            ? "excluded"
                            : "off"
                      }
                      onClick={() => cycleTag(tag.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Chip({
  label,
  state,
  onClick,
}: {
  label: string;
  state: "off" | "on" | "excluded";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] capitalize transition-colors",
        state === "on" && "border-primary bg-primary/10 text-primary",
        state === "excluded" &&
          "border-destructive/50 bg-destructive/10 text-destructive line-through",
        state === "off" && "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
  );
}

/** A compact summary of what is currently narrowed, for the collapsed bar. */
export function FilterSummary({ query, tags }: { query: BrowseQuery; tags: Tag[] }) {
  const named = (ids: string[]) =>
    ids.map((id) => tags.find((t) => t.id === id)?.name ?? "tag");

  const parts = [
    ...named(query.included_tags),
    ...named(query.excluded_tags).map((n) => `not ${n}`),
    ...query.status,
    ...query.demographic,
  ];

  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {parts.slice(0, 4).map((part) => (
        <Badge key={part} variant="outline" className="capitalize">
          {part}
        </Badge>
      ))}
      {parts.length > 4 && (
        <span className="text-[10px] text-muted-foreground">
          +{parts.length - 4} more
        </span>
      )}
    </div>
  );
}
