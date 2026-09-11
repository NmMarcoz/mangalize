import { FolderOpen, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  dragging: boolean;
  scanning: boolean;
  error: string | null;
  onOpenFolder: () => void;
}

export function EmptyState({ dragging, scanning, error, onOpenFolder }: EmptyStateProps) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div
        className={cn(
          "flex w-full max-w-lg flex-col items-center gap-5 rounded-xl border-2 border-dashed p-12 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        {scanning ? (
          <>
            <Loader2 className="size-9 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Reading pages…</p>
          </>
        ) : (
          <>
            <div className="rounded-full bg-primary/10 p-4">
              <FolderOpen className="size-8 text-primary" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold">Drop a volume folder</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                One subfolder per chapter, images inside. Banners, favicons and
                other site junk are filtered out automatically.
              </p>
            </div>
            <Button onClick={onOpenFolder}>
              <FolderOpen /> Choose folder
            </Button>
            {error && (
              <p className="text-xs text-destructive" data-selectable>
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
