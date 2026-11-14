import { useCallback, useEffect, useState } from "react";

/**
 * Light, dark, or whatever the system is using.
 *
 * Kept in localStorage rather than `Settings`: it is chrome, like the sidebar
 * being expanded, and it has to be known before the first paint — the boot
 * script in `index.html` reads the same key so the window never flashes the
 * wrong theme while the settings round-trip is still in flight.
 */
export type ThemePreference = "system" | "light" | "dark";

const KEY = "leaf:theme";

export function getThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // Storage can be unavailable; the system theme is a fine answer then.
  }
  return "system";
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function apply(pref: ThemePreference) {
  const dark = pref === "dark" || (pref === "system" && systemDark());
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

/** The stored preference, a setter, and a listener that follows the OS when set to "system". */
export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [pref, setPref] = useState<ThemePreference>(getThemePreference);

  useEffect(() => {
    apply(pref);
    if (pref !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);

  const set = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Still applied for this session.
    }
    setPref(next);
  }, []);

  return [pref, set];
}
