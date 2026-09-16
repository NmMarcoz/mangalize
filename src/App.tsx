import { useCallback, useEffect, useRef, useState } from "react";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { exit } from "@tauri-apps/plugin-process";
import { AlertTriangle, ListChecks, Loader2, X } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { Sidebar, type Section } from "@/components/Sidebar";
import { TaskPanel, useTasks } from "@/components/TaskPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EditorView } from "@/views/EditorView";
import { LibraryView, emptyShelf, type ShelfState } from "@/views/LibraryView";
import { SeriesView } from "@/views/SeriesView";
import { ExploreView, emptyBrowse, type BrowseState } from "@/views/ExploreView";
import { HistoryView } from "@/views/HistoryView";
import { ReaderView } from "@/views/ReaderView";
import type { ReaderTarget } from "@/lib/reader";
import { SendView } from "@/views/SendView";
import { SettingsView } from "@/views/SettingsView";
import { WelcomeView } from "@/views/WelcomeView";
import { useUpdater } from "@/hooks/useUpdater";
import { scanFolder, type MetaSource, type Volume } from "@/lib/api";
import { getSettings, type Settings } from "@/lib/settings";
import { isMobile } from "@/lib/platform";
import { recordBuilt } from "@/lib/library";
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
  | { kind: "explore" }
  | { kind: "history" }
  // `back` is carried along so closing the reader returns where it was opened
  // from — the series page, history, or the middle of a browse.
  | { kind: "reader"; target: ReaderTarget; back: View }
  | { kind: "send" }
  | { kind: "settings" }
  | { kind: "editor"; from: { seriesId: number; number: string } | null };

/**
 * Where the back gesture goes from a given screen.
 *
 * Deliberately derived from the view rather than from a stack of visited ones:
 * every screen already carries where it came from, because the in-app back
 * buttons needed that first. Android's back button is the same question asked
 * by a different control, so it gets the same answer, and the two can never
 * disagree about it.
 *
 * `null` means this is as far back as it goes and the system should have the
 * press — on Android that closes the app, which is what a user at the library
 * pressing back means.
 */
function backFrom(view: View): View | null {
  switch (view.kind) {
    case "reader":
      return view.back;
    case "series":
      return { kind: "library" };
    case "editor":
      return view.from ? { kind: "series", id: view.from.seriesId } : { kind: "library" };
    case "library":
      return null;
    default:
      // A tab other than the first one. Back goes home rather than retracing
      // which tabs were visited in what order.
      return { kind: "library" };
  }
}

