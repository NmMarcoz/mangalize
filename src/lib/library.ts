import { invoke } from "@tauri-apps/api/core";

import type { SeriesMatch, Volume } from "@/lib/api";

/**
 * Mirrors of the serde shapes in `mangalize-library` and `mangalize-fetch`.
 * Keep these in step with the Rust definitions; serde uses kebab-case for the
 * enums, and `SeriesId` is a newtype so it crosses the wire as a plain number.
 */

/** Mirrors `mangalize_library::model::Series`. */
export interface Series {
  id: number;
  source: string | null;
  source_id: string | null;
  title: string;
  title_romaji: string | null;
  title_native: string | null;
  author: string;
  artist: string;
  description: string;
  year: number | null;
  status: string | null;
  language: string;
  direction: string;
  site_url: string | null;
  folder: string;
  cover_path: string | null;
  added_at: number;
  synced_at: number | null;
  have_chapters: number;
  known_chapters: number;
  /** What the library can be filtered and grouped by. */
  tags: string[];
  content_rating: string | null;
  /** False for a series recorded only because it was read from its source. */
  shelved: boolean;
}

export interface ChapterStatus {
  number: string;
  title: string | null;
  /** The metadata source's chapter id, when a sync recorded one. */
  source_id: string | null;
  /** The source indexes the chapter but does not host its images. */
  unavailable: boolean;
  /** Zero-based page the reader was last on. */
  last_page: number;
  /** When the chapter was finished. `null` means it was not. */
  read_at: number | null;
  /** When it was last opened, finished or not. What history is built from. */
  opened_at: number | null;
  /** `null` means we know the chapter exists but do not have it. */
  folder: string | null;
  page_count: number;
  source_url: string | null;
  downloaded_at: number | null;
}

export interface VolumeStatus {
  number: string;
  cover_url: string | null;
  cover_path: string | null;
  chapters: ChapterStatus[];
  /** A file this volume was already written to, if it is still there. */
  built: BuiltVolume | null;
}

export interface BuiltVolume {
  path: string;
  /** Unix seconds. */
  built_at: number;
  bytes: number;
}

export interface SyncReport {
  volumes: number;
  chapters_added: number;
  orphaned: number;
}

/** Mirrors `mangalize_core::sieve::Verdict`. */
export type Verdict = "single" | "spread" | "off-size";

/** Mirrors `mangalize_fetch::Candidate`. */
export interface Candidate {
  url: string;
  width: number;
  height: number;
  bytes: number;
  verdict: Verdict;
  selected: boolean;
  error: string | null;
}

export interface Extraction {
  page_url: string;
  candidates: Candidate[];
}

/** Mirrors `harvest::Harvested`. */
export interface Harvested {
  url: string;
  width: number;
  height: number;
}

/** Whether a chapter URL was published by the site or constructed from its pattern. */
export type Found = "linked" | "guessed";

/** Mirrors `mangalize_fetch::BatchItem`. */
export interface BatchItem {
  number: string;
  url: string;
  found: Found;
}

export interface BatchPlan {
  /** The recognised URL shape, e.g. `…/x-chapter-{n}/`. */
  pattern: string | null;
  items: BatchItem[];
  /** Wanted chapters no URL could be found for. */
  unresolved: string[];
}

export interface BatchReport {
  downloaded: string[];
  failed: { number: string; error: string }[];
  cancelled: boolean;
}

/** Progress emitted on the `batch-progress` event. */
export interface BatchProgress {
  chapter: string;
  index: number;
  total: number;
  stage: "reading" | "downloading";
  done: number;
  page_total: number;
}

/** Progress emitted on the `fetch-progress` event. */
export interface FetchProgress {
  stage: "measuring" | "downloading";
  done: number;
  total: number;
}

/* --------------------------------------------------------------- the library */

export const libraryRoot = () => invoke<string>("library_root");

export const setLibraryRoot = (path: string) =>
  invoke<string>("set_library_root", { path });

export const librarySeries = () => invoke<Series[]>("library_series");

/**
 * Add a series, optionally fixing which translation it tracks.
 *
 * The language decides which chapters the library knows about and what an
 * exported EPUB declares, so it is set at add time rather than left to default.
 */
export const libraryAddSeries = (series: SeriesMatch, language: string | null = null) =>
  invoke<Series>("library_add_series", { series, language });

export const librarySyncSeries = (id: number) =>
  invoke<SyncReport>("library_sync_series", { id });

export const libraryRemoveSeries = (id: number, deleteFiles: boolean) =>
  invoke<void>("library_remove_series", { id, deleteFiles });

export const libraryUpdateSeries = (
  id: number,
  fields: Pick<Series, "title" | "author" | "description" | "language" | "direction">,
) => invoke<Series>("library_update_series", { id, ...fields });

export const libraryVolumes = (id: number) =>
  invoke<VolumeStatus[]>("library_volumes", { id });

