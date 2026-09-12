import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  cancelBatch,
  downloadFromSource,
  type BatchProgress,
  type BatchReport,
} from "@/lib/library";

interface SourceDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: number;
  /** Where the chapters are coming from, for the copy. */
  sourceName: string;
  /** The chapter numbers to fetch, in order. */
  chapters: string[];
  onFinished: (report: BatchReport) => void;
}

/**
 * Fetch missing chapters from the source that indexed them.
 *
 * The sibling of `BatchDownloadDialog`, and deliberately much plainer: that one
 * has to work out how to reach each chapter from a URL and show the plan before
 * touching anything, because the guess can be wrong. Here the library already
 * holds an id for every chapter, so there is nothing to confirm — only work to
 * do and progress to report.
 */
export function SourceDownloadDialog({
  open,
  onOpenChange,
  seriesId,
  sourceName,
  chapters,
  onFinished,
}: SourceDownloadDialogProps) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRunning(false);
    setProgress(null);
    setReport(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    const pending = listen<BatchProgress>("batch-progress", (e) => setProgress(e.payload));
    return () => {
      void pending.then((fn) => fn());
    };
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const done = await downloadFromSource(seriesId, chapters);
      setReport(done);
      onFinished(done);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [seriesId, chapters, onFinished]);

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>Get {chapters.length} from {sourceName}</DialogTitle>
          <DialogDescription>
            Only the chapters already listed as missing. Nothing else is looked
            for, and one that fails does not stop the rest.
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 px-4 py-3">
          {report ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 text-xs">
                <Check className="size-3.5 text-primary" />
                {report.downloaded.length} downloaded
                {report.cancelled && " · stopped"}
              </p>
              {report.failed.length > 0 && (
                <div className="scrollbar-thin max-h-40 overflow-y-auto rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
                  {report.failed.map((f) => (
                    <p key={f.number} className="text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">{f.number}</span>{" "}
                      {f.error}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ) : running ? (
            <div className="flex flex-col gap-2">
              <Progress
                value={
                  progress ? (progress.index / Math.max(1, progress.total)) * 100 : 0
                }
              />
              <p className="font-mono text-[11px] text-muted-foreground">
                {progress
                  ? `${progress.stage} ${progress.chapter} · ${progress.index}/${progress.total}` +
                    (progress.page_total > 0
                      ? ` · ${progress.done}/${progress.page_total} pages`
                      : "")
                  : "starting…"}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {chapters.length === 1
                ? `Chapter ${chapters[0]}.`
                : `Chapters ${chapters[0]} to ${chapters[chapters.length - 1]}.`}
            </p>
          )}

          {error && (
            <p className="mt-2 text-xs text-destructive" data-selectable>
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {running ? (
            <Button variant="outline" onClick={() => void cancelBatch()}>
              Stop
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {report ? "Close" : "Cancel"}
            </Button>
          )}
          {!report && (
            <Button onClick={() => void run()} disabled={running || chapters.length === 0}>
              {running ? <Loader2 className="animate-spin" /> : <Download />}
              Download
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
