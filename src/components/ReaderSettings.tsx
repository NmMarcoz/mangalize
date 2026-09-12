import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FITS, MODES, type ReaderPrefs } from "@/lib/reader";
import { cn } from "@/lib/utils";

interface ReaderSettingsProps {
  prefs: ReaderPrefs;
  /** What the series itself says, shown as the "Auto" option. */
  seriesDirection: string;
  onChange: (patch: Partial<ReaderPrefs>) => void;
  onClose: () => void;
}

/**
 * Reader preferences, over the page rather than on another screen.
 *
 * Every one of these is something you change *while* reading and want to see
 * the effect of immediately — a mode that suits one series is wrong for the
 * next. They are stored client-side because they are chrome, not library data.
 */
export function ReaderSettings({
  prefs,
  seriesDirection,
  onChange,
  onClose,
}: ReaderSettingsProps) {
  const directionLabel =
    seriesDirection === "right-to-left" ? "right to left" : "left to right";

  return (
    <aside className="absolute right-3 top-16 z-30 flex w-72 flex-col gap-4 rounded-lg border border-white/15 bg-neutral-900/95 p-4 text-white shadow-xl backdrop-blur">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">Reader</h2>
        <Button variant="ghost" size="icon-sm" className="text-white" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      <section className="flex flex-col gap-1.5">
        <Label className="text-white/70">Layout</Label>
        <div className="flex flex-col gap-1">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              onClick={() => onChange({ mode: mode.value })}
              className={cn(
                "rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                prefs.mode === mode.value
                  ? "border-primary bg-primary/20"
                  : "border-white/15 hover:bg-white/10",
              )}
            >
              <span className="font-medium">{mode.label}</span>
              <span className="mt-0.5 block text-[10px] text-white/50">
                {mode.detail}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <Label className="text-white/70">Fit</Label>
        <div className="flex flex-wrap gap-1.5">
          {FITS.map((fit) => (
            <Chip
              key={fit.value}
              label={fit.label}
              active={prefs.fit === fit.value}
              onClick={() => onChange({ fit: fit.value })}
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <Label className="text-white/70">Direction</Label>
        <div className="flex flex-wrap gap-1.5">
          <Chip
            label={`Auto (${directionLabel})`}
            active={prefs.direction === null}
            onClick={() => onChange({ direction: null })}
          />
          <Chip
            label="Right to left"
            active={prefs.direction === "right-to-left"}
            onClick={() => onChange({ direction: "right-to-left" })}
          />
          <Chip
            label="Left to right"
            active={prefs.direction === "left-to-right"}
            onClick={() => onChange({ direction: "left-to-right" })}
          />
        </div>
        <p className="text-[10px] leading-snug text-white/50">
          Auto follows the series, which the metadata usually gets right. Override
          when it does not.
        </p>
      </section>

      <section className="flex flex-col gap-1.5">
        <Label className="text-white/70">Background</Label>
        <div className="flex flex-wrap gap-1.5">
          {(["black", "grey", "white"] as const).map((shade) => (
            <Chip
              key={shade}
              label={shade}
              active={prefs.background === shade}
              onClick={() => onChange({ background: shade })}
            />
          ))}
        </div>
      </section>

      <p className="border-t border-white/10 pt-3 text-[10px] leading-relaxed text-white/40">
        Arrows turn pages, space moves on, Home and End jump to the ends, Esc
        closes. Tapping the middle of the page hides this chrome.
      </p>
    </aside>
  );
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] capitalize transition-colors",
        active
          ? "border-primary bg-primary/20 text-white"
          : "border-white/15 text-white/70 hover:bg-white/10",
      )}
    >
      {label}
    </button>
  );
}
