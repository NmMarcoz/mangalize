import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Check, FolderOpen, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { getSettings, setSettings, type Settings } from "@/lib/settings";

interface SettingsViewProps {
  /** Lets the rest of the app pick up a changed library or output folder. */
  onSaved: (settings: Settings) => void;
  onError: (message: string | null) => void;
}

/** Where things live and what Build does by default. */
export function SettingsView({ onSaved, onError }: SettingsViewProps) {
  const [settings, setLocal] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings()
      .then(setLocal)
      .catch((e) => onError(String(e)));
  }, [onError]);

  const patch = useCallback((fields: Partial<Settings>) => {
    setSaved(false);
    setLocal((current) => (current ? { ...current, ...fields } : current));
  }, []);

  const pickFolder = useCallback(async (): Promise<string | null> => {
    const picked = await openDialog({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    onError(null);
    try {
      const stored = await setSettings(settings);
      setLocal(stored);
      setSaved(true);
      onSaved(stored);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }, [settings, onSaved, onError]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4 py-2.5">
        <h1 className="flex-1 text-sm font-semibold">Settings</h1>
        <Button onClick={() => void save()} disabled={!settings || saving}>
          {saving ? <Loader2 className="animate-spin" /> : saved ? <Check /> : null}
          {saved ? "Saved" : "Save"}
        </Button>
      </header>

      <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!settings ? (
          <div className="flex items-center gap-2 p-5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
            <FolderSetting
              label="Library folder"
              hint="Where series, chapters and cover art are stored. Moving this does not move existing files; point it at a folder you have already copied."
              value={settings.library_root}
              onPick={async () => {
                const picked = await pickFolder();
                if (picked) patch({ library_root: picked });
              }}
            />

            <Separator />

            <FolderSetting
              label="Build folder"
              hint="Where Build writes without asking. Build as… still lets you choose a one-off location."
              value={settings.output_root}
              placeholder="Not set — Build will ask every time"
              onPick={async () => {
                const picked = await pickFolder();
                if (picked) patch({ output_root: picked });
              }}
              onClear={() => patch({ output_root: null })}
            />

            <label className="flex cursor-pointer items-start gap-3">
              <Switch
                checked={settings.folder_per_series}
                onCheckedChange={(on) => patch({ folder_per_series: on })}
                className="mt-0.5"
              />
              <span className="text-xs">
                <span className="font-medium">A folder per series</span>
                <span className="mt-0.5 block text-muted-foreground">
                  {settings.folder_per_series
                    ? "Ichi the Witch/Ichi the Witch v01.epub"
                    : "Ichi the Witch v01.epub — everything in one folder"}
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3">
              <Switch
                checked={settings.split_spreads}
                onCheckedChange={(on) => patch({ split_spreads: on })}
                className="mt-0.5"
              />
              <span className="text-xs">
                <span className="font-medium">Split double-page spreads</span>
                <span className="mt-0.5 block text-muted-foreground">
                  {settings.split_spreads
                    ? "Each spread becomes two pages, right half first for manga. Kindle zooms into part of a wide page instead of fitting it, so this is almost always what you want."
                    : "Spreads stay whole. Fine on a tablet or a desktop reader; on a Kindle you will see half the drawing."}
                </span>
              </span>
            </label>

            <Separator />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="format">Default format</Label>
              <Select
                value={settings.default_format}
                onValueChange={(v) => patch({ default_format: v })}
              >
                <SelectTrigger id="format" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="epub">EPUB · Kindle</SelectItem>
                  <SelectItem value="cbz">CBZ · Comic readers</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Pre-selected in the editor, and what a batch build uses.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function FolderSetting({
  label,
  hint,
  value,
  placeholder,
  onPick,
  onClear,
}: {
  label: string;
  hint: string;
  value: string | null;
  placeholder?: string;
  onPick: () => void;
  onClear?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => value && void revealItemInDir(value)}
          disabled={!value}
          title={value ? "Reveal in file manager" : undefined}
          className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-3 py-2 text-left font-mono text-[11px] enabled:hover:border-muted-foreground/40 disabled:text-muted-foreground"
        >
          {value ?? placeholder ?? "Not set"}
        </button>
        <Button variant="outline" size="sm" onClick={onPick}>
          <FolderOpen />
          Change
        </Button>
        {onClear && value && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
}
