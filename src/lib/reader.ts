import { invoke } from "@tauri-apps/api/core";

import type { MetaSource } from "@/lib/api";
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
  /** Whether the pages are on disk. False for something that was streamed. */
  downloaded: boolean;
  /** Enough to reopen a streamed chapter without going back through search. */
  source: string | null;
  series_source_id: string | null;
  chapter_source_id: string | null;
}

/**
 * What the reader was asked to open.
 *
 * A library chapter reads from disk and works offline. An online one streams
 * from the source, which is what lets you sample a series before committing a
 * few hundred megabytes to it.
 */
export type ReaderTarget =
  | { kind: "library"; seriesId: number; chapter: string }
  | {
      kind: "online";
      source: MetaSource;
      /** The source's own chapter id. */
      chapterId: string;
      seriesTitle: string;
      chapterNumber: string;
      direction: string;
      previous: { id: string; number: string } | null;
      next: { id: string; number: string } | null;
      /** The source's own id for the series, so a read can be recorded. */
      seriesSourceId: string;
      /** Art for the history entry, fetched once if the series has none. */
      coverUrl: string | null;
      /**
       * The library entry for this series, when one is already known.
       *
       * Only a shortcut: reading always records against a row, and the backend
       * finds or makes one. This saves the round trip when the caller knows.
       */
      librarySeriesId: number | null;
    };

export interface OnlineChapter {
  pages: string[];
  /** The publisher's own page, when the source only indexes this chapter. */
  external_url: string | null;
  /** Ready to show. Null when the pages came back fine. */
  message: string | null;
}

export const readerOnlineChapter = (source: MetaSource, chapterId: string) =>
  invoke<OnlineChapter>("reader_online_chapter", { source, chapterId });

/**
 * Record that a series is being read from its source, and get the row to save
 * progress against.
 *
 * The series is recorded but not shelved: history and resuming work the same
 * whatever the source, while the library stays what the user chose to add.
 */
export const readerTrackOnline = (args: {
  source: MetaSource;
  seriesSourceId: string;
  title: string;
  coverUrl: string | null;
  chapter: string;
  chapterSourceId: string;
  pages: number;
}) => invoke<number>("reader_track_online", { read: args });

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

const split = (key: string) => [
  key.slice(0, key.indexOf("|")),
  key.slice(key.indexOf("|") + 1),
];

const localPages = createImageCache((key) => {
  const [max, path] = split(key);
  return invoke<ArrayBuffer>("reader_page", { path, max: Number(max) });
});

const remotePages = createImageCache((key) => {
  const [max, url] = split(key);
  return invoke<ArrayBuffer>("reader_remote_page", { url, max: Number(max) });
});

const key = (source: string, max: number) => `${max}|${source}`;

/**
 * One entry point for both sources, so the reader never branches on where a
 * page came from — only on where to ask for it.
 */
export const cachedPage = (source: string, online: boolean, max = READING_MAX) =>
  (online ? remotePages : localPages).peek(key(source, max));

export const loadPage = (source: string, online: boolean, max = READING_MAX) =>
  (online ? remotePages : localPages).load(key(source, max));

/** Drop decoded pages. Called when leaving the reader, which frees real memory. */
export const clearPages = () => {
  localPages.clear();
  remotePages.clear();
};

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
