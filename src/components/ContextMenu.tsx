import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuProps {
  /** Where the right-click happened, in viewport coordinates. */
  at: ContextMenuPosition;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A menu anchored at the pointer.
 *
 * Hand-rolled rather than pulled in as a dependency: the whole requirement is
 * "appear here, close on Escape or a click elsewhere", and the one subtlety —
 * not hanging off the edge of the window — is a few lines.
 */
export function ContextMenu({ at, onClose, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(at);

  // Measure after mount so a menu opened near the right or bottom edge flips
  // back inside the window instead of being clipped.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    setPosition({
      x: Math.min(at.x, window.innerWidth - width - 8),
      y: Math.min(at.y, window.innerHeight - height - 8),
    });
  }, [at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // `pointerdown` rather than `click`, so the menu is gone before whatever
    // was underneath reacts to the press.
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 min-w-52 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

export function ContextMenuItem({
  onSelect,
  disabled,
  hint,
  children,
}: {
  onSelect: () => void;
  disabled?: boolean;
  /** Right-aligned secondary text, e.g. a count or a shortcut. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
        disabled
          ? "cursor-not-allowed text-muted-foreground/50"
          : "hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <span className="flex-1">{children}</span>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}
