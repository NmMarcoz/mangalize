import { Download, Loader2, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isAndroid, isMobile } from "@/lib/platform";
import { Progress } from "@/components/ui/progress";
import type { UpdateState } from "@/hooks/useUpdater";
import { formatBytes } from "@/lib/api";
import { cn } from "@/lib/utils";

interface UpdateBannerProps {
  state: UpdateState;
  dismissed: boolean;
  onInstall: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}

/**
 * A quiet strip along the bottom when a new version is out.
 *
 * Never a modal. An update is not urgent, and interrupting someone halfway
 * through assembling a volume to tell them about one would be worse than the
 * problem it solves.
 */
export function UpdateBanner({
  state,
  dismissed,
  onInstall,
  onRestart,
  onDismiss,
}: UpdateBannerProps) {
  const showing =
    !dismissed &&
    (state.stage === "available" ||
      state.stage === "downloading" ||
      state.stage === "installed");

  if (!showing) return null;

  return (
    <div
      className={cn(
        "absolute left-1/2 z-50 flex w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 shadow-lg",
        // A phone's navigation lives at the bottom of the window, and this was
        // landing on top of it — the tabs stopped responding while an update
        // was on offer, which reads as the app being broken.
        isMobile ? "bottom-20" : "bottom-4",
      )}
    >
      {state.stage === "installed" ? (
        <>
          <RefreshCw className="size-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 text-xs">
            <span className="font-medium">Version {state.version} is ready.</span>{" "}
            <span className="text-muted-foreground">
              Restart to start using it.
            </span>
          </p>
          <Button size="sm" onClick={onRestart}>
            Restart now
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDismiss}>
            <X className="size-3" />
          </Button>
        </>
      ) : state.stage === "downloading" ? (
        <>
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {/* Some servers do not declare a length; the byte counter beside
                this still moves, so the bar simply stays at zero. */}
            <Progress
              value={state.total ? ((state.downloaded ?? 0) / state.total) * 100 : 0}
              className="flex-1"
            />
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {formatBytes(state.downloaded ?? 0)}
              {state.total ? ` / ${formatBytes(state.total)}` : ""}
            </span>
          </div>
        </>
      ) : (
        <>
          <Download className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              Mangalize {state.version} is available
            </p>
            {/* An error here is not a dead end — it is usually "allow installs
                from this app first", and the offer is still good. Notes are the
                release body, which on Android is desktop download instructions
                and not worth the line. */}
            {state.error ? (
              <p className="text-[11px] text-amber-500" title={state.error}>
                {state.error}
              </p>
            ) : (
              !isAndroid &&
              state.notes && (
                <p className="truncate text-[11px] text-muted-foreground" title={state.notes}>
                  {state.notes}
                </p>
              )
            )}
          </div>
          <Button size="sm" onClick={onInstall}>
            Update
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDismiss} title="Not now">
            <X className="size-3" />
          </Button>
        </>
      )}
    </div>
  );
}
