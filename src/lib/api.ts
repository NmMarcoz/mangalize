import { invoke } from "@tauri-apps/api/core";

/**
 * Mirrors of the serde shapes in `mangalize-core`. Keep these in step with the
 * Rust definitions; serde uses kebab-case for the enums.
 */
export type Direction = "right-to-left" | "left-to-right";
export type PageKind = "single" | "spread";
export type Format = "epub" | "cbz";

export type ExcludeReason =
  | { reason: "not-a-page" }
  | { reason: "unreadable" }
  | { reason: "off-size"; width: number; height: number }
  | { reason: "manual" };

export interface Page {
  path: string;
  width: number;
  height: number;
  bytes: number;
  kind: PageKind;
  excluded: ExcludeReason | null;
  split: boolean;
}

export interface Chapter {
  title: string;
  source: string;
  pages: Page[];
}

export interface Metadata {
  series: string;
  volume: number | null;
  author: string;
  language: string;
  description: string;
  direction: Direction;
  identifier: string;
}

export interface Volume {
  metadata: Metadata;
  cover: string | null;
  chapters: Chapter[];
  root: string;
}

export interface BuildReport {
  path: string;
  bytes: number;
  pages: number;
}

/* ---------------------------------------------------- online metadata lookup */

export type MetaSource = "mangadex" | "kitsu";

/** Mirrors `mangalize_meta::SeriesMatch`. */
export interface SeriesMatch {
  source: MetaSource;
  id: string;
  title_english: string | null;
  title_romaji: string | null;
  title_native: string | null;
  author: string | null;
  artist: string | null;
  description: string | null;
  year: number | null;
  status: string | null;
  demographic: string | null;
  thumbnail_url: string | null;
  site_url: string | null;
}

export interface VolumeCover {
  volume: string | null;
  url: string;
  thumbnail_url: string;
}

export interface VolumeChapters {
  volume: string;
  chapters: string[];
}

export const searchSeries = (query: string) =>
  invoke<SeriesMatch[]>("search_series", { query });

export const seriesCovers = (source: MetaSource, id: string) =>
  invoke<VolumeCover[]>("series_covers", { source, id });

export const seriesChapters = (source: MetaSource, id: string) =>
  invoke<VolumeChapters[]>("series_chapters", { source, id });

/** Download a cover into the app cache and return its local path. */
export const saveCover = (url: string) => invoke<string>("save_cover", { url });

export const sourceLabel = (source: MetaSource) =>
  source === "mangadex" ? "MangaDex" : "Kitsu";

export const scanFolder = (path: string) => invoke<Volume>("scan", { path });

export const buildVolume = (volume: Volume, out: string, format: Format) =>
  invoke<BuildReport>("build", { volume, out, format });

export const suggestFilename = (volume: Volume, format: Format) =>
  invoke<string>("suggest_filename", { volume, format });

export const fetchThumbnail = (path: string, max: number) =>
  invoke<ArrayBuffer>("thumbnail", { path, max });

/** Pages that will actually be written. */
export const includedPages = (chapter: Chapter) =>
  chapter.pages.filter((p) => p.excluded === null);

export const volumePageCount = (volume: Volume) =>
  volume.chapters.reduce((n, c) => n + includedPages(c).length, 0);

export const volumeSpreadCount = (volume: Volume) =>
  volume.chapters.reduce(
    (n, c) => n + includedPages(c).filter((p) => p.kind === "spread").length,
    0,
  );

/** The cover actually used: the explicit pick, else the first page. */
export const effectiveCover = (volume: Volume): string | null => {
  if (volume.cover) return volume.cover;
  for (const chapter of volume.chapters) {
    const first = includedPages(chapter)[0];
    if (first) return first.path;
  }
  return null;
};

export const excludeLabel = (reason: ExcludeReason): string => {
  switch (reason.reason) {
    case "off-size":
      return `Off-size ${reason.width}×${reason.height}`;
    case "unreadable":
      return "Unreadable";
    case "not-a-page":
      return "Not a page";
    case "manual":
      return "Excluded";
  }
};

export const fileName = (path: string) => path.split(/[/\\]/).pop() ?? path;

/**
 * Make sure a user-typed export name carries the extension for the format.
 *
 * Typing "Ichi the Witch v01" and getting a file with no extension is a real
 * way to end up with something a Kindle refuses to open, so the extension is
 * added when it is missing rather than assumed.
 */
export const withExtension = (name: string, format: Format) => {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.toLowerCase().endsWith(`.${format}`)
    ? trimmed
    : `${trimmed}.${format}`;
};

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
};
