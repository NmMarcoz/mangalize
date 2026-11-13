import { useState } from "react";
import { Search, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { searchCoverImages, saveCover, type CoverImageResult } from "@/lib/api";
import { cn } from "@/lib/utils";

interface CoverSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled query based on the volume's metadata. */
  initialQuery: string;
  /** Called when the user picks an image. The path is a local cached file. */
  onPick: (localPath: string) => void;
}

/**
 * Search for cover images inside the app.
 *
 * The query is pre-filled from the volume's metadata so the user only has to
 * confirm or tweak it. Results are displayed in a grid; picking one downloads
 * it to the app cache and hands the local path back to the caller, which sets
 * it as the volume's cover.
 */
export function CoverSearchDialog({
  open,
  onOpenChange,
  initialQuery,
  onPick,
}: CoverSearchDialogProps) {
  const t = useT();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<CoverImageResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  // Reset state when the dialog is reopened for a different volume.
  useState(() => {
    setQuery(initialQuery);
    setResults([]);
    setPicked(null);
  });

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setResults([]);
    try {
      const found = await searchCoverImages(query);
      setResults(found);
    } catch (e) {
      console.error("Cover search failed:", e);
    } finally {
      setSearching(false);
    }
  };

  const handlePick = async (result: CoverImageResult) => {
    setPicked(result.url);
    try {
      // Download the image to the app cache and get a local path.
      const localPath = await saveCover(result.url);
      onPick(localPath);
      onOpenChange(false);
    } catch (e) {
      console.error("Failed to download cover:", e);
      setPicked(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <div className="border-b border-border px-4 py-3 shrink-0">
          <DialogTitle>{t("coverSearch.title")}</DialogTitle>
          <DialogDescription>{t("coverSearch.description")}</DialogDescription>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 shrink-0">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("coverSearch.placeholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSearch();
              }}
              disabled={searching}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={handleSearch}
              disabled={!query.trim() || searching}
            >
              {searching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
            </Button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-3">
          {searching ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <Search className="size-8 opacity-40" />
              <p className="mt-2 text-xs">{t("coverSearch.noResults")}</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {results.map((result) => (
                <button
                  key={result.url}
                  onClick={() => handlePick(result)}
                  disabled={picked !== null}
                  className={cn(
                    "group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted/40 transition-all hover:border-primary hover:ring-2 hover:ring-primary/40",
                    picked === result.url && "ring-2 ring-primary",
                  )}
                >
                  <img
                    src={result.thumbnail_url}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  {picked === result.url && (
                    <div className="absolute inset-0 flex items-center justify-center bg-primary/20">
                      <Loader2 className="size-5 animate-spin text-primary" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
