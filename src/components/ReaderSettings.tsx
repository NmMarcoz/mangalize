import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { languageName } from "@/lib/api";
import { readerFits, readerModes, type ReaderPrefs } from "@/lib/reader";
import { cn } from "@/lib/utils";

interface ReaderSettingsProps {
  /** Every translation the source has, or empty when there is nothing to pick. */
  translations: string[];
  language: string;
  switching: boolean;
  onLanguage: (code: string) => void;
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
  translations,
  language,
  switching,
  onLanguage,
  onChange,
  onClose,
}: ReaderSettingsProps) {
  const t = useT();
  const directionLabel =
    seriesDirection === "right-to-left"
      ? t("readerSettings.directionRightToLeft")
      : t("readerSettings.directionLeftToRight");

  return (
    <aside className="absolute right-3 top-16 z-30 flex w-72 flex-col gap-4 rounded-lg border border-white/15 bg-neutral-900/95 p-4 text-white shadow-xl backdrop-blur">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">{t("readerSettings.title")}</h2>
        <Button variant="ghost" size="icon-sm" className="text-white" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Only when there is a choice. Swapping keeps the chapter and the page
          and changes nothing but which images are fetched. */}
      {translations.length > 1 && (
        <section className="flex flex-col gap-1.5">
          <Label className="text-white/70">{t("readerSettings.translation")}</Label>
          <div className="flex items-center gap-2">
            <select
              value={language}
              disabled={switching}
              onChange={(e) => onLanguage(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-white/15 bg-white/5 px-2 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {translations.map((code) => (
                <option key={code} value={code} className="bg-neutral-900">
                  {languageName(code)}
                </option>
              ))}
            </select>
            {switching && <Loader2 className="size-3.5 animate-spin text-white/60" />}
          </div>
          <p className="text-[11px] text-white/45">{t("readerSettings.translationHint")}</p>
        </section>
      )}

      <section className="flex flex-col gap-1.5">
        <Label className="text-white/70">{t("readerSettings.layout")}</Label>
        <div className="flex flex-col gap-1">
          {readerModes(t).map((mode) => (
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
        <Label className="text-white/70">{t("readerSettings.fit")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {readerFits(t).map((fit) => (
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
        <Label className="text-white/70">{t("readerSettings.direction")}</Label>
        <div className="flex flex-wrap gap-1.5">
          <Chip
            label={t("readerSettings.directionAuto", { direction: directionLabel })}
            active={prefs.direction === null}
            onClick={() => onChange({ direction: null })}
          />
          <Chip
            label={t("readerSettings.directionOptionRightToLeft")}
            active={prefs.direction === "right-to-left"}
            onClick={() => onChange({ direction: "right-to-left" })}
          />
          <Chip
            label={t("readerSettings.directionOptionLeftToRight")}
            active={prefs.direction === "left-to-right"}
            onClick={() => onChange({ direction: "left-to-right" })}
          />
        </div>
        <p className="text-[10px] leading-snug text-white/50">
          {t("readerSettings.directionHint")}
        </p>
      </section>

      <section className="flex flex-col gap-1.5">
        <Label className="text-white/70">{t("readerSettings.background")}</Label>
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
        {t("readerSettings.help")}
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
