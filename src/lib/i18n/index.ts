import { createContext, useContext, useMemo } from "react";

import { DICTIONARIES } from "@/lib/i18n/dictionaries";
import type { Dict, Language } from "@/lib/i18n/types";

export type { Language } from "@/lib/i18n/types";

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "pt-BR", label: "Português (Brasil)" },
];

export const DEFAULT_LANGUAGE: Language = "en";

type Vars = Record<string, string | number>;

const interpolate = (template: string, vars?: Vars): string =>
  vars
    ? template.replace(/\{(\w+)\}/g, (whole, key: string) =>
        key in vars ? String(vars[key]) : whole,
      )
    : template;

/**
 * One translator closed over a specific language's dictionary, falling back
 * to English for anything that dictionary is missing — a partial translation
 * degrades to English text rather than a blank or a raw key.
 */
function makeTranslator(dict: Dict, fallback: Dict) {
  return (key: string, vars?: Vars): string => {
    const template = dict[key] ?? fallback[key];
    // A key missing from *both* is a typo, not a translation gap — surfaced
    // in the UI rather than silently swallowed, so it gets noticed.
    return template === undefined ? `⟨${key}⟩` : interpolate(template, vars);
  };
}

const LanguageContext = createContext<Language>(DEFAULT_LANGUAGE);

/** Mounted once at the app root, driven by `Settings.ui_language`. */
export const LanguageProvider = LanguageContext.Provider;

export function useLanguage(): Language {
  return useContext(LanguageContext);
}

/**
 * A translator for a language known up front rather than read from context.
 *
 * `App` is what owns `Settings.ui_language` and renders `LanguageProvider`
 * around everything else, which means context can never tell `App` itself
 * what the current language is — a provider only reaches its children, never
 * the component that renders it. `App` calls this directly with the settings
 * value instead of `useT`, which every descendant uses normally.
 */
export function useTranslator(language: Language) {
  return useMemo(
    () => makeTranslator(DICTIONARIES[language], DICTIONARIES[DEFAULT_LANGUAGE]),
    [language],
  );
}

/**
 * Every user-facing string in the app goes through this rather than being
 * written inline, so a single flip in Settings retranslates the whole UI
 * without any component needing to know a second language exists.
 *
 * Keys are namespaced per source file (`"libraryView.emptyTitle"`) purely so
 * two components can each have a "title" key without colliding once merged
 * into one dictionary — see `dictionaries.ts`.
 */
export function useT() {
  return useTranslator(useLanguage());
}
