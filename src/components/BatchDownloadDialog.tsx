import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { useT } from "@/lib/i18n";
import {
  downloadBatch,
  planBatch,
  summariseRuns,
  type BatchPlan,
  type BatchProgress,
  type BatchReport,
} from "@/lib/library";

interface BatchDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: number;
  /** The chapter numbers currently missing, in order. */
  missing: string[];
  /** Told once the run is on the queue. */
  onStarted: () => void;
}

type Stage = "idle" | "planning" | "ready" | "running" | "done";

/**
 * Find every missing chapter from one URL, then fetch them all.
 *
 * The plan is always shown before anything downloads. It is built only from the
 * chapters the library already knows are missing — there is no crawling outward
 * — and every constructed URL has been fetched once to confirm it loads, so the
 * count on screen is what will actually be attempted.
 */
export function BatchDownloadDialog({
  open,
  onOpenChange,
  seriesId,
  missing,
  onStarted,
}: BatchDownloadDialogProps) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setStage("idle");
    setPlan(null);
    setProgress(null);
    setReport(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    const pending = listen<BatchProgress>("batch-progress", (e) => {
      setProgress(e.payload);
    });
    return () => {
      void pending.then((fn) => fn());
    };
  }, []);

  const findChapters = useCallback(async () => {
    if (!url.trim()) return;
    setStage("planning");
    setError(null);
    try {
      const found = await planBatch(url.trim(), missing);
      setPlan(found);
      setStage("ready");
    } catch (e) {
      setError(String(e));
      setStage("idle");
    }
  }, [url, missing]);

  // The plan is still confirmed here — a constructed URL can be wrong, and that
  // is worth seeing before anything downloads. Only the downloading itself
  // moved to the queue.
  const run = useCallback(async () => {
    if (!plan || plan.items.length === 0) return;
    setStage("running");
    setError(null);
    try {
      await downloadBatch(seriesId, plan.items);
      onStarted();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
      setStage("ready");
    }
  }, [plan, seriesId, onStarted, onOpenChange]);

  const running = stage === "running";
  const busy = running || stage === "planning";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[85dvh] max-w-2xl">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>{t("batchDownloadDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("batchDownloadDialog.description", { count: missing.length })}
          </DialogDescription>
        </div>

        <div className="flex items-center gap-2 px-4 py-3">
          <Input
            autoFocus
            value={url}
            placeholder={t("batchDownloadDialog.urlPlaceholder")}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void findChapters();
            }}
          />
          <Button onClick={() => void findChapters()} disabled={busy || !url.trim()}>
            {stage === "planning" ? <Loader2 className="animate-spin" /> : <Search />}
            {t("batchDownloadDialog.findChapters")}
          </Button>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto border-t border-border px-4 py-3">
          {stage === "idle" && !error && (
            <p className="text-xs text-muted-foreground">
              {t("batchDownloadDialog.missing", {
                summary: summariseRuns(missing) || t("batchDownloadDialog.nothing"),
              })}
            </p>
          )}

          {stage === "planning" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("batchDownloadDialog.checkingChapters")}
            </div>
          )}

          {plan && stage !== "planning" && (
            <div className="flex flex-col gap-3">
              {plan.pattern && (
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {plan.pattern}
                </p>
              )}

              {plan.items.length === 0 ? (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                  <div>
                    <p className="font-medium">
                      {t("batchDownloadDialog.noneReachedTitle")}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {t("batchDownloadDialog.noneReachedDetail")}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>
                    <Check className="size-2.5" />
                    {t("batchDownloadDialog.chaptersFound", { count: plan.items.length })}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {t("batchDownloadDialog.foundBreakdown", {
                      linked: plan.items.filter((i) => i.found === "linked").length,
                      guessed: plan.items.filter((i) => i.found === "guessed").length,
                    })}
                  </span>
                </div>
              )}

              {plan.unresolved.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {t("batchDownloadDialog.unresolvedHint", {
                    summary: summariseRuns(plan.unresolved),
                  })}
                </p>
              )}

              {plan.items.length > 0 && (
                <div className="max-h-48 overflow-y-auto rounded-md border border-border">
                  {plan.items.map((item) => (
                    <div
                      key={item.number}
                      className="flex items-center gap-2 border-b border-border/50 px-2.5 py-1 text-[11px] last:border-b-0"
                    >
                      <span className="w-12 shrink-0 font-mono">{item.number}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {item.url}
                      </span>
                      {item.found === "guessed" && (
                        <Badge variant="outline" className="text-[9px]">
                          {t("batchDownloadDialog.patternBadge")}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {running && progress && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <Progress
                  value={(progress.index / Math.max(1, progress.total)) * 100}
                  className="flex-1"
                />
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {progress.index}/{progress.total}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("batchDownloadDialog.progressLine", {
                  chapter: progress.chapter,
                  stage:
                    progress.stage === "reading"
                      ? t("batchDownloadDialog.stageReading")
                      : t("batchDownloadDialog.stageDownloading"),
                })}
                {progress.page_total > 0 &&
                  ` ${t("batchDownloadDialog.pagesCount", {
                    done: progress.done,
                    total: progress.page_total,
                  })}`}
              </p>
            </div>
          )}

          {report && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-xs font-medium">
                {report.cancelled ? `${t("batchDownloadDialog.stopped")} ` : ""}
                {t("batchDownloadDialog.chaptersDownloaded", {
                  count: report.downloaded.length,
                })}
                {report.failed.length > 0 &&
                  t("batchDownloadDialog.chaptersFailed", { count: report.failed.length })}
                .
              </p>
              {report.failed.map((failure) => (
                <p
                  key={failure.number}
                  className="truncate text-[11px] text-destructive"
                  title={failure.error}
                >
                  {t("batchDownloadDialog.failureLine", {
                    number: failure.number,
                    error: failure.error,
                  })}
                </p>
              ))}
            </div>
          )}
        </div>

        <Separator />

        <div className="flex items-center gap-3 px-4 py-3">
          {error && (
            <p className="min-w-0 flex-1 truncate text-xs text-destructive" title={error}>
              {error}
            </p>
          )}

          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("batchDownloadDialog.cancel")}
            </Button>

            {stage !== "done" && (
              <Button
                onClick={() => void run()}
                disabled={busy || !plan || plan.items.length === 0}
              >
                {running ? <Loader2 className="animate-spin" /> : <Download />}
                {t("batchDownloadDialog.download", { count: plan?.items.length ?? 0 })}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
