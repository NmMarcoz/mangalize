import {
  ArrowLeft,
  FolderOpen,
  Loader2,
  PackageCheck,
  RefreshCw,
  Send,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
  const pages = volumePageCount(volume);
  const spreads = volumeSpreadCount(volume);

  return (
    <header className="flex shrink-0 flex-col border-b border-border bg-card/60">
      <div
        className={cn(
          "flex gap-3 px-4 py-2.5",
          // The title and the build controls together are wider than a phone,
          // and flex resolves that by squeezing the title to nothing. Stacking
          // costs a row and keeps both readable.
          isMobile ? "flex-col items-stretch" : "items-center",
        )}
      >
        <div className={cn("flex items-center gap-3", isMobile && "min-w-0")}>
        <Hint label="Back to the library">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft />
          </Button>
        </Hint>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">
              {volume.metadata.series || "Untitled volume"}
            </h1>
            {!isMobile && (
              <>
                <Badge variant="outline">{volume.chapters.length} chapters</Badge>
                <Badge variant="outline">{pages} pages</Badge>
                {spreads > 0 && <Badge>{spreads} spreads</Badge>}
              </>
            )}
          </div>
          <p
            className="truncate text-[11px] text-muted-foreground"
            data-selectable
            title={volume.root}
          >
            {/* The folder is a desktop-sized path and nothing a phone can act
                on, so there the counts take the line instead. */}
            {isMobile
              ? `${volume.chapters.length} chapters · ${pages} pages${spreads > 0 ? ` · ${spreads} spreads` : ""}`
              : volume.root}
          </p>
        </div>
        </div>

        <div className={cn("flex items-center gap-2", isMobile && "justify-end")}>
          {canPickFolders && (
          <Hint label="Reload this folder from disk">
            <Button variant="ghost" size="icon" onClick={onRescan} disabled={scanning}>
              {scanning ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
            </Button>
          </Hint>
          )}
          {canPickFolders && (
            <Hint label="Open another folder">
              <Button variant="ghost" size="icon" onClick={onOpenFolder}>
                <FolderOpen />
              </Button>
            </Hint>
          )}

          <Separator orientation="vertical" className="mx-1 h-6" />

          <Select value={format} onValueChange={(v) => onFormat(v as Format)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="epub">EPUB · Kindle</SelectItem>
              <SelectItem value="cbz">CBZ · Comic</SelectItem>
            </SelectContent>
          </Select>

          <Button onClick={onExport} disabled={building !== null || pages === 0}>
            {building ? <Loader2 className="animate-spin" /> : <Upload />}
            Build
          </Button>
          {canPickFolders && (
            <Hint label="Choose a one-off location">
              <Button
                variant="outline"
                onClick={onExportAs}
                disabled={building !== null || pages === 0}
              >
                Build as…
              </Button>
            </Hint>
          )}
          {canSendToDevice && (
            <Hint label="Build if needed, then email it to your Kindle">
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

      <div className="flex items-center gap-4 border-t border-border/60 px-4 py-1.5">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showExcluded} onCheckedChange={onShowExcluded} />
          Show excluded
        </label>

        <Separator orientation="vertical" className="h-4" />

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Size
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
                {report.pages} pages · {formatBytes(report.bytes)}
              </span>
            </button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {isMobile ? "" : "X exclude · S split · C cover · Esc clear"}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
