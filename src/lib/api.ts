import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { canRevealFiles } from "@/lib/platform";

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

/**
 * Mirrors `mangalize_meta::Tag`.
 *
 * Defined here rather than beside the browse filters because a series carries
 * its own tags; putting it there and importing back would be circular.
 */
export interface Tag {
  id: string;
  name: string;
  /** `genre`, `theme`, `format` or `content`. */
  group: string;
}

/** Mirrors `mangalize_meta::Statistics`. */
export interface Statistics {
  rating: number | null;
  bayesian: number | null;
  follows: number | null;
}

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
  /** `safe` | `suggestive` | `erotica` | `pornographic` */
  content_rating: string | null;
  tags: Tag[];
  /** Translations that exist, as language codes. Crowd-sourced, so it varies. */
  available_languages: string[];
}

export interface VolumeCover {
  volume: string | null;
  url: string;
  thumbnail_url: string;
}

/** Mirrors `mangalize_meta::ChapterRef`. */
export interface ChapterRef {
  number: string;
  /** The source's own id; present means its pages can be fetched directly. */
  id: string | null;
  /** The source lists the chapter but cannot serve its images. */
  unavailable: boolean;
}

export interface VolumeChapters {
  volume: string;
  chapters: ChapterRef[];
}

export const searchSeries = (query: string) =>
  invoke<SeriesMatch[]>("search_series", { query });

export const seriesCovers = (source: MetaSource, id: string) =>
  invoke<VolumeCover[]>("series_covers", { source, id });

export const seriesChapters = (source: MetaSource, id: string) =>
  invoke<VolumeChapters[]>("series_chapters", { source, id });

/** The volume layout for one translation. `null` merges every language. */
export const seriesChaptersIn = (
  source: MetaSource,
  id: string,
  language: string | null,
) => invoke<VolumeChapters[]>("series_chapters_in", { source, id, language });

export const seriesStatistics = (source: MetaSource, id: string) =>
  invoke<Statistics>("series_statistics", { source, id });

/** Series sharing these tags. A tag search, not a recommendation. */
export const similarSeries = (source: MetaSource, tags: string[], exclude: string) =>
  invoke<SeriesMatch[]>("similar_series", { source, tags, exclude });

/**
 * Language codes as they should read on screen.
 *
 * MangaDex uses a mix of plain and regioned codes, and `Intl.DisplayNames`
 * handles both; the map only covers the few it renders unhelpfully.
 */
export const languageName = (code: string): string => {
  const special: Record<string, string> = {
    "pt-br": "Portuguese (Brazil)",
    "es-la": "Spanish (Latin America)",
    "zh-hk": "Chinese (Hong Kong)",
    "ja-ro": "Japanese (romanised)",
    "ko-ro": "Korean (romanised)",
    "zh-ro": "Chinese (romanised)",
  };
  if (special[code]) return special[code];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

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

/**
 * Hand a built volume to the user, by whatever that means on this platform.
 *
 * A desktop reveals it in the file manager. Android has no file manager to
 * reveal into, and the export folder sits under `Android/data`, which recent
 * versions hide from the pickers most apps show — so the share sheet is the way
 * a volume actually leaves the device, and the user chooses where it goes.
 */
export async function deliverBuilt(path: string, title?: string): Promise<void> {
  if (canRevealFiles) {
    await revealItemInDir(path);
    return;
  }
  await invoke("share_file", { path, title: title ?? null });
}

/** What the control doing the above should be called. */
export const DELIVER_LABEL = canRevealFiles ? "Show" : "Share";
