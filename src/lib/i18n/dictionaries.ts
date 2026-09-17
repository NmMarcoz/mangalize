import type { Dict, Language, PartialDictionary } from "@/lib/i18n/types";

/**
 * Every file under `dict/` contributes its own namespaced slice of strings,
 * picked up automatically rather than imported by hand here — adding a new
 * component's translations never means editing this file, which is what
 * lets several of them be written at once without touching the same line.
 */
const modules = import.meta.glob<{ default: PartialDictionary }>("./dict/*.ts", {
  eager: true,
});

function merge(language: Language): Dict {
  const merged: Dict = {};
  for (const path in modules) {
    const partial = modules[path].default[language];
    for (const key in partial) {
      if (key in merged) {
        // A collision means two files picked the same namespaced key, which
        // should not be possible if each is prefixed with its own component
        // name — worth knowing about immediately rather than one silently
        // shadowing the other.
        console.warn(`i18n: duplicate key "${key}" (last one wins, from ${path})`);
      }
    }
    Object.assign(merged, partial);
  }
  return merged;
}

export const DICTIONARIES: Record<Language, Dict> = {
  en: merge("en"),
  "pt-BR": merge("pt-BR"),
};
