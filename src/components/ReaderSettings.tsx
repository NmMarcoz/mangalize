import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Chip, OptionCard } from "@/components/ui/chip";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { languageName } from "@/lib/api";
import { readerFits, readerModes, type ReaderPrefs } from "@/lib/reader";

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

  const overline = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
  const shadeLabel = {
    black: t("common.black"),
    grey: t("common.grey"),
    white: t("common.white"),
  } as const;

  return (
    // Always dark, whatever the app theme: it floats over the page being read,
    // and a light panel there flashes. The `dark` class swaps the tokens for
    // this subtree only.
    <aside className="dark absolute right-3 top-16 z-30 flex max-h-[calc(100dvh-5rem)] w-[304px] flex-col overflow-hidden rounded-xl border border-border bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2.5">
        <h2 className="flex-1 text-sm font-medium">{t("readerSettings.title")}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="scrollbar-thin flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4">
        {/* Only when there is a choice. Swapping keeps the chapter and the page
            and changes nothing but which images are fetched. */}
        {translations.length > 1 && (
          <section className="flex flex-col gap-2">
            <Label className={overline}>{t("readerSettings.translation")}</Label>
            <div className="flex items-center gap-2">
              <select
                value={language}
                disabled={switching}
                onChange={(e) => onLanguage(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground disabled:opacity-50"
              >
                {translations.map((code) => (
                  <option key={code} value={code} className="bg-popover">
                    {languageName(code)}
                  </option>
                ))}
              </select>
              {switching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("readerSettings.translationHint")}
            </p>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <Label className={overline}>{t("readerSettings.layout")}</Label>
          <div role="radiogroup" className="flex flex-col gap-1.5">
            {readerModes(t).map((mode) => (
              <OptionCard
                key={mode.value}
                selected={prefs.mode === mode.value}
                title={mode.label}
                detail={mode.detail}
                onClick={() => onChange({ mode: mode.value })}
              />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <Label className={overline}>{t("readerSettings.fit")}</Label>
          <div role="radiogroup" className="flex flex-wrap gap-1.5">
            {readerFits(t).map((fit) => (
              <Chip
                key={fit.value}
                selected={prefs.fit === fit.value}
                onClick={() => onChange({ fit: fit.value })}
              >
                {fit.label}
              </Chip>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <Label className={overline}>{t("readerSettings.direction")}</Label>
          <div role="radiogroup" className="flex flex-wrap gap-1.5">
            <Chip
              selected={prefs.direction === null}
              onClick={() => onChange({ direction: null })}
            >
              {t("readerSettings.directionAuto", { direction: directionLabel })}
            </Chip>
            <Chip
              selected={prefs.direction === "right-to-left"}
              onClick={() => onChange({ direction: "right-to-left" })}
            >
              {t("readerSettings.directionOptionRightToLeft")}
            </Chip>
            <Chip
              selected={prefs.direction === "left-to-right"}
              onClick={() => onChange({ direction: "left-to-right" })}
            >
              {t("readerSettings.directionOptionLeftToRight")}
            </Chip>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("readerSettings.directionHint")}
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <Label className={overline}>{t("readerSettings.background")}</Label>
          <div role="radiogroup" className="flex flex-wrap gap-1.5">
            {(["black", "grey", "white"] as const).map((shade) => (
              <Chip
                key={shade}
                selected={prefs.background === shade}
                className="capitalize"
                onClick={() => onChange({ background: shade })}
              >
                {shadeLabel[shade]}
              </Chip>
            ))}
          </div>
        </section>
      </div>

      <p className="shrink-0 border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        {t("readerSettings.help")}
      </p>
    </aside>
  );
}
