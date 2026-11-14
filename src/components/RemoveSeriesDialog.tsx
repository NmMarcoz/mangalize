import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

  const folder = (
    <span className="font-mono text-foreground" data-selectable>
      {series?.folder}
    </span>
  );

  return (
    <Dialog
      open={series !== null}
      onOpenChange={(next) => !busy && onOpenChange(next)}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {series?.title}?</DialogTitle>
          <DialogDescription>
            {downloaded > 0
              ? `${downloaded} downloaded ${downloaded === 1 ? "chapter" : "chapters"} on disk.`
              : "Nothing has been downloaded for this series yet."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
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
                <span className="mt-0.5 block leading-relaxed text-muted-foreground">
                  Permanently removes the chapter images from disk. Anything you
                  have already exported is untouched.
                </span>
              </span>
            </label>
          )}

          {deleteFiles ? (
            <Callout tone="destructive">
              The series and its files will be deleted from {folder}. This cannot
              be undone.
            </Callout>
          ) : (
            <Callout tone="info">
              Only the library entry goes. The files stay in {folder}.
            </Callout>
          )}
        </DialogBody>

        <DialogFooter error={error}>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
