import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";

interface CoverSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled query based on the volume's metadata. */
  initialQuery: string;
}

/**
 * Opens a Google Images search for a volume cover.
 *
 * The query is pre-filled from the volume's metadata so the user only has to
 * confirm or tweak it. Opening the URL in the system browser avoids building
 * a browser inside the app, and lets the user save an image however they prefer.
 */
export function CoverSearchDialog({
  open,
  onOpenChange,
  initialQuery,
}: CoverSearchDialogProps) {
  const t = useT();
  const [query, setQuery] = useState(initialQuery);

  // Keep the query in step when the dialog is reopened for a different volume.
  useState(() => {
    setQuery(initialQuery);
  });

  const handleSearch = () => {
    const encoded = encodeURIComponent(query);
    void openUrl(`https://www.google.com/search?tbm=isch&q=${encoded}`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>{t("coverSearch.title")}</DialogTitle>
          <DialogDescription>{t("coverSearch.description")}</DialogDescription>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("coverSearch.placeholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSearch();
              }}
              autoFocus
            />
            <Button variant="outline" size="icon" onClick={handleSearch} disabled={!query.trim()}>
              <Search className="size-4" />
            </Button>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("coverSearch.hint")}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("coverSearch.cancel")}
          </Button>
          <Button onClick={handleSearch} disabled={!query.trim()}>
            <Search className="size-3.5" />
            {t("coverSearch.search")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
