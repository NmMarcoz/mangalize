import { useCallback, useMemo, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpWideNarrow, Check, Layers, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChapterStatus } from "@/lib/library";
import { cn } from "@/lib/utils";

interface OrganizeChaptersPanelProps {
  chapters: ChapterStatus[];
  onAssign: (numbers: string[], volume: string) => Promise<void>;
  onDone: () => void;
}

/**
 * Manually sort a batch of Unsorted chapters into a volume.
 *
 * Mirrors the volume grid's own click / ctrl+click / shift+click
 * range-select gestures (`SeriesView.tsx`'s `pick`), just keyed on chapter
 * number instead of volume number, and without that gesture's "also open
 * it" side effect — there's nothing to drill into here, only a batch to
 * build up before assigning it.
 */
export function OrganizeChaptersPanel({ chapters, onAssign, onDone }: OrganizeChaptersPanelProps) {
  const [descending, setDescending] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [volume, setVolume] = useState("");
  const [assigning, setAssigning] = useState(false);

  const ordered = useMemo(
    () => (descending ? [...chapters].reverse() : chapters),
    [chapters, descending],
  );
  const order = useMemo(() => ordered.map((c) => c.number), [ordered]);

  const pick = useCallback(
    (number: string, event: React.MouseEvent) => {
      if (event.shiftKey && anchor) {
        const from = order.indexOf(anchor);
        const to = order.indexOf(number);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setPicked((prev) => new Set([...prev, ...order.slice(lo, hi + 1)]));
          return;
        }
      }
      if (event.metaKey || event.ctrlKey) {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(number)) next.delete(number);
          else next.add(number);
          return next;
        });
        setAnchor(number);
        return;
      }
      // A plain tap/click replaces the selection with just this one, the
      // same as the volume grid — there's no modifier on a phone.
      setPicked(new Set([number]));
      setAnchor(number);
    },
    [anchor, order],
  );

  const assign = useCallback(async () => {
    const target = volume.trim();
    if (!target || picked.size === 0) return;
    setAssigning(true);
    try {
      await onAssign(Array.from(picked), target);
      setPicked(new Set());
      setVolume("");
    } finally {
      setAssigning(false);
    }
  }, [volume, picked, onAssign]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => setDescending((d) => !d)}>
          {descending ? <ArrowDownWideNarrow className="size-3.5" /> : <ArrowUpWideNarrow className="size-3.5" />}
          {descending ? "Newest first" : "Oldest first"}
        </Button>
        <span className="flex-1 truncate text-[11px] text-muted-foreground">
          {picked.size > 0 ? `${picked.size} selected` : "Tap to select, shift+click to select a range"}
        </span>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {ordered.map((chapter) => {
          const isPicked = picked.has(chapter.number);
          return (
            <button
              key={chapter.number}
              onClick={(e) => pick(chapter.number, e)}
              className={cn(
                "flex w-full items-center gap-2.5 border-b border-border/50 px-3 py-1.5 text-left last:border-b-0",
                isPicked ? "bg-primary/10" : "hover:bg-accent",
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded border",
                  isPicked ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}
              >
                {isPicked && <Check className="size-3" />}
              </span>
              <span className="w-12 shrink-0 font-mono text-xs">{chapter.number}</span>
              {chapter.title && (
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {chapter.title}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {picked.size > 0 && (
        <div className="flex items-center gap-2 border-t border-border p-3">
          <Input
            autoFocus
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
            placeholder="Volume…"
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") void assign();
            }}
          />
          <Button onClick={() => void assign()} disabled={!volume.trim() || assigning}>
            {assigning ? <Loader2 className="animate-spin" /> : <Layers />}
            Assign {picked.size}
          </Button>
        </div>
      )}
    </div>
  );
}
