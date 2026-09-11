import { ArrowLeftRight, Image as ImageIcon, Sparkles, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useThumbnail } from "@/hooks/useThumbnail";
import {
  effectiveCover,
  fileName as baseName,
  type Direction,
  type Metadata,
  type Volume,
} from "@/lib/api";

interface MetadataPanelProps {
  volume: Volume;
  onChange: (patch: Partial<Metadata>) => void;
  onPickCover: () => void;
  onClearCover: () => void;
  onFetchMetadata: () => void;
  /** What the user typed for the output name. Empty means "use the suggestion". */
  fileName: string;
  /** The name derived from the metadata, shown as the placeholder. */
  suggestedFileName: string;
  onFileName: (name: string) => void;
}

export function MetadataPanel({
  volume,
  onChange,
  onPickCover,
  onClearCover,
  onFetchMetadata,
  fileName: exportName,
  suggestedFileName,
  onFileName,
}: MetadataPanelProps) {
  const cover = effectiveCover(volume);
  const { metadata } = volume;

  return (
    <aside className="scrollbar-thin flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-card/40 p-4">
      <Button variant="secondary" size="sm" onClick={onFetchMetadata}>
        <Sparkles /> Fetch metadata online
      </Button>

      <section className="flex flex-col gap-2">
        <Label>Cover</Label>
        <CoverPreview path={cover} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={onPickCover}>
            <ImageIcon /> Choose file
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearCover}
            disabled={!volume.cover}
            title="Fall back to the first page"
          >
            Reset
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {volume.cover
            ? baseName(volume.cover)
            : "Using page one. Press C on any page to promote it."}
        </p>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="series">Series</Label>
          <Input
            id="series"
            value={metadata.series}
            placeholder="Ichi the Witch"
            onChange={(e) => onChange({ series: e.target.value })}
          />
        </div>

        <div className="flex gap-2">
          <div className="flex w-24 flex-col gap-1.5">
            <Label htmlFor="volume">Volume</Label>
            <Input
              id="volume"
              type="number"
              min={0}
              value={metadata.volume ?? ""}
              placeholder="1"
              onChange={(e) =>
                onChange({
                  volume: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="language">Language</Label>
            <Input
              id="language"
              value={metadata.language}
              placeholder="en"
              onChange={(e) => onChange({ language: e.target.value })}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="author">Author</Label>
          <Input
            id="author"
            value={metadata.author}
            placeholder="Osamu Nishi"
            onChange={(e) => onChange({ author: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="direction">Reading direction</Label>
          <Select
            value={metadata.direction}
            onValueChange={(v) => onChange({ direction: v as Direction })}
          >
            <SelectTrigger id="direction">
              <span className="flex items-center gap-2">
                <ArrowLeftRight className="size-3.5 opacity-60" />
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="right-to-left">Right to left (manga)</SelectItem>
              <SelectItem value="left-to-right">Left to right</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={metadata.description}
            placeholder="Optional blurb shown in your library."
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-1.5">
        <Label htmlFor="filename">Export as</Label>
        <Input
          id="filename"
          value={exportName}
          placeholder={suggestedFileName}
          onChange={(e) => onFileName(e.target.value)}
        />
        <p className="text-[11px] leading-snug text-muted-foreground">
          {exportName.trim()
            ? "Used as the file name when you export."
            : "Taken from the series and volume above. Type to override."}
        </p>
      </section>
    </aside>
  );
}

function CoverPreview({ path }: { path: string | null }) {
  if (!path) {
    return (
      <div className="flex aspect-[10/14] w-full items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
        <Star className="size-6 opacity-40" />
      </div>
    );
  }
  return <CoverImage path={path} />;
}

function CoverImage({ path }: { path: string }) {
  const { ref, url } = useThumbnail(path, 560);
  return (
    <div
      ref={ref}
      className="flex aspect-[10/14] w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-black/30"
    >
      {url && (
        <img
          src={url}
          alt="Cover"
          draggable={false}
          className="max-h-full max-w-full object-contain"
        />
      )}
    </div>
  );
}
