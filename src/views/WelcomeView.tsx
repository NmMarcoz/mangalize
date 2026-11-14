import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";

import { Wordmark } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { canPickFolders, isMobile } from "@/lib/platform";
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
  const t = useT();
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
        {/* The wordmark at full size, plus tagline, is wider than a phone can
            hold beside its padding, so it steps down there. */}
        <Wordmark size={isMobile ? 96 : 120} tagline />
        <h1 className="mt-8 text-lg font-semibold">{t("welcomeView.title")}</h1>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {canPickFolders ? t("welcomeView.introPicker") : t("welcomeView.introNoPicker")}
        </p>

        <div className="mt-7 flex flex-col gap-2">
          <Label>{t("welcomeView.buildFolder")}</Label>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px]">
              {folder ?? "…"}
            </span>
            {canPickFolders && (
              <Button variant="outline" size="sm" onClick={() => void pick()}>
                <FolderOpen />
                {t("welcomeView.change")}
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {canPickFolders ? t("welcomeView.hintPicker") : t("welcomeView.hintNoPicker")}
          </p>
        </div>

        <div className="mt-7 flex items-center gap-2">
          <Button onClick={() => void confirm(folder)} disabled={!folder || saving}>
            {saving && <Loader2 className="animate-spin" />}
            {canPickFolders ? t("welcomeView.useThisFolder") : t("welcomeView.getStarted")}
          </Button>
          {/* "Decide later" means Build asks where each time, which needs a
              folder picker Android does not have. */}
          {canPickFolders && (
            <Button
              variant="ghost"
              onClick={() => void confirm(null)}
              disabled={saving}
              title={t("welcomeView.decideLaterHint")}
            >
              {t("welcomeView.decideLater")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
