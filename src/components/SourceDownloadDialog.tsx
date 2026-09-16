import { useCallback, useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { downloadFromSource } from "@/lib/library";

interface SourceDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: number;
  /** Where the chapters are coming from, for the copy. */
  sourceName: string;
  /** The chapter numbers to fetch, in order. */
  chapters: string[];
  /** Told once the run is on the queue, so the caller can point at it. */
  onStarted: () => void;
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
  onStarted,
}: SourceDownloadDialogProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStarting(false);
    setError(null);
  }, [open]);

  // Handed to the queue rather than run here. A run of forty chapters is
  // minutes of work, and this dialog used to be where you spent them.
  const run = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      await downloadFromSource(seriesId, chapters);
      onStarted();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
      setStarting(false);
    }
  }, [seriesId, chapters, onStarted, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>Get {chapters.length} from {sourceName}</DialogTitle>
          <DialogDescription>
            Only the chapters already listed as missing. Nothing else is looked
            for, and one that fails does not stop the rest.
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {chapters.length === 1
              ? `Chapter ${chapters[0]}.`
              : `Chapters ${chapters[0]} to ${chapters[chapters.length - 1]}.`}{" "}
            This runs in the background — you can close this and carry on reading.
          </p>

          {error && (
            <p className="mt-2 text-xs text-destructive" data-selectable>
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={starting || chapters.length === 0}>
            {starting ? <Loader2 className="animate-spin" /> : <Download />}
            Download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
