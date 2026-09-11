import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { libraryRemoveSeries, type Series } from "@/lib/library";

interface RemoveSeriesDialogProps {
  /** The series to remove, or `null` when the dialog is closed. */
  series: Series | null;
  onOpenChange: (open: boolean) => void;
  onRemoved: (series: Series) => void;
}

/**
 * Confirm removing a series, and decide what happens to its files.
 *
 * The two outcomes are genuinely different and the second is irreversible, so
 * they are one explicit switch rather than two similar-looking buttons. It
 * defaults to keeping the files: the library is a list of things the user spent
 * effort collecting, and forgetting one should not be the same as losing it.
 */
export function RemoveSeriesDialog({
  series,
  onOpenChange,
  onRemoved,
}: RemoveSeriesDialogProps) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Never carry a previous confirmation's "yes, delete" into the next one.
  useEffect(() => {
    if (!series) return;
    setDeleteFiles(false);
    setBusy(false);
    setError(null);
  }, [series]);

  const remove = useCallback(async () => {
    if (!series) return;
    setBusy(true);
    setError(null);
    try {
      await libraryRemoveSeries(series.id, deleteFiles);
      onRemoved(series);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [series, deleteFiles, onRemoved, onOpenChange]);

  const downloaded = series?.have_chapters ?? 0;

  return (
    <Dialog
      open={series !== null}
      onOpenChange={(next) => !busy && onOpenChange(next)}
    >
      <DialogContent className="max-w-lg">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>Remove {series?.title}?</DialogTitle>
          <DialogDescription>
            {downloaded > 0
              ? `${downloaded} downloaded ${downloaded === 1 ? "chapter" : "chapters"} on disk.`
              : "Nothing has been downloaded for this series yet."}
          </DialogDescription>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          {downloaded > 0 && (
            <label className="flex cursor-pointer items-start gap-3">
              <Switch
                checked={deleteFiles}
                onCheckedChange={setDeleteFiles}
                disabled={busy}
                className="mt-0.5"
              />
              <span className="text-xs">
                <span className="font-medium">Delete the downloaded files too</span>
                <span className="mt-0.5 block text-muted-foreground">
                  Permanently removes the chapter images from disk. Anything you
                  have already exported is untouched.
                </span>
              </span>
            </label>
          )}

          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {deleteFiles ? (
              <>
                The series and its files will be deleted from{" "}
                <span className="font-mono text-foreground" data-selectable>
                  {series?.folder}
                </span>
                . This cannot be undone.
              </>
            ) : (
              <>
                Only the library entry goes. The files stay in{" "}
                <span className="font-mono text-foreground" data-selectable>
                  {series?.folder}
                </span>
                .
              </>
            )}
          </p>
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
              Cancel
            </Button>
            <Button
              variant={deleteFiles ? "destructive" : "default"}
              onClick={() => void remove()}
              disabled={busy}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {deleteFiles ? "Delete series and files" : "Remove from library"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
