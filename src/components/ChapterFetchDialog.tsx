import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Check,
  Download,
  Globe,
  Loader2,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { usePreview } from "@/hooks/useThumbnail";
import { formatBytes } from "@/lib/api";
import {
  downloadChapter,
  extractChapter,
  harvestImages,
  measureImages,
  type Candidate,
  type ChapterStatus,
  type FetchProgress,
} from "@/lib/library";
import { canRenderPages } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface ChapterFetchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: number;
  /** Chapter number being filled, e.g. `"7"`. */
  chapter: string;
  onDownloaded: (chapter: ChapterStatus) => void;
}

type Stage = "idle" | "looking" | "picking" | "downloading";

/**
 * Paste a chapter URL, choose which images are pages, download them.
 *
 * Two ways in. Reading the page's markup is tried first because it is instant
 * and needs no window. When that finds nothing — which is what a page built in
 * JavaScript looks like from the outside — the page can be opened in a real
 * window and the images it actually loads captured instead.
 */
export function ChapterFetchDialog({
  open,
  onOpenChange,
  seriesId,
  chapter,
  onDownloaded,
}: ChapterFetchDialogProps) {
  const [url, setUrl] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [referer, setReferer] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<FetchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emptyResult, setEmptyResult] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setStage("idle");
    setCandidates([]);
    setReferer(null);
    setChosen(new Set());
    setProgress(null);
    setError(null);
    setEmptyResult(false);
  }, [open]);

  useEffect(() => {
    const pending = listen<FetchProgress>("fetch-progress", (e) => {
      setProgress(e.payload);
    });
    return () => {
      void pending.then((fn) => fn());
    };
  }, []);

  /** Take a fresh set of candidates and preselect what the sieve liked. */
  const present = useCallback((found: Candidate[], from: string | null) => {
    setCandidates(found);
    setReferer(from);
    setChosen(new Set(found.filter((c) => c.selected).map((c) => c.url)));
    setEmptyResult(found.length === 0);
    setStage(found.length === 0 ? "idle" : "picking");
  }, []);

  const readMarkup = useCallback(async () => {
    if (!url.trim()) return;
    setStage("looking");
    setError(null);
    setEmptyResult(false);
    try {
      const found = await extractChapter(url.trim());
      present(found.candidates, found.page_url);
    } catch (e) {
      setError(String(e));
      setStage("idle");
    } finally {
      setProgress(null);
    }
  }, [url, present]);

  const openInWindow = useCallback(async () => {
    if (!url.trim()) return;
    setStage("looking");
    setError(null);
    setEmptyResult(false);
    try {
      const harvested = await harvestImages(url.trim());
      if (harvested.length === 0) {
        // Closing the window without capturing is an ordinary way to back out.
        setStage("idle");
        return;
      }
      const measured = await measureImages(
        harvested.map((h) => h.url),
        url.trim(),
      );
      present(measured, url.trim());
    } catch (e) {
      setError(String(e));
      setStage("idle");
    } finally {
      setProgress(null);
    }
  }, [url, present]);

  // Page order is the order they were found in, not the order they were ticked.
  const selectedUrls = useMemo(
    () => candidates.filter((c) => chosen.has(c.url)).map((c) => c.url),
    [candidates, chosen],
  );

  const download = useCallback(async () => {
    if (selectedUrls.length === 0) return;
    setStage("downloading");
    setError(null);
    try {
      const stored = await downloadChapter({
        id: seriesId,
        chapter,
        urls: selectedUrls,
        referer,
        sourceUrl: url.trim() || null,
      });
      onDownloaded(stored);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
      setStage("picking");
    } finally {
      setProgress(null);
    }
  }, [selectedUrls, seriesId, chapter, referer, url, onDownloaded, onOpenChange]);

  const toggle = useCallback((target: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }, []);

  const busy = stage === "looking" || stage === "downloading";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[88dvh] max-w-5xl">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>Get chapter {chapter}</DialogTitle>
          <DialogDescription>
            Paste the page holding the chapter's images. Nothing is downloaded
            until you choose it.
          </DialogDescription>
        </div>

        <div className="flex items-center gap-2 px-4 py-3">
          <Input
            autoFocus
            value={url}
            placeholder="https://…"
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void readMarkup();
            }}
          />
          <Button onClick={() => void readMarkup()} disabled={busy || !url.trim()}>
            {stage === "looking" ? <Loader2 className="animate-spin" /> : <Search />}
            Find images
          </Button>
          {canRenderPages && (
            <Button
              variant="outline"
              onClick={() => void openInWindow()}
              disabled={busy || !url.trim()}
              title="Render the page in a window and capture what it loads"
            >
              <Globe />
              Open page
            </Button>
          )}
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto border-t border-border p-4">
          {emptyResult && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <div>
                <p className="font-medium">No images in that page's markup.</p>
                <p className="mt-0.5 text-muted-foreground">
                  {canRenderPages ? (
                    <>
                      It most likely builds itself in JavaScript. Use{" "}
                      <span className="font-medium text-foreground">Open page</span>{" "}
                      to render it in a window, scroll until the pages have
                      loaded, and click Capture.
                    </>
                  ) : (
                    <>
                      It most likely builds itself in JavaScript, which needs a
                      second window to render — something this platform does not
                      have. Downloading it on the desktop app and syncing the
                      library is the way round.
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

          {stage === "idle" && !emptyResult && (
            <p className="text-xs text-muted-foreground">
              Images are measured before anything is saved, so pages, spreads and
              banners can be told apart and preselected for you.
            </p>
          )}

          {busy && progress && (
            <div className="flex items-center gap-3">
              <Progress
                value={(progress.done / Math.max(1, progress.total)) * 100}
                className="flex-1"
              />
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {progress.stage} {progress.done}/{progress.total}
              </span>
            </div>
          )}

          {candidates.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3">
              {candidates.map((candidate, index) => (
                <CandidateCard
                  key={candidate.url}
                  candidate={candidate}
                  referer={referer}
                  position={selectedUrls.indexOf(candidate.url) + 1}
                  chosen={chosen.has(candidate.url)}
                  onToggle={() => toggle(candidate.url)}
                  index={index}
                />
              ))}
            </div>
          )}
        </div>

        <Separator />

        <div className="flex items-center gap-3 px-4 py-3">
          {candidates.length > 0 && (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setChosen(new Set(candidates.map((c) => c.url)))}
              >
                All
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setChosen(new Set())}
              >
                None
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  setChosen(new Set(candidates.filter((c) => c.selected).map((c) => c.url)))
                }
              >
                Reset
              </Button>
            </div>
          )}

          {error && (
            <p className="min-w-0 flex-1 truncate text-xs text-destructive" title={error}>
              {error}
            </p>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {selectedUrls.length > 0 && `${selectedUrls.length} pages`}
            </span>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void download()}
              disabled={busy || selectedUrls.length === 0}
            >
              {stage === "downloading" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Download />
              )}
              Download
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One candidate image: its preview, what the sieve made of it, and a tick. */
function CandidateCard({
  candidate,
  referer,
  position,
  chosen,
  onToggle,
  index,
}: {
  candidate: Candidate;
  referer: string | null;
  /** Position in the chapter once downloaded, or 0 when not taken. */
  position: number;
  chosen: boolean;
  onToggle: () => void;
  index: number;
}) {
  const { ref, url, failed } = usePreview(candidate.url, referer, 240);

  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      onClick={onToggle}
      className={cn(
        "group relative overflow-hidden rounded-md border-2 bg-card text-left transition-colors",
        chosen ? "border-primary" : "border-border hover:border-muted-foreground/40",
      )}
    >
      <div className="flex aspect-[2/3] items-center justify-center bg-muted/40">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-contain" />
        ) : failed || candidate.error ? (
          <AlertTriangle className="size-5 text-muted-foreground" />
        ) : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="flex items-center gap-1 px-1.5 py-1">
        <span className="font-mono text-[10px] text-muted-foreground">
          {candidate.width}×{candidate.height}
        </span>
        {candidate.verdict === "spread" && <Badge className="text-[9px]">spread</Badge>}
        {candidate.verdict === "off-size" && (
          <Badge variant="outline" className="text-[9px]">
            off-size
          </Badge>
        )}
        {candidate.bytes > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {formatBytes(candidate.bytes)}
          </span>
        )}
      </div>

      {/* Found-order index, so an unticked image can still be placed in context. */}
      <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-medium text-white">
        {position > 0 ? position : `#${index + 1}`}
      </span>

      {chosen && (
        <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5">
          <Check className="size-2.5 text-primary-foreground" />
        </span>
      )}

      {candidate.error && (
        <span
          className="absolute inset-x-0 bottom-0 truncate bg-destructive/80 px-1 text-[9px] text-white"
          title={candidate.error}
        >
          {candidate.error}
        </span>
      )}
    </button>
  );
}
