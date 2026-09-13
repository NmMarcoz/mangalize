import { useCallback, useEffect, useState } from "react";
import { BookOpen, Check, Clock, Loader2, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { useThumbnail } from "@/hooks/useThumbnail";
import { clearReadingProgress, readingHistory, type HistoryEntry } from "@/lib/reader";
import { cn } from "@/lib/utils";

interface HistoryViewProps {
  /**
   * Reopen an entry.
   *
   * The entry says how it was read, because history does not care and the
   * reader does: a downloaded chapter comes off disk, a streamed one goes back
   * to the source.
   */
  onRead: (entry: HistoryEntry) => void;
  onOpenSeries: (id: number) => void;
  onError: (message: string | null) => void;
}

/** How many entries to show. Far more than anyone scrolls, cheap to fetch. */
const LIMIT = 100;

/** What you were reading, most recent first. */
export function HistoryView({ onRead, onOpenSeries, onError }: HistoryViewProps) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  const refresh = useCallback(() => {
    readingHistory(LIMIT)
      .then(setEntries)
      .catch((e) => {
        onError(String(e));
        setEntries([]);
      });
  }, [onError]);

  useEffect(refresh, [refresh]);

  const forget = useCallback(
    async (entry: HistoryEntry) => {
      onError(null);
      try {
        await clearReadingProgress(entry.series_id, entry.chapter);
        refresh();
      } catch (e) {
        onError(String(e));
      }
    },
    [refresh, onError],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4 py-2.5">
        <h1 className="flex-1 text-sm font-semibold">History</h1>
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      </header>

      <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
        {entries === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="mx-auto mt-20 max-w-md text-center">
            <Clock className="mx-auto size-8 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-medium">Nothing read yet</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Chapters you open appear here, with the page you stopped on.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
            {entries.map((entry) => (
              <Row
                key={`${entry.series_id}-${entry.chapter}-${entry.opened_at}`}
                entry={entry}
                onRead={() => onRead(entry)}
                onOpenSeries={() => onOpenSeries(entry.series_id)}
                onForget={() => void forget(entry)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function Row({
  entry,
  onRead,
  onOpenSeries,
  onForget,
}: {
  entry: HistoryEntry;
  onRead: () => void;
  onOpenSeries: () => void;
  onForget: () => void;
}) {
  const { ref, url } = useThumbnail(entry.cover_path ?? "", 120);
  const progress =
    entry.page_count > 0 ? ((entry.last_page + 1) / entry.page_count) * 100 : 0;

  return (
    <div
      ref={ref}
      className="group flex items-center gap-3 rounded-lg border border-border bg-card p-2.5"
    >
      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/40">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <BookOpen className="size-4 text-muted-foreground" />
        )}
      </div>

      <button onClick={onOpenSeries} className="min-w-0 flex-1 text-left">
        <p className="truncate text-xs font-medium">{entry.series_title}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          Chapter {entry.chapter} ·{" "}
          {entry.finished
            ? "finished"
            : `page ${entry.last_page + 1} of ${entry.page_count}`}{" "}
          · {relative(entry.opened_at)}
        </p>
        {!entry.finished && (
          <div className="mt-1 h-0.5 w-full max-w-48 rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        )}
      </button>

      {entry.finished && (
        <Badge variant="outline" className="shrink-0">
          <Check className="size-2.5" />
          read
        </Badge>
      )}

      <Hint label="Forget this chapter's progress">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onForget}
          className={cn("opacity-0 transition-opacity group-hover:opacity-100")}
        >
          <RotateCcw className="size-3" />
        </Button>
      </Hint>

      <Button variant="outline" size="sm" onClick={onRead}>
        {entry.finished ? "Re-read" : "Continue"}
      </Button>
    </div>
  );
}

/**
 * A rough "how long ago".
 *
 * Exact timestamps are noise here: what matters is whether this was a moment
 * ago or last month.
 */
function relative(seconds: number): string {
  const elapsed = Date.now() / 1000 - seconds;
  if (elapsed < 60) return "just now";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  if (elapsed < 604800) return `${Math.floor(elapsed / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}
