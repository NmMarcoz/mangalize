import { useCallback, useEffect, useState } from "react";
import { BookOpen, Clock, Loader2, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Hint } from "@/components/ui/tooltip";
import { useThumbnail } from "@/hooks/useThumbnail";
import { useT } from "@/lib/i18n";
import type { Translator } from "@/lib/i18n/types";
import { isMobile } from "@/lib/platform";
import {
  clearHistory,
  clearReadingProgress,
  readingHistory,
  type HistoryEntry,
} from "@/lib/reader";
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
  const t = useT();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(() => {
    readingHistory(LIMIT)
      .then(setEntries)
      .catch((e) => {
        onError(String(e));
        setEntries([]);
      });
  }, [onError]);

  useEffect(refresh, [refresh]);

  const clearAll = useCallback(async () => {
    onError(null);
    try {
      await clearHistory();
      setClearing(false);
      refresh();
    } catch (e) {
      onError(String(e));
    }
  }, [onError, refresh]);

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
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/60 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">{t("historyView.title")}</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            {t("historyView.subtitle")}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh}>
          {t("historyView.refresh")}
        </Button>
        {entries !== null && entries.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setClearing(true)}>
            <Trash2 />
            {t("historyView.clear")}
          </Button>
        )}
      </header>

      <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
        {entries === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {t("historyView.loading")}
          </div>
        ) : entries.length === 0 ? (
          <div className="mx-auto mt-20 max-w-md text-center">
            <Clock className="mx-auto size-8 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-medium">{t("historyView.emptyTitle")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("historyView.emptyHint")}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
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

      {/* Nothing here can be undone and nothing here is a file, so the warning
          is about what is lost rather than about danger: the reading positions. */}
      <Dialog open={clearing} onOpenChange={setClearing}>
        <DialogContent className="max-w-md">
          <div className="border-b border-border px-4 py-3">
            <DialogTitle>{t("historyView.clearDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("historyView.clearDialogDescription")}
            </DialogDescription>
          </div>
          <div className="flex items-center justify-end gap-2 px-4 py-3">
            <Button variant="ghost" onClick={() => setClearing(false)}>
              {t("historyView.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void clearAll()}>
              <Trash2 />
              {t("historyView.clearHistoryButton")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
  const t = useT();
  const { ref, url } = useThumbnail(entry.cover_path ?? "", 120);
  const progress =
    entry.page_count > 0 ? ((entry.last_page + 1) / entry.page_count) * 100 : 0;

  return (
    <div
      ref={ref}
      className="group flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3"
    >
      <div className="flex h-[62px] w-[44px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <BookOpen className="size-4 text-muted-foreground" />
        )}
      </div>

      <button onClick={onOpenSeries} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
        <p className="truncate text-xs font-medium">{entry.series_title}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {t("historyView.entrySubtitle", {
            chapter: entry.chapter,
            status: entry.finished
              ? t("historyView.finished")
              : t("historyView.pageProgress", {
                  page: entry.last_page + 1,
                  total: entry.page_count,
                }),
            time: relative(entry.opened_at, t),
          })}
        </p>
        {!entry.finished && (
          <div className="mt-0.5 h-0.5 w-full max-w-48 rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        )}
      </button>

      <Hint label={t("historyView.forgetHint")}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onForget}
          className={cn(
            "transition-opacity",
            // Revealed on hover is the same as absent on a touch screen, which
            // is what made clearing the whole history look like the only option.
            !isMobile && "opacity-0 group-hover:opacity-100",
          )}
        >
          <RotateCcw className="size-3" />
        </Button>
      </Hint>

      <Button variant="outline" size="sm" onClick={onRead}>
        {entry.finished ? t("historyView.reRead") : t("historyView.continue")}
      </Button>
    </div>
  );
}

/**
 * A rough "how long ago".
 *
 * A plain function outside the component, so it takes `t` as a parameter
 * rather than calling the hook — see `Translator` in `lib/i18n/types.ts`.
 * Exact timestamps are noise here: what matters is whether this was a moment
 * ago or last month.
 */
function relative(seconds: number, t: Translator): string {
  const elapsed = Date.now() / 1000 - seconds;
  if (elapsed < 60) return t("historyView.justNow");
  if (elapsed < 3600) return t("historyView.minutesAgo", { minutes: Math.floor(elapsed / 60) });
  if (elapsed < 86400) return t("historyView.hoursAgo", { hours: Math.floor(elapsed / 3600) });
  if (elapsed < 604800) return t("historyView.daysAgo", { days: Math.floor(elapsed / 86400) });
  return new Date(seconds * 1000).toLocaleDateString();
}
