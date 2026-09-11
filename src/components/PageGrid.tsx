import { Fragment } from "react";

import { PageCard } from "@/components/PageCard";
import { Badge } from "@/components/ui/badge";
import type { Chapter, Page } from "@/lib/api";

export interface PageGroup {
  chapterIndex: number;
  chapter: Chapter;
  pages: Page[];
}

interface PageGridProps {
  groups: PageGroup[];
  /** Position of each included page within the exported volume. */
  numbers: Map<string, number>;
  selection: Set<string>;
  coverPath: string | null;
  thumbWidth: number;
  /** True when a single chapter is in view, which makes headers redundant. */
  showHeaders: boolean;
  onSelect: (path: string, event: React.MouseEvent) => void;
  onToggleExclude: (paths: string[]) => void;
  onToggleSplit: (paths: string[]) => void;
  onSetCover: (path: string) => void;
}

export function PageGrid({
  groups,
  numbers,
  selection,
  coverPath,
  thumbWidth,
  showHeaders,
  onSelect,
  onToggleExclude,
  onToggleSplit,
  onSetCover,
}: PageGridProps) {
  return (
    <div className="flex flex-col gap-6 p-5">
      {groups.map((group) => {
        const excluded = group.chapter.pages.length - group.chapter.pages.filter((p) => p.excluded === null).length;
        const spreads = group.chapter.pages.filter(
          (p) => p.excluded === null && p.kind === "spread",
        ).length;

        return (
          <Fragment key={group.chapter.source}>
            {showHeaders && (
              <div className="sticky top-0 z-10 -mx-5 flex items-center gap-2 border-b border-border/60 bg-background/85 px-5 py-2 backdrop-blur">
                <h2 className="text-sm font-semibold">{group.chapter.title}</h2>
                <Badge variant="outline">
                  {group.chapter.pages.filter((p) => p.excluded === null).length} pages
                </Badge>
                {spreads > 0 && <Badge>{spreads} spreads</Badge>}
                {excluded > 0 && <Badge variant="warning">{excluded} excluded</Badge>}
              </div>
            )}
            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns: `repeat(auto-fill, minmax(${thumbWidth}px, 1fr))`,
              }}
            >
              {group.pages.map((page) => (
                <PageCard
                  key={page.path}
                  page={page}
                  number={numbers.get(page.path) ?? null}
                  selected={selection.has(page.path)}
                  isCover={coverPath === page.path}
                  width={thumbWidth}
                  onSelect={(e) => onSelect(page.path, e)}
                  onToggleExclude={() => onToggleExclude([page.path])}
                  onToggleSplit={() => onToggleSplit([page.path])}
                  onSetCover={() => onSetCover(page.path)}
                />
              ))}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
