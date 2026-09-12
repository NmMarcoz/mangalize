import { useCallback, useState } from "react";
import {
  BookOpen,
  CloudDownload,
  Compass,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Send,
  Settings,
} from "lucide-react";

import type { UpdateStage } from "@/hooks/useUpdater";
import { cn } from "@/lib/utils";

/** Top-level destinations. A series or the editor both live under the library. */
export type Section = "library" | "explore" | "send" | "settings";

interface SidebarProps {
  active: Section;
  onNavigate: (to: Section) => void;
  updateStage: UpdateStage;
  onCheckUpdates: () => void;
}

/** Remembered across launches; purely chrome, so it does not belong in settings. */
const EXPANDED_KEY = "mangalize:sidebar-expanded";

/**
 * The app's left rail.
 *
 * Collapsed to icons by default because the volume editor wants every pixel it
 * can get — a page grid and a metadata panel already compete for the width.
 * Expanding is one click and is remembered.
 */
export function Sidebar({
  active,
  onNavigate,
  updateStage,
  onCheckUpdates,
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

  return (
    <nav
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-card/40 py-2 transition-[width] duration-150",
        expanded ? "w-44" : "w-14",
      )}
    >
      <div className="flex flex-col gap-1 px-2">
        <Item
          icon={<BookOpen className="size-4" />}
          label="Library"
          expanded={expanded}
          active={active === "library"}
          onClick={() => onNavigate("library")}
        />
        <Item
          icon={<Compass className="size-4" />}
          label="Explore"
          expanded={expanded}
          active={active === "explore"}
          onClick={() => onNavigate("explore")}
        />
        <Item
          icon={<Send className="size-4" />}
          label="Send to Kindle"
          expanded={expanded}
          active={active === "send"}
          onClick={() => onNavigate("send")}
        />
        <Item
          icon={<Settings className="size-4" />}
          label="Settings"
          expanded={expanded}
          active={active === "settings"}
          onClick={() => onNavigate("settings")}
        />
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
