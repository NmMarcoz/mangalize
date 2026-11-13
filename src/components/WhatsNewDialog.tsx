import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChangelogEntry } from "@/lib/changelog";

interface WhatsNewDialogProps {
  open: boolean;
  /** Newest first — same order as `CHANGELOG`. */
  entries: ChangelogEntry[];
  onClose: () => void;
}

/**
 * What changed since this install last looked, shown once per version.
 *
 * `entries` is usually one release, but can be several: someone who skips a
 * few updates sees everything they missed in one panel rather than only the
 * latest, so nothing reads as having appeared out of nowhere.
 */
export function WhatsNewDialog({ open, entries, onClose }: WhatsNewDialogProps) {
  if (entries.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[80dvh] max-w-md">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <DialogTitle>What's new</DialogTitle>
          </div>
          <DialogDescription>
            {entries.length === 1
              ? `Since you last opened Leaf — v${entries[0].version}.`
              : "Since you last opened Leaf."}
          </DialogDescription>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {entries.map((entry) => (
            <div key={entry.version} className="mb-4 last:mb-0">
              {entries.length > 1 && (
                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                  v{entry.version}
                </p>
              )}
              <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
                {entry.highlights.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex justify-end border-t border-border p-3">
          <Button onClick={onClose}>Got it</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
