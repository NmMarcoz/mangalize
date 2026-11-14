import {
  ArrowLeft,
  FolderOpen,
  Loader2,
  PackageCheck,
  RefreshCw,
  Send,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Hint } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { canPickFolders, canSendToDevice, isMobile } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  volumePageCount,
  volumeSpreadCount,
  type BuildReport,
  type Format,
  type Volume,
} from "@/lib/api";

interface ToolbarProps {
  volume: Volume;
  format: Format;
  showExcluded: boolean;
  thumbWidth: number;
  building: { done: number; total: number } | null;
  report: BuildReport | null;
  scanning: boolean;
  onFormat: (f: Format) => void;
  onShowExcluded: (v: boolean) => void;
  onThumbWidth: (w: number) => void;
  onOpenFolder: () => void;
  /** Return to where this volume came from. */
  onBack: () => void;
  onRescan: () => void;
  onExport: () => void;
  /** Always asks for a location, even when one is configured. */
  onExportAs: () => void;
  /** Build if needed, then mail the result to the configured device. */
  onSend: () => void;
  sending: boolean;
  onReveal: () => void;
}

export function Toolbar({
  volume,
  format,
  showExcluded,
  thumbWidth,
  building,
  report,
  scanning,
  onFormat,
  onShowExcluded,
  onThumbWidth,
  onOpenFolder,
  onBack,
  onRescan,
  onExport,
  onExportAs,
  onSend,
  sending,
  onReveal,
}: ToolbarProps) {
  const t = useT();
  const pages = volumePageCount(volume);
  const spreads = volumeSpreadCount(volume);
  const series = volume.metadata.series || t("toolbar.untitledVolume");
  const title =
    volume.metadata.series && volume.metadata.volume !== null
      ? t("toolbar.title", { series, volume: volume.metadata.volume })
      : series;
  const meta = [
    t("toolbar.chapters", { count: volume.chapters.length }),
    t("toolbar.pages", { count: pages }),
    ...(spreads > 0 ? [t("toolbar.spreads", { count: spreads })] : []),
  ].join(" · ");

  return (
    <header className="flex shrink-0 flex-col border-b border-border bg-card/60">
      <div
        className={cn(
          "flex gap-3 px-4 py-3",
          // The title and the build controls together are wider than a phone,
          // and flex resolves that by squeezing the title to nothing. Stacking
          // costs a row and keeps both readable.
          isMobile ? "flex-col items-stretch" : "items-center",
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-3", !isMobile && "flex-1")}>
          <Hint label={t("toolbar.backToLibrary")}>
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft />
            </Button>
          </Hint>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            {/* One quiet line rather than a row of badges: these are facts about
                the volume, not things to act on. The folder path lives in the
                open-folder button's tooltip, beside the action that changes it. */}
            <p className="truncate text-[11px] text-muted-foreground">{meta}</p>
          </div>
        </div>

        <div className={cn("flex items-center gap-2", isMobile && "justify-end")}>
          {canPickFolders && (
            <>
              <div className="flex items-center gap-1">
                <Hint label={t("toolbar.reloadFolder")}>
                  <Button variant="ghost" size="icon" onClick={onRescan} disabled={scanning}>
                    {scanning ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  </Button>
                </Hint>
                <Hint
                  label={
                    <span className="flex max-w-80 flex-col gap-0.5">
                      <span>{t("toolbar.openFolder")}</span>
                      <span className="break-all font-mono text-[10px] opacity-70">
                        {volume.root}
                      </span>
                    </span>
                  }
                >
                  <Button variant="ghost" size="icon" onClick={onOpenFolder}>
                    <FolderOpen />
                  </Button>
                </Hint>
              </div>

              <Separator orientation="vertical" className="mx-1 h-6" />
            </>
          )}

          <Select value={format} onValueChange={(v) => onFormat(v as Format)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="epub">{t("toolbar.formatEpub")}</SelectItem>
              <SelectItem value="cbz">{t("toolbar.formatCbz")}</SelectItem>
            </SelectContent>
          </Select>

          <Button onClick={onExport} disabled={building !== null || pages === 0}>
            {building ? <Loader2 className="animate-spin" /> : <Upload />}
            {t("toolbar.build")}
          </Button>
          {canPickFolders && (
            <Hint label={t("toolbar.chooseLocation")}>
              <Button
                variant="outline"
                onClick={onExportAs}
                disabled={building !== null || pages === 0}
              >
                {t("toolbar.buildAs")}
              </Button>
            </Hint>
          )}
          {canSendToDevice && (
            <Hint label={t("toolbar.sendHint")}>
              <Button
                variant="outline"
                size="icon"
                onClick={onSend}
                disabled={building !== null || sending || pages === 0}
              >
                {sending ? <Loader2 className="animate-spin" /> : <Send />}
              </Button>
            </Hint>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 border-t border-border/60 px-5 py-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showExcluded} onCheckedChange={onShowExcluded} />
          {t("toolbar.showExcluded")}
        </label>

        <Separator orientation="vertical" className="h-4" />

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t("toolbar.size")}
          <input
            type="range"
            min={110}
            max={260}
            step={10}
            value={thumbWidth}
            onChange={(e) => onThumbWidth(Number(e.target.value))}
            className="h-1 w-28 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          />
        </label>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          {building ? (
            <div className="flex w-64 items-center gap-2">
              <Progress value={(building.done / Math.max(1, building.total)) * 100} />
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {building.done}/{building.total}
              </span>
            </div>
          ) : report ? (
            <button
              onClick={onReveal}
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              title={report.path}
            >
              <PackageCheck className="size-3.5 shrink-0 text-primary" />
              <span className="truncate">
                {t("toolbar.reportSummary", {
                  pages: report.pages,
                  bytes: formatBytes(report.bytes),
                })}
              </span>
            </button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {isMobile ? "" : t("toolbar.shortcutsHint")}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
