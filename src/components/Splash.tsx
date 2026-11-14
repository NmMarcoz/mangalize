import { Wordmark } from "@/components/Logo";
import { useT } from "@/lib/i18n";

/**
 * What the window shows while settings are still being read — the moment
 * before the first real screen. It used to be blank, which on a slow disk
 * looked like the app had failed to start.
 */
export function Splash() {
  const t = useT();
  return (
    <div className="relative flex h-full flex-1 items-center justify-center overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 size-[56rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-green opacity-[0.08] blur-3xl dark:opacity-35"
      />
      <div className="relative flex flex-col items-center gap-10">
        <Wordmark size={140} tagline />
        <div className="flex flex-col items-center gap-3">
          <div className="h-1 w-60 overflow-hidden rounded-full bg-secondary">
            <div className="h-full w-2/5 animate-[splash_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
          </div>
          <p className="text-[11px] text-muted-foreground">{t("app.opening")}</p>
        </div>
      </div>
    </div>
  );
}