export const libraryDownloadCovers = (id: number) =>
  invoke<number>("library_download_covers", { id });

export const libraryBuildVolume = (id: number, volume: string) =>
  invoke<Volume>("library_build_volume", { id, volume });

export const libraryDeleteChapter = (id: number, chapter: string) =>
  invoke<ChapterStatus>("library_delete_chapter", { id, chapter });

/* ------------------------------------------------------------- getting pages */

export const extractChapter = (url: string) =>
  invoke<Extraction>("extract_chapter", { url });

export const measureImages = (urls: string[], referer: string | null) =>
  invoke<Candidate[]>("measure_images", { urls, referer });

export const harvestImages = (url: string) =>
  invoke<Harvested[]>("harvest_images", { url });

export const previewImage = (url: string, referer: string | null, max: number) =>
  invoke<ArrayBuffer>("preview_image", { url, referer, max });

export const downloadChapter = (args: {
  id: number;
  chapter: string;
  urls: string[];
  referer: string | null;
  sourceUrl: string | null;
}) => invoke<ChapterStatus>("download_chapter", args);

export const importChapter = (id: number, chapter: string, folder: string) =>
  invoke<ChapterStatus>("import_chapter", { id, chapter, folder });

/** Fetch a chapter's pages straight from the metadata source. */
export const downloadChapterFromSource = (id: number, chapter: string) =>
  invoke<ChapterStatus>("download_chapter_from_source", { id, chapter });

/**
 * Whether a chapter can be fetched without pasting a URL.
 *
 * Needs an id from a sync, and the source has to actually host the images —
 * officially licensed series are indexed but not served.
 */
export const canFetchDirectly = (chapter: ChapterStatus) =>
  chapter.source_id !== null && !chapter.unavailable;

export const planBatch = (url: string, wanted: string[]) =>
  invoke<BatchPlan>("plan_batch", { url, wanted });

export const downloadBatch = (id: number, items: BatchItem[]) =>
  invoke<number>("download_batch", { id, items });

/**
 * Fetch missing chapters straight from the metadata source.
 *
 * The URL batch exists because most sites can only be reached by pasting one
 * and inferring the rest. When the source hosts the images itself there is
 * nothing to infer, so this takes the chapter numbers directly.
 */
export const downloadFromSource = (id: number, chapters: string[]) =>
  invoke<number>("download_from_source", { id, chapters });

/* ------------------------------------------------------------------ helpers */

/** The bucket the backend files chapters no published volume claims under. */
export const UNSORTED = "Unsorted";

export const downloadedCount = (volume: VolumeStatus) =>
  volume.chapters.filter((c) => c.folder !== null).length;

export const missingChapters = (volume: VolumeStatus) =>
  volume.chapters.filter((c) => c.folder === null);

/** True when every chapter of a volume is on disk, so it can be built whole. */
export const isComplete = (volume: VolumeStatus) =>
  volume.chapters.length > 0 && downloadedCount(volume) === volume.chapters.length;

export const volumeLabel = (volume: VolumeStatus) =>
  volume.number === UNSORTED ? UNSORTED : `Volume ${volume.number}`;

/**
 * Collapse a run of chapter numbers into ranges: `1, 2, 3, 7` reads as
 * `1–3, 7`. A volume can be missing a dozen chapters and a bare list of them
 * is much harder to take in at a glance than the shape of the gaps.
 */
export const summariseRuns = (numbers: string[]): string => {
  const parsed = numbers.map((n) => ({ label: n, value: Number(n) }));
  const runs: string[] = [];
  let start = 0;

  for (let i = 0; i <= parsed.length; i += 1) {
    const previous = parsed[i - 1];
    const current = parsed[i];
    const consecutive =
      current &&
      previous &&
      Number.isFinite(current.value) &&
      Number.isFinite(previous.value) &&
      current.value === previous.value + 1;

    if (consecutive) continue;

    if (previous) {
      const first = parsed[start];
      runs.push(
        first.label === previous.label
          ? first.label
          : `${first.label}–${previous.label}`,
      );
    }
    start = i;
  }
  return runs.join(", ");
};

/** Which translations the source has for a series in the library. */
export const libraryLanguages = (id: number) =>
  invoke<string[]>("library_languages", { id });

/** Read a library series in a different translation, re-pulling its layout. */
export const librarySetLanguage = (id: number, language: string) =>
  invoke<SyncReport>("library_set_language", { id, language });

/** Remember where a volume the editor wrote ended up. */
export const recordBuilt = (
  id: number,
  volume: string,
  path: string,
  bytes: number,
): Promise<void> => invoke("library_record_built", { id, volume, path, bytes });

/** Forget a recorded build. The file itself is left alone. */
export const clearBuilt = (id: number, volume: string): Promise<void> =>
  invoke("library_clear_built", { id, volume });
