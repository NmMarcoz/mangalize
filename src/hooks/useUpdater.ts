import { useCallback, useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installed"
  | "uptodate"
  | "error";

export interface UpdateState {
  stage: UpdateStage;
  version?: string;
  notes?: string;
  /** Bytes downloaded so far, and the total when the server declared one. */
  downloaded?: number;
  total?: number;
  error?: string;
}

/**
 * Checking for, downloading and installing an update.
 *
 * The check on startup is deliberately silent: it fails in development, on a
 * machine with no network, and on any build that was not installed from a
 * release. None of those are worth interrupting the user over, so only an
 * explicitly requested check ever reports a failure.
 */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ stage: "idle" });
  const [dismissed, setDismissed] = useState(false);

  // Held between check and install so the download does not re-resolve it.
  const pending = useRef<Update | null>(null);

  const runCheck = useCallback(async (silent: boolean) => {
    setState({ stage: "checking" });
    try {
      const found = await check();
      if (!found) {
        pending.current = null;
        setState({ stage: "uptodate" });
        return;
      }
      pending.current = found;
      setDismissed(false);
      setState({
        stage: "available",
        version: found.version,
        notes: found.body ?? undefined,
      });
    } catch (e) {
      pending.current = null;
      // A silent check that fails leaves no trace: there is nothing the user
      // could do about it and nothing they asked for.
      setState(silent ? { stage: "idle" } : { stage: "error", error: String(e) });
    }
  }, []);

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;

    setState((current) => ({ ...current, stage: "downloading", downloaded: 0 }));
    try {
      let downloaded = 0;
      let total: number | undefined;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
          setState((current) => ({ ...current, total }));
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setState((current) => ({ ...current, downloaded, total }));
        }
      });

      setState((current) => ({ ...current, stage: "installed" }));
    } catch (e) {
      setState((current) => ({ ...current, stage: "error", error: String(e) }));
    }
  }, []);

  /** Restart into the version that was just installed. */
  const restart = useCallback(async () => {
    await relaunch();
  }, []);

  // One silent check per launch. Re-checking on every render or on a timer
  // would hit GitHub far more than a desktop app has any reason to.
  useEffect(() => {
    void runCheck(true);
  }, [runCheck]);

  return {
    state,
    dismissed,
    checkNow: () => void runCheck(false),
    install: () => void install(),
    restart: () => void restart(),
    dismiss: () => setDismissed(true),
  };
}
