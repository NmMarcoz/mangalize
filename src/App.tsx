import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, X } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorView } from "@/views/EditorView";
import { LibraryView } from "@/views/LibraryView";
import { SeriesView } from "@/views/SeriesView";
import { scanFolder, type Volume } from "@/lib/api";
import { clearThumbnails } from "@/lib/thumbs";

/**
 * Which of the three screens is showing.
 *
 * The library is home. The editor is reached either from a volume the library
 * assembled or from a folder dropped on the window, and does not know which.
 */
type View =
  | { kind: "library" }
  | { kind: "series"; id: number }
  | { kind: "editor"; from: { seriesId: number } | null };

export default function App() {
  const [view, setView] = useState<View>({ kind: "library" });
  const [volume, setVolume] = useState<Volume | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ---------------------------------------------------------------- scanning */

  const runScan = useCallback(async (path: string) => {
    setScanning(true);
    setError(null);
    try {
      const next = await scanFolder(path);
      // Thumbnails are keyed by path; a different folder invalidates all of them.
      clearThumbnails();
      if (next.chapters.length === 0) {
        setError("No images found in that folder.");
        return;
      }
      setVolume(next);
      setView({ kind: "editor", from: null });
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  const pickFolder = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") await runScan(picked);
  }, [runScan]);

  // Dropping a folder anywhere jumps straight to the editor, from any screen.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          const first = event.payload.paths[0];
          if (first) void runScan(first);
        } else {
          setDragging(false);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runScan]);

  /* ------------------------------------------------------------------ render */

  const body = () => {
    if (view.kind === "library") {
      return (
        <LibraryView
          onOpenSeries={(id) => setView({ kind: "series", id })}
          onOpenFolder={() => void pickFolder()}
          onError={setError}
        />
      );
    }

    if (view.kind === "series") {
      return (
        <SeriesView
          seriesId={view.id}
          onBack={() => setView({ kind: "library" })}
          onEditVolume={(built, source) => {
            clearThumbnails();
            setVolume(built);
            setView({ kind: "editor", from: { seriesId: source.seriesId } });
          }}
          onError={setError}
        />
      );
    }

    if (!volume) {
      return (
        <EmptyState
          dragging={dragging}
          scanning={scanning}
          error={error}
          onOpenFolder={() => void pickFolder()}
        />
      );
    }

    const from = view.from;
    return (
      <EditorView
        volume={volume}
        setVolume={setVolume}
        scanning={scanning}
        onRescan={() => void runScan(volume.root)}
        onOpenFolder={() => void pickFolder()}
        onBack={() =>
          setView(from ? { kind: "series", id: from.seriesId } : { kind: "library" })
        }
        onError={setError}
      />
    );
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        {body()}

        {dragging && (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="rounded-xl border-2 border-dashed border-primary px-10 py-8 text-center">
              <p className="text-sm font-medium">Drop to open this folder</p>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute bottom-4 left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1" data-selectable>
              {error}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-my-0.5 shrink-0"
              onClick={() => setError(null)}
            >
              <X className="size-3" />
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
