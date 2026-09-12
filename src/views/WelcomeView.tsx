import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { BookOpen, FolderOpen, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  getSettings,
  setSettings,
  suggestedOutputRoot,
  type Settings,
} from "@/lib/settings";

interface WelcomeViewProps {
  onDone: (settings: Settings) => void;
  onError: (message: string | null) => void;
}

/**
 * Shown once, before there is anywhere to put a finished volume.
 *
 * Asking here rather than at the first export means Build can simply work later
 * on, instead of interrupting someone who has just spent ten minutes choosing
 * pages. A sensible folder is filled in already, so the whole screen can be
 * cleared with one click.
 */
export function WelcomeView({ onDone, onError }: WelcomeViewProps) {
  const [folder, setFolder] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    suggestedOutputRoot()
      .then(setFolder)
      .catch((e) => onError(String(e)));
  }, [onError]);

  const pick = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setFolder(picked);
  }, []);

  const confirm = useCallback(
    async (output: string | null) => {
      setSaving(true);
      onError(null);
      try {
        const current = await getSettings();
        const stored = await setSettings({
          ...current,
          output_root: output,
          welcomed: true,
        });
        onDone(stored);
      } catch (e) {
        onError(String(e));
        setSaving(false);
      }
    },
    [onDone, onError],
  );

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg">
        <BookOpen className="size-8 text-primary" />
        <h1 className="mt-4 text-lg font-semibold">Welcome to Mangalize</h1>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Where should finished volumes go? Build will write here without asking,
          filing each volume under its series. You can change this any time in
          Settings, and Build as… will always let you pick a one-off location.
        </p>

        <div className="mt-5 flex flex-col gap-1.5">
          <Label>Build folder</Label>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px]">
              {folder ?? "…"}
            </span>
            <Button variant="outline" size="sm" onClick={() => void pick()}>
              <FolderOpen />
              Change
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Created for you if it does not exist yet.
          </p>
        </div>

        <div className="mt-6 flex items-center gap-2">
          <Button onClick={() => void confirm(folder)} disabled={!folder || saving}>
            {saving && <Loader2 className="animate-spin" />}
            Use this folder
          </Button>
          <Button
            variant="ghost"
            onClick={() => void confirm(null)}
            disabled={saving}
            title="Build will ask for a location each time"
          >
            Decide later
          </Button>
        </div>
      </div>
    </div>
  );
}
