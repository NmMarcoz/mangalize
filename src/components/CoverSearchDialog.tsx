import { useState } from "react";
import { Loader2, Link } from "lucide-react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
        <DialogHeader>
          <DialogTitle>{t("coverSearch.title")}</DialogTitle>
          <DialogDescription>{t("coverSearch.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <ol className="flex flex-col gap-2.5">
            {(["coverSearch.step1", "coverSearch.step2", "coverSearch.step3"] as const).map(
              (key, i) => (
                <li key={key} className="flex items-start gap-2.5">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="pt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {t(key)}
                  </span>
                </li>
              ),
            )}
          </ol>

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
        </DialogBody>

        <DialogFooter error={error}>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("coverSearch.cancel")}
          </Button>
          <Button onClick={handleImport} disabled={!imageUrl.trim() || downloading}>
            {downloading ? <Loader2 className="animate-spin" /> : <Link />}
            {t("coverSearch.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
