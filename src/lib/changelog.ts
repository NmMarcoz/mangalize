/**
 * What's shown in the "what's new" panel, newest first.
 *
 * One entry per release. `version` must match what actually gets tagged —
 * keep it in sync when cutting the release, since nothing checks it against
 * `tauri.conf.json` automatically. Never delete old entries: a user updating
 * across several releases at once is shown every entry newer than the last
 * one they saw, not just the latest.
 */
export interface ChangelogEntry {
  version: string;
  highlights: string[];
}

/** Numeric, dot-separated comparison — `"1.2.0"` sorts before `"1.10.0"`,
 * unlike a plain string compare. */
function compareVersions(a: string, b: string): number {
  const as = a.split(".").map(Number);
  const bs = b.split(".").map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Entries newer than `lastSeen`, newest first.
 *
 * `lastSeen === null` covers both a fresh install and one updating from
 * before this existed; the caller tells them apart (only a fresh install
 * skips showing anything at all, via `welcomed`), so this alone just
 * returns the single latest entry for that case rather than the whole
 * history — a first look at the changelog should not read as a backlog.
 */
export function unseenChangelog(lastSeen: string | null): ChangelogEntry[] {
  if (lastSeen === null) return CHANGELOG.slice(0, 1);
  return CHANGELOG.filter((entry) => compareVersions(entry.version, lastSeen) > 0);
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.12.0",
    highlights: [
      "Write a .lua extension for any manga site — browse, add, download and read straight from it, no code changes needed.",
      "Explore can now browse a registered source's own catalogue, not just MangaDex.",
      "A series' title, credits, description, tags and cover are backfilled automatically from MangaDex, Kitsu, AniList and MyAnimeList when a source's own listing is missing something, and can be refetched any time from the series page.",
      "Chapters a source couldn't sort into a volume can now be organized by hand, protected from being undone the next time the series syncs.",
      "Fixed covers not showing when a source's art wasn't a JPEG.",
    ],
  },
];
