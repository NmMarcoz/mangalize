import { useCallback, useState } from "react";
import {
  BookOpen,
  CloudDownload,
  Clock,
  Compass,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Send,
  Settings,
} from "lucide-react";

import type { UpdateStage } from "@/hooks/useUpdater";
import { canSendToDevice } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** Top-level destinations. A series or the editor both live under the library. */
export type Section = "library" | "explore" | "history" | "send" | "settings";

/**
 * Where the app's navigation sits.
 *
 * `rail` is the desktop column. `bar` is the phone's bottom row, which is not
 * the same control turned sideways: a thumb reaches the bottom of a phone and
 * nothing else, so the items get wider targets, always-on labels, and none of
 * the rail's chrome-management affordances.
 */
export type NavVariant = "rail" | "bar";

interface SidebarProps {
  active: Section;
  onNavigate: (to: Section) => void;
  updateStage: UpdateStage;
  onCheckUpdates: () => void;
  variant?: NavVariant;
}

// The bottom bar has no room for a check-for-updates entry and no sensible
// place to put one; on a phone that lives in Settings instead.

/** Remembered across launches; purely chrome, so it does not belong in settings. */
const EXPANDED_KEY = "mangalize:sidebar-expanded";

interface Destination {
  section: Section;
  icon: React.ReactNode;
  label: string;
}

function destinations(): Destination[] {
  const all: Destination[] = [
    { section: "library", icon: <BookOpen className="size-4" />, label: "Library" },
    { section: "explore", icon: <Compass className="size-4" />, label: "Explore" },
    { section: "history", icon: <Clock className="size-4" />, label: "History" },
    { section: "send", icon: <Send className="size-4" />, label: "Send to Kindle" },
    { section: "settings", icon: <Settings className="size-4" />, label: "Settings" },
  ];
  return all.filter((d) => d.section !== "send" || canSendToDevice);
}

/**
 * The app's navigation.
 *
 * As a rail it is collapsed to icons by default, because the volume editor wants
 * every pixel it can get — a page grid and a metadata panel already compete for
 * the width. Expanding is one click and is remembered.
 */
export function Sidebar({
  active,
  onNavigate,
  updateStage,
  onCheckUpdates,
  variant = "rail",
}: SidebarProps) {
  const [expanded, setExpanded] = useState(
    () => localStorage.getItem(EXPANDED_KEY) === "true",
  );

  const toggle = useCallback(() => {
    setExpanded((current) => {
      localStorage.setItem(EXPANDED_KEY, String(!current));
      return !current;
    });
  }, []);

  if (variant === "bar") {
    return (
      <nav
        className="flex shrink-0 items-stretch border-t border-border bg-card/80 backdrop-blur"
        // Android's gesture bar is already padded around by the activity; this
        // is for a platform that reports it to CSS instead, and is zero here.
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {destinations().map((d) => (
          <Tab
            key={d.section}
            icon={d.icon}
            label={d.section === "send" ? "Send" : d.label}
            active={active === d.section}
            onClick={() => onNavigate(d.section)}
          />
        ))}
      </nav>
    );
  }

  return (
    <nav
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-card/40 py-2 transition-[width] duration-150",
        expanded ? "w-44" : "w-14",
      )}
    >
      <div className="flex flex-col gap-1 px-2">
        {destinations().map((d) => (
          <Item
            key={d.section}
            icon={d.icon}
            label={d.label}
            expanded={expanded}
            active={active === d.section}
            onClick={() => onNavigate(d.section)}
          />
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-1 px-2">
        <Item
          icon={
            updateStage === "checking" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CloudDownload className="size-4" />
            )
          }
          label={updateStage === "uptodate" ? "Up to date" : "Check for updates"}
          expanded={expanded}
          active={false}
          disabled={updateStage === "checking"}
          onClick={onCheckUpdates}
          // A pip rather than a number: there is only ever one update to take.
          badge={updateStage === "available" || updateStage === "installed"}
        />
        <Item
          icon={
            expanded ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )
          }
          label="Collapse"
          expanded={expanded}
          active={false}
          onClick={toggle}
        />
      </div>
    </nav>
  );
}

/** One bottom-bar tab: a thumb-sized target with its label always showing. */
function Tab({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] transition-colors",
        active ? "text-primary" : "text-muted-foreground",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function Item({
  icon,
  label,
  expanded,
  active,
  disabled,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  expanded: boolean;
  active: boolean;
  disabled?: boolean;
  badge?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      // Collapsed, the label is the only thing naming the control, so it has to
      // reach a screen reader and a hover tooltip both.
      title={expanded ? undefined : label}
      aria-label={label}
      className={cn(
        "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-xs transition-colors",
        expanded ? "justify-start" : "justify-center",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="relative shrink-0">
        {icon}
        {badge && (
          <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />
        )}
      </span>
      {expanded && <span className="truncate">{label}</span>}
    </button>
  );
}
