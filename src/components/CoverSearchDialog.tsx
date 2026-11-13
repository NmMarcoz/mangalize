import { useState } from "react";
import { Loader2, Link } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { saveCover } from "@/lib/api";

interface CoverSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user picks an image. The path is a local cached file. */
  onPick: (localPath: string) => void;
}

/**
 * Import a cover by pasting its URL.
 *
 * The user finds an image in their browser (Google Images, etc.), right-clicks
 * to copy the image address, and pastes it here. The app downloads it to the
 * cache and sets it as the volume's cover — no file picker, no save-to-disk step.
 */
export function CoverSearchDialog({
  open,
  onOpenChange,
  onPick,
}: CoverSearchDialogProps) {
  const t = useT();
  const [imageUrl, setImageUrl] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the dialog is reopened.
  useState(() => {
    setImageUrl("");
    setError(null);
  });

  const handleImport = async () => {
    if (!imageUrl.trim()) return;
    setDownloading(true);
    setError(null);
    try {
      const localPath = await saveCover(imageUrl.trim());
      onPick(localPath);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
      setDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>{t("coverSearch.title")}</DialogTitle>
          <DialogDescription>{t("coverSearch.description")}</DialogDescription>
        </div>

        {/* Instructions */}
        <div className="px-4 pt-3 text-xs text-muted-foreground">
          <ol className="list-decimal space-y-1 pl-4">
            <li>{t("coverSearch.step1")}</li>
            <li>{t("coverSearch.step2")}</li>
            <li>{t("coverSearch.step3")}</li>
          </ol>
        </div>

        {/* URL input */}
        <div className="flex gap-2 px-4 pt-2">
          <Input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder={t("coverSearch.pasteUrl")}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleImport();
            }}
            disabled={downloading}
            autoFocus
          />
          <Button
            variant="secondary"
            size="icon"
            onClick={handleImport}
            disabled={!imageUrl.trim() || downloading}
          >
            {downloading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Link className="size-4" />
            )}
          </Button>
        </div>

        {error && (
          <p className="px-4 text-xs text-destructive">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("coverSearch.cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
