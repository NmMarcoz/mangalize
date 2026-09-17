import { invoke } from "@tauri-apps/api/core";

import type { SeriesMatch, Tag } from "@/lib/api";
import type { Translator } from "@/lib/i18n/types";

/** Mirrors `mangalize_meta::Sort`. */
export type Sort =
  | "latest-upload"
  | "follows"
  | "rating"
  | "recently-added"
  | "title"
  | "relevance";

/** Mirrors `mangalize_meta::ContentRating`. */
export type ContentRating = "safe" | "suggestive" | "erotica" | "pornographic";

// `Tag` lives in api.ts, since a series carries its own; re-exported here so
// the filter code reads as one thing.
export type { Tag };

export interface BrowseQuery {
  title: string | null;
  sort: Sort;
  descending: boolean;
  included_tags: string[];
  excluded_tags: string[];
  content_ratings: ContentRating[];
  status: string[];
  demographic: string[];
  limit: number;
  offset: number;
}

export interface BrowsePage {
  series: SeriesMatch[];
  total: number;
  offset: number;
}

export const browseSeries = (query: BrowseQuery) =>
  invoke<BrowsePage>("browse_series", { query });

export const mangadexTags = () => invoke<Tag[]>("mangadex_tags");

/** How many results to pull per page. */
export const PAGE_SIZE = 32;

/**
 * Both directions of each ordering, because "least followed" is as valid a
 * thing to ask for as "most", and inverting is free.
 */
/** A function of `t`, not a static array — see `compressionPresets` in
 * `lib/settings.ts` for why. */
export const sorts = (t: Translator): { value: Sort; descending: boolean; label: string }[] => [
  { value: "follows", descending: true, label: t("browse.sortMostFollows") },
  { value: "follows", descending: false, label: t("browse.sortFewestFollows") },
  { value: "rating", descending: true, label: t("browse.sortHighestRated") },
  { value: "rating", descending: false, label: t("browse.sortLowestRated") },
  { value: "latest-upload", descending: true, label: t("browse.sortRecentlyUpdated") },
  { value: "latest-upload", descending: false, label: t("browse.sortLongestUntouched") },
  { value: "recently-added", descending: true, label: t("browse.sortNewestToCatalogue") },
  { value: "recently-added", descending: false, label: t("browse.sortOldestInCatalogue") },
  { value: "title", descending: false, label: t("browse.sortTitleAZ") },
  { value: "title", descending: true, label: t("browse.sortTitleZA") },
];

/** A stable key for a sort option, since value alone is not unique. */
export const sortKey = (sort: Sort, descending: boolean) =>
  `${sort}:${descending ? "desc" : "asc"}`;

export const ratings = (t: Translator): { value: ContentRating; label: string }[] => [
  { value: "safe", label: t("browse.ratingSafe") },
  { value: "suggestive", label: t("browse.ratingSuggestive") },
  { value: "erotica", label: t("browse.ratingErotica") },
  { value: "pornographic", label: t("browse.ratingExplicit") },
];

export const STATUSES = ["ongoing", "completed", "hiatus", "cancelled"] as const;

export const DEMOGRAPHICS = ["shounen", "shoujo", "seinen", "josei"] as const;

/** Readable names for the tag groups MangaDex uses, as a function of `t`. */
export const tagGroups = (t: Translator): Record<string, string> => ({
  genre: t("browse.tagGroupGenre"),
  theme: t("browse.tagGroupTheme"),
  format: t("browse.tagGroupFormat"),
  content: t("browse.tagGroupContent"),
});

export const defaultQuery = (): BrowseQuery => ({
  title: null,
  sort: "follows",
  descending: true,
  included_tags: [],
  excluded_tags: [],
  // Deliberately narrower than the API's own default, which includes erotica.
  content_ratings: ["safe", "suggestive"],
  status: [],
  demographic: [],
  limit: PAGE_SIZE,
  offset: 0,
});

/** Whether anything has been narrowed beyond the opening view. */
export const isFiltered = (query: BrowseQuery) =>
  query.included_tags.length > 0 ||
  query.excluded_tags.length > 0 ||
  query.status.length > 0 ||
  query.demographic.length > 0 ||
  (query.title ?? "").trim() !== "";
