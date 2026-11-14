import { Layers, ScrollText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { includedPages, type Volume } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ChapterSidebarProps {
  volume: Volume;
  /** `null` shows every chapter at once. */
  active: number | null;
  onSelect: (index: number | null) => void;
}

export function ChapterSidebar({ volume, active, onSelect }: ChapterSidebarProps) {
  const total = volume.chapters.reduce((n, c) => n + includedPages(c).length, 0);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="px-3 pb-2 pt-4">
        <h2 className="px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Chapters
        </h2>
      </div>

      <nav className="scrollbar-thin flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
        <button
          onClick={() => onSelect(null)}
          className={cn(
            "flex w-full shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
            active === null
              ? "bg-primary/15 text-primary"
              : "text-foreground/80 hover:bg-accent",
          )}
        >
          <Layers className="size-4 shrink-0" />
          <span className="flex-1 truncate font-medium">All pages</span>
          <Badge variant="outline">{total}</Badge>
        </button>

        {volume.chapters.map((chapter, index) => {
          const included = includedPages(chapter).length;
          const excluded = chapter.pages.length - included;
          return (
            <button
              key={chapter.source}
              onClick={() => onSelect(index)}
              className={cn(
                "flex w-full shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                active === index
                  ? "bg-primary/15 text-primary"
                  : "text-foreground/80 hover:bg-accent",
              )}
            >
              <ScrollText className="size-4 shrink-0 opacity-70" />
              <span className="flex-1 truncate">{chapter.title}</span>
              {excluded > 0 && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-amber-500"
                  title={`${excluded} excluded`}
                />
              )}
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {included}
              </span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
