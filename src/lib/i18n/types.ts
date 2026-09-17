/** Every UI language this build ships strings for. */
export type Language = "en" | "pt-BR";

export type Dict = Record<string, string>;

/** What one source file contributes to the merged dictionaries — see
 * `dictionaries.ts`, which globs every module under `dict/` for this shape. */
export interface PartialDictionary {
  en: Dict;
  "pt-BR": Dict;
}

/**
 * The shape `useT()`/`useTranslator()` return. A lib file that builds a list
 * of labels (`compressionPresets`, `readerModes`, …) takes one of these as a
 * plain parameter instead of calling the hook itself, since a hook can only
 * be called from a component or another hook.
 */
export type Translator = (key: string, vars?: Record<string, string | number>) => string;
