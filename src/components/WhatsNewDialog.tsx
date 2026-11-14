import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <DialogTitle>What's new</DialogTitle>
          </div>
          <DialogDescription>
            {entries.length === 1
              ? `Since you last opened Leaf — v${entries[0].version}.`
              : "Since you last opened Leaf."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="gap-6">
          {entries.map((entry) => (
            <div key={entry.version} className="flex flex-col gap-3">
              {entries.length > 1 && (
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  v{entry.version}
                </p>
              )}
              <ul className="flex flex-col gap-3">
                {entry.highlights.map((line) => (
                  <li key={line} className="flex items-start gap-3">
                    {/* Centred on the first line of text: 12px × 1.625 line height. */}
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary" />
                    <span className="text-xs leading-relaxed text-foreground">{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </DialogBody>

        <DialogFooter>
          <Button onClick={onClose}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