export default function App() {
  const [view, setView] = useState<View>({ kind: "library" });
  const [volume, setVolume] = useState<Volume | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  // Browsing survives leaving for a series and coming back; see `ExploreView`.
  const [browse, setBrowse] = useState<BrowseState>(emptyBrowse);
  const [shelf, setShelf] = useState<ShelfState>(emptyShelf);
  const [showTasks, setShowTasks] = useState(false);
  const { tasks, active } = useTasks();

  const updater = useUpdater();

  // Settings gate the first screen, so nothing renders until they are known.
  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  // Android's back button, which otherwise closes the app from any screen —
  // the same dead end the reader used to be, with no way out but relaunching.
  // Registering a listener at all is what stops Tauri handling it itself.
  const latest = useRef(view);
  latest.current = view;

  useEffect(() => {
    if (!isMobile) return;
    let listener: { unregister: () => void } | undefined;
    let disposed = false;

    onBackButtonPress(() => {
      // A dialog is the topmost thing on screen, so it is what back means while
      // one is open. Asked of the DOM rather than tracked in state because
      // every dialog in the app is a Radix one and they all already close on
      // Escape — the alternative is threading an "is anything open" flag up
      // from a dozen components that have no other reason to report it.
      if (document.querySelector('[role="dialog"][data-state="open"]')) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return;
      }
      const previous = backFrom(latest.current);
      if (previous) setView(previous);
      else void exit(0);
    })
      .then((handle) => {
        if (disposed) handle.unregister();
        else listener = handle;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      listener?.unregister();
    };
  }, []);

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
  // There is nothing to drop from on a phone, and asking for the listener there
  // only produces an error on startup.
  useEffect(() => {
    if (isMobile) return;
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
    if (!settings) return null;

    // Asked once, before anything needs somewhere to go.
    if (!settings.welcomed) {
      return <WelcomeView onDone={setSettings} onError={setError} />;
    }

    // The reader takes the whole window: a rail beside a page is a rail in
    // the way. It is the one screen that hides the app's chrome.
    if (view.kind === "reader") {
      const back = view.back;
      return (
        <ReaderView
          target={view.target}
          onNavigate={(target) => setView({ kind: "reader", target, back })}
          onOpenSeries={(id) => setView({ kind: "series", id })}
          onExit={() => setView(back)}
        />
      );
    }

    if (view.kind === "history") {
      return (
        <HistoryView
          onRead={(entry) =>
            setView({
              kind: "reader",
              // How it was read decides where it reopens from. A streamed
              // chapter has no pages on disk to go back to.
              target:
                entry.downloaded || !entry.chapter_source_id || !entry.series_source_id
                  ? { kind: "library", seriesId: entry.series_id, chapter: entry.chapter }
                  : {
                      kind: "online",
                      source: (entry.source ?? "mangadex") as MetaSource,
                      chapterId: entry.chapter_source_id,
                      seriesTitle: entry.series_title,
                      chapterNumber: entry.chapter,
                      direction: "right-to-left",
                      // Back to the translation it was read in, not a default.
                      language: entry.language,
                      // Left for the reader to fetch: it needs the list anyway,
                      // and this is the one entry point that has never had it.
                      chapters: [],
                      seriesSourceId: entry.series_source_id,
                      coverUrl: null,
                      librarySeriesId: entry.series_id,
                    },
              back: { kind: "history" },
            })
          }
          onOpenSeries={(id) => setView({ kind: "series", id })}
          onError={setError}
        />
      );
    }

    if (view.kind === "explore") {
      return (
        <ExploreView
          browse={browse}
          onBrowseChange={setBrowse}
          onOpenSeries={(id) => setView({ kind: "series", id })}
          onRead={(target) =>
            setView({ kind: "reader", target, back: { kind: "explore" } })
          }
          onError={setError}
        />
      );
    }

    if (view.kind === "send") {
      return <SendView onSaved={() => {}} onError={setError} />;
    }

    if (view.kind === "settings") {
      return (
        <SettingsView
          onSaved={setSettings}
          onError={setError}
          updateStage={updater.state.stage}
          onCheckUpdates={updater.checkNow}
        />
      );
    }

    if (view.kind === "library") {
      return (
        <LibraryView
          shelf={shelf}
          onShelfChange={setShelf}
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
          onRead={(target) =>
            setView({ kind: "reader", target, back: { kind: "series", id: view.id } })
          }
          onBack={() => setView({ kind: "library" })}
          onEditVolume={(built, source) => {
            clearThumbnails();
            setVolume(built);
            setView({ kind: "editor", from: source });
          }}
          defaultFormat={settings.default_format}
          onError={setError}
          onTasksChanged={() => setShowTasks(true)}
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
        // A volume from the library is remembered once written, so its page can
        // offer to share the file rather than build an identical one again.
        onBuilt={
          from
            ? (built) =>
                void recordBuilt(
                  from.seriesId,
                  from.number,
                  built.path,
                  built.bytes,
                ).catch(() => {})
            : undefined
        }
        defaultFormat={settings.default_format}
        onError={setError}
      />
    );
  };

  // A series and the editor both sit under the library as far as navigation is
  // concerned, so neither gets its own rail entry.
  const section: Section =
    view.kind === "settings" ||
    view.kind === "send" ||
    view.kind === "explore" ||
    view.kind === "history"
      ? view.kind
      : "library";
  const chrome = settings !== null && settings.welcomed && view.kind !== "reader";

  return (
    <TooltipProvider delayDuration={400}>
      {/* The rail sits beside the content; the phone's bar sits under it, which
          is the same two children in the other direction with the nav last. */}
      <div className={isMobile ? "flex h-full flex-col" : "flex h-full"}>
        {chrome && (
          <Sidebar
            active={section}
            onNavigate={(to) => setView({ kind: to } as View)}
            updateStage={updater.state.stage}
            onCheckUpdates={updater.checkNow}
            variant={isMobile ? "bar" : "rail"}
          />
        )}

        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            // `min-h-0` because a flex item will not shrink below its content
            // by default: a screen taller than the window pushed the bar off
            // the bottom of it instead of scrolling inside.
            isMobile && "order-first min-h-0",
          )}
        >
          {body()}
        </div>

        {/* Reachable from every screen, because the queue outlives all of them.
            Hidden in the reader, which is the one place that gives up its
            chrome on purpose. */}
        {chrome && (tasks.length > 0 || active > 0) && (
          <button
            onClick={() => setShowTasks((open) => !open)}
            title="Tasks"
            className={cn(
              "absolute right-3 top-3 z-40 flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-2.5 py-1 text-[11px] shadow-lg backdrop-blur",
              active > 0 ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {active > 0 ? (
              <Loader2 className="size-3 animate-spin text-primary" />
            ) : (
              <ListChecks className="size-3" />
            )}
            {active > 0 ? `${active} running` : "Tasks"}
          </button>
        )}

        {chrome && showTasks && (
          <TaskPanel tasks={tasks} onClose={() => setShowTasks(false)} />
        )}

        <UpdateBanner
          state={updater.state}
          dismissed={updater.dismissed}
          onInstall={updater.install}
          onRestart={updater.restart}
          onDismiss={updater.dismiss}
        />

        {dragging && (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="rounded-xl border-2 border-dashed border-primary px-10 py-8 text-center">
              <p className="text-sm font-medium">Drop to open this folder</p>
            </div>
          </div>
        )}

        {error && (
          <div
            className={cn(
              "absolute left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg",
              // Clear of the tab bar, for the same reason the update banner is.
              isMobile ? "bottom-20" : "bottom-4",
            )}
          >
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
