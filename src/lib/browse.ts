import { invoke } from "@tauri-apps/api/core";

import type { SeriesMatch } from "@/lib/api";

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

export interface Tag {
  id: string;
  name: string;
  /** `genre`, `theme`, `format` or `content`. */
  group: string;
}

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
export const SORTS: { value: Sort; descending: boolean; label: string }[] = [
  { value: "follows", descending: true, label: "Most follows" },
  { value: "follows", descending: false, label: "Fewest follows" },
  { value: "rating", descending: true, label: "Highest rated" },
  { value: "rating", descending: false, label: "Lowest rated" },
  { value: "latest-upload", descending: true, label: "Recently updated" },
  { value: "latest-upload", descending: false, label: "Longest untouched" },
  { value: "recently-added", descending: true, label: "Newest to the catalogue" },
  { value: "recently-added", descending: false, label: "Oldest in the catalogue" },
  { value: "title", descending: false, label: "Title A–Z" },
  { value: "title", descending: true, label: "Title Z–A" },
];

/** A stable key for a sort option, since value alone is not unique. */
export const sortKey = (sort: Sort, descending: boolean) =>
  `${sort}:${descending ? "desc" : "asc"}`;

export const RATINGS: { value: ContentRating; label: string }[] = [
  { value: "safe", label: "Safe" },
  { value: "suggestive", label: "Suggestive" },
  { value: "erotica", label: "Erotica" },
  { value: "pornographic", label: "Explicit" },
];

export const STATUSES = ["ongoing", "completed", "hiatus", "cancelled"] as const;

export const DEMOGRAPHICS = ["shounen", "shoujo", "seinen", "josei"] as const;

/** Readable names for the tag groups MangaDex uses. */
export const TAG_GROUPS: Record<string, string> = {
  genre: "Genre",
  theme: "Theme",
  format: "Format",
  content: "Content",
};

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
