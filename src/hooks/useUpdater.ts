import { useCallback, useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { isAndroid } from "@/lib/platform";

/** What `android_update_check` answers with. */
interface AndroidUpdate {
  version: string;
  notes: string;
  url: string;
  bytes: number;
}

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

  /**
   * The Android release, when there is a newer one.
   *
   * Held separately from `pending` because the two update paths have nothing in
   * common: one is a plugin's `Update` object, the other is a URL to fetch.
   */
  const androidUpdate = useRef<AndroidUpdate | null>(null);

  const runCheck = useCallback(async (silent: boolean) => {
    setState({ stage: "checking" });

    // Android has no updater plugin, so the app asks GitHub itself and hands
    // the APK to the system installer. See `src-tauri/src/update.rs`.
    if (isAndroid) {
      try {
        const found = await invoke<AndroidUpdate | null>("android_update_check");
        if (!found) {
          androidUpdate.current = null;
          setState({ stage: "uptodate" });
          return;
        }
        androidUpdate.current = found;
        setDismissed(false);
        setState({ stage: "available", version: found.version, notes: found.notes });
      } catch (e) {
        androidUpdate.current = null;
        setState(silent ? { stage: "idle" } : { stage: "error", error: String(e) });
      }
      return;
    }

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
    if (isAndroid) {
      const found = androidUpdate.current;
      if (!found) return;
      setState((current) => ({
        ...current,
        stage: "downloading",
        downloaded: 0,
        total: found.bytes,
      }));
      try {
        await invoke("android_update_install", { url: found.url });
        // The system installer takes over from here, and whether the user goes
        // through with it is not something the app is told. "Installed" would
        // be a claim; this is only "we handed it over".
        setState((current) => ({ ...current, stage: "idle" }));
      } catch (e) {
        setState((current) => ({ ...current, stage: "error", error: String(e) }));
      }
      return;
    }

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

  // The Android download reports itself over an event, because it is the
  // backend doing the fetching rather than a plugin with a callback.
  useEffect(() => {
    if (!isAndroid) return;
    const pending = listen<{ downloaded: number; total: number }>(
      "android-update-progress",
      (e) =>
        setState((current) =>
          current.stage === "downloading"
            ? { ...current, downloaded: e.payload.downloaded, total: e.payload.total }
            : current,
        ),
    );
    return () => {
      void pending.then((fn) => fn());
    };
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
