import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";

import { RemoteImage } from "@/components/RemoteImage";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useT } from "@/lib/i18n";
import { listSources, searchSource, type SourceInfo, type SourceManga } from "@/lib/api";
import { addSeriesFromSource, type Series } from "@/lib/library";
import { cn } from "@/lib/utils";

interface AddFromSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (series: Series) => void;
}

/**
 * Add a series found through a registered `Source` — built in beyond
 * MangaDex/Kitsu, or a `.lua` extension under `<library>/extensions/` —
 * rather than the MangaDex/Kitsu metadata search `AddSeriesDialog` runs.
 *
 * Deliberately simpler than that dialog: a `Source` only ever answers a
 * `title`/`cover_url` pair up front, not the title-language triad or the
 * cover gallery MangaDex offers, so there is nothing to choose between before
 * adding — the backend fetches full details itself once a result is picked.
 */
export function AddFromSourceDialog({ open, onOpenChange, onAdded }: AddFromSourceDialogProps) {
  const t = useT();
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SourceManga[] | null>(null);
  const [selected, setSelected] = useState<SourceManga | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults(null);
    setSelected(null);
    setError(null);
    listSources()
      .then((found) => {
        setSources(found);
        setSourceId((current) => current ?? found[0]?.id ?? null);
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  const runSearch = useCallback(async () => {
    if (!sourceId || !query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const page = await searchSource(sourceId, query, 1);
      setResults(page.manga);
      setSelected(page.manga[0] ?? null);
      if (page.manga.length === 0) setError(t("addFromSourceDialog.noMatches"));
    } catch (e) {
      setError(String(e));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [sourceId, query, t]);

  const add = useCallback(async () => {
    if (!sourceId || !selected) return;
    setAdding(true);
    setError(null);
    try {
      const added = await addSeriesFromSource(sourceId, selected.id, selected.title);
      onAdded(added);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }, [sourceId, selected, onAdded, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-lg">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>{t("addFromSourceDialog.title")}</DialogTitle>
          <DialogDescription>{t("addFromSourceDialog.description")}</DialogDescription>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          {sources !== null && sources.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {(() => {
                const [before, rest] = t("addFromSourceDialog.noSources").split("{ext}");
                const [middle, after] = rest.split("{folder}");
                return (
                  <>
                    {before}
                    <code>.lua</code>
                    {middle}
                    <code>extensions</code>
                    {after}
                  </>
                );
              })()}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source">{t("addFromSourceDialog.sourceLabel")}</Label>
                <Select value={sourceId ?? undefined} onValueChange={setSourceId}>
                  <SelectTrigger id="source">
                    <SelectValue placeholder={t("addFromSourceDialog.sourcePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {sources?.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <Input
                  autoFocus
                  value={query}
                  placeholder={t("addFromSourceDialog.seriesNamePlaceholder")}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runSearch();
                  }}
                />
                <Button size="icon" onClick={() => void runSearch()} disabled={searching}>
                  {searching ? <Loader2 className="animate-spin" /> : <Search />}
                </Button>
              </div>

              <div className="scrollbar-thin max-h-72 min-h-0 overflow-y-auto rounded-md border border-border">
                {results === null && !searching && (
                  <p className="p-4 text-xs text-muted-foreground">
                    {t("addFromSourceDialog.pressEnter")}
                  </p>
                )}
                {results?.map((manga) => (
                  <button
                    key={manga.id}
                    onClick={() => setSelected(manga)}
                    className={cn(
                      "flex w-full gap-2.5 border-b border-border/50 p-2.5 text-left transition-colors last:border-b-0",
                      selected?.id === manga.id ? "bg-primary/10" : "hover:bg-accent",
                    )}
                  >
                    {manga.cover_url ? (
                      <RemoteImage
                        url={manga.cover_url}
                        max={96}
                        className="h-16 w-12 shrink-0 rounded"
                      />
                    ) : (
                      <div className="h-16 w-12 shrink-0 rounded bg-muted" />
                    )}
                    <p className="min-w-0 flex-1 truncate self-center text-xs font-medium">
                      {manga.title}
                    </p>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <Separator />

        <div className="flex items-center gap-3 px-4 py-3">
          {error && (
            <p className="flex-1 truncate text-xs text-destructive" title={error}>
              {error}
            </p>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("addFromSourceDialog.cancel")}
            </Button>
            <Button onClick={() => void add()} disabled={!selected || adding}>
              {adding ? <Loader2 className="animate-spin" /> : <Plus />}
              {t("addFromSourceDialog.addToLibrary")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
