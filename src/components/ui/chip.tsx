import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A single-choice pill — the Figma "Chip". Used where a few short options sit
 * side by side (reader fit and direction, theme, which title to use). Put a
 * group of them in a `role="radiogroup"` container.
 */
export const Chip = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }
>(({ selected = false, className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    role="radio"
    aria-checked={selected}
    className={cn(
      "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
      selected
        ? "border-primary bg-primary/15 font-medium text-primary"
        : "border-border text-foreground hover:bg-accent",
      className,
    )}
    {...props}
  />
));
Chip.displayName = "Chip";

/**
 * A single-choice option with an explanation — the Figma "Option card".
 */
export function OptionCard({
  selected,
  title,
  detail,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  selected: boolean;
  title: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-lg border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
        className,
      )}
      {...props}
    >
      <span className={cn("text-xs font-medium", selected ? "text-primary" : "text-foreground")}>
        {title}
      </span>
      {detail && <span className="text-[11px] leading-relaxed text-muted-foreground">{detail}</span>}
    </button>
  );
}
