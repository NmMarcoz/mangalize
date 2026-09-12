import { invoke } from "@tauri-apps/api/core";

import { createImageCache } from "@/lib/imagecache";
import type { ChapterStatus } from "@/lib/library";

/** Mirrors `reader::ReaderChapter`. */
export interface ReaderChapter {
  series_id: number;
  series_title: string;
  number: string;
  title: string | null;
  /** `right-to-left` | `left-to-right` */
  direction: string;
  /** Absolute page paths, in reading order. */
  pages: string[];
  /** Zero-based page to open on. */
  last_page: number;
  previous: string | null;
  next: string | null;
}

/** Mirrors `mangalize_library::model::HistoryEntry`. */
export interface HistoryEntry {
  series_id: number;
  series_title: string;
  cover_path: string | null;
  chapter: string;
  last_page: number;
  page_count: number;
  opened_at: number;
  finished: boolean;
}

export const readerChapter = (id: number, chapter: string) =>
  invoke<ReaderChapter>("reader_chapter", { id, chapter });

export const saveReadingProgress = (
  id: number,
  chapter: string,
  page: number,
  finished: boolean,
) => invoke<void>("save_reading_progress", { id, chapter, page, finished });

export const clearReadingProgress = (id: number, chapter: string) =>
  invoke<void>("clear_reading_progress", { id, chapter });

export const readingHistory = (limit: number) =>
  invoke<HistoryEntry[]>("reading_history", { limit });

export const resumePoint = (id: number) =>
  invoke<ChapterStatus | null>("resume_point", { id });

/* ------------------------------------------------------------- page loading */

/**
 * How large a page is decoded for reading.
 *
 * Generous rather than exact: the reader lets you zoom, and a page rendered at
 * the window's width looks soft the moment you do. Bounded all the same,
 * because a 4000px scan costs real time to decode on every chapter.
 */
export const READING_MAX = 2400;

const pages = createImageCache((key) => {
  const [max, path] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
  return invoke<ArrayBuffer>("reader_page", { path, max: Number(max) });
});

const key = (path: string, max: number) => `${max}|${path}`;

export const cachedPage = (path: string, max = READING_MAX) =>
  pages.peek(key(path, max));

export const loadPage = (path: string, max = READING_MAX) =>
  pages.load(key(path, max));

/** Drop decoded pages. Called when leaving the reader, which frees real memory. */
export const clearPages = () => pages.clear();

/* --------------------------------------------------------------- reader modes */

export type ReaderMode = "paged" | "double" | "webtoon";
export type FitMode = "width" | "height" | "contain" | "original";

export const MODES: { value: ReaderMode; label: string; detail: string }[] = [
  {
    value: "paged",
    label: "Single page",
    detail: "One page at a time. What most manga is drawn for.",
  },
  {
    value: "double",
    label: "Two pages",
    detail: "A facing pair, as a printed book falls open. Wide screens only.",
  },
  {
    value: "webtoon",
    label: "Continuous",
    detail: "Scrolls without page breaks. What webtoons are drawn for.",
  },
];

export const FITS: { value: FitMode; label: string }[] = [
  { value: "contain", label: "Fit page" },
  { value: "width", label: "Fit width" },
  { value: "height", label: "Fit height" },
  { value: "original", label: "Original size" },
];

/** Reader preferences, kept client-side: they are chrome, not library data. */
export interface ReaderPrefs {
  mode: ReaderMode;
  fit: FitMode;
  /** Overrides the series' own direction when set. */
  direction: string | null;
  /** Dark surround is easier on the eyes and standard for comic readers. */
  background: "black" | "grey" | "white";
}

const PREFS_KEY = "mangalize:reader-prefs";

export const defaultPrefs = (): ReaderPrefs => ({
  mode: "paged",
  fit: "contain",
  direction: null,
  background: "black",
});

export function loadPrefs(): ReaderPrefs {
  try {
    const stored = localStorage.getItem(PREFS_KEY);
    // Merged over the defaults so a preference added later does not arrive
    // undefined for anyone who already has a stored copy.
    return stored ? { ...defaultPrefs(), ...JSON.parse(stored) } : defaultPrefs();
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(prefs: ReaderPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
