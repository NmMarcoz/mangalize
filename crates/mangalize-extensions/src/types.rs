//! The shapes every [`crate::Source`] speaks in, regardless of what backs it.
//!
//! `VolumeChapters`/`ChapterRef`/`VolumeCover` are reused directly from
//! `mangalize-meta` rather than redeclared here: none of the three carries a
//! `Source` enum field, so nothing about them is MangaDex-specific, and
//! `pull_layout` in the Tauri layer can keep consuming exactly what it does
//! today. `SeriesMatch` is not reused the same way — it carries
//! `mangalize_meta::Source`, which a Lua-backed extension has no variant for —
//! so a source-agnostic `MangaSummary`/`MangaDetails` pair lives here instead.

pub use mangalize_meta::{ChapterRef, VolumeChapters, VolumeCover};

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// What a source is, for listing in an Extensions screen and for namespacing
/// `mangalize-library`'s `series.source` column.
///
/// `Serialize`/`Deserialize` (unlike `Source` itself, which cannot cross a
/// thread boundary let alone IPC): this crosses into the Tauri frontend for
/// an Add-from-source picker exactly like `mangalize_meta::SeriesMatch` does.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceInfo {
    /// Stable and namespaced, e.g. `"mangalize.mangadex"` or `"user.some-site"`.
    /// This is the exact string stored in `series.source` — that column is
    /// already free text, added for this reason.
    pub id: String,
    pub name: String,
    /// ISO 639-1, or `"multi"` for a source that carries many languages itself
    /// (MangaDex, being crowd-translated, is the obvious example).
    pub lang: String,
    pub base_url: String,
}

/// One row in a popular/latest/search results page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MangaSummary {
    pub id: String,
    pub title: String,
    pub cover_url: Option<String>,
}

/// A page of catalogue browsing.
///
/// `has_next_page` rather than a total count: Tachiyomi sources report exactly
/// this, because plenty of sites can say "there is another page" without ever
/// being able to say how many entries exist in total.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MangasPage {
    pub manga: Vec<MangaSummary>,
    pub has_next_page: bool,
}

/// Everything about one series a source can offer beyond its summary row.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MangaDetails {
    pub title: String,
    pub title_romaji: Option<String>,
    pub title_native: Option<String>,
    pub author: Option<String>,
    pub artist: Option<String>,
    pub description: Option<String>,
    /// Already named, not left as ids — a source knows its own tag names.
    pub tags: Vec<String>,
    pub content_rating: Option<String>,
    /// Languages this series has been translated into, when the source tracks
    /// per-series translations at all (most single-language sites won't).
    pub available_languages: Vec<String>,
    pub cover_url: Option<String>,
}

impl MangaDetails {
    /// Best-effort series metadata: `source.manga_details(id)` first, then
    /// whatever it left blank — or, if the call failed outright, everything —
    /// is filled in by asking, in order, MangaDex (falling back to Kitsu),
    /// AniList, and Jikan (an unofficial MyAnimeList API). Each is tried in
    /// turn regardless of whether an earlier one answered, so a title only
    /// AniList carries a cover for still gets it even after MangaDex supplied
    /// the description.
    ///
    /// A scraped site's markup is far more likely to break than any of the
    /// three metadata databases, and this is what lets adding a series
    /// survive that instead of failing outright. Never overrides a field the
    /// source *did* supply: its own page is the more specific answer when it
    /// has one. `fallback_title` — the title already on hand from whichever
    /// catalogue listing this series was picked from — is the search query
    /// when the source's own call didn't get far enough to supply one itself.
    pub fn best_effort(source: &dyn Source, external_id: &str, fallback_title: &str) -> Self {
        let mut details = source.manga_details(external_id).unwrap_or_else(|_| MangaDetails {
            title: fallback_title.to_string(),
            ..Default::default()
        });
        if details.title.is_empty() {
            details.title = fallback_title.to_string();
        }
        let query = details.title.clone();
        details.fill_from_metadata_search(&query);
        details
    }

    /// The MangaDex-then-Kitsu, then AniList, then Jikan chain alone, with no
    /// source page of its own to try first — what a series already backed by
    /// MangaDex or Kitsu refetches from, and what `best_effort` layers a
    /// source's own page on top of. Each tier is tried regardless of whether
    /// an earlier one answered, so a title only AniList carries a cover for
    /// still gets it even after MangaDex supplied the description.
    pub fn fill_from_metadata_search(&mut self, query: &str) {
        let hints = [
            mangalize_meta::search(query, 1)
                .ok()
                .and_then(|mut hits| hits.drain(..).next())
                .map(mangalize_meta::MetadataHint::from),
            mangalize_meta::anilist::search(query).ok().flatten(),
            mangalize_meta::jikan::search(query).ok().flatten(),
        ];
        for hint in hints.into_iter().flatten() {
            self.fill_from_hint(hint);
        }
    }

    fn fill_from_hint(&mut self, hint: mangalize_meta::MetadataHint) {
        if self.title_romaji.is_none() {
            self.title_romaji = hint.title_romaji;
        }
        if self.title_native.is_none() {
            self.title_native = hint.title_native;
        }
        if self.author.is_none() {
            self.author = hint.author;
        }
        if self.artist.is_none() {
            self.artist = hint.artist;
        }
        if self.description.is_none() {
            self.description = hint.description;
        }
        if self.content_rating.is_none() {
            self.content_rating = hint.content_rating;
        }
        if self.tags.is_empty() {
            self.tags = hint.tags;
        }
        if self.cover_url.is_none() {
            self.cover_url = hint.cover_url;
        }
    }
}

/// One manga source: a catalogue to browse and a way to read what's in it.
///
/// Method names and shapes mirror Tachiyomi's own `CatalogueSource`/
/// `HttpSource` on purpose — porting a Keiyoushi extension into this trait
/// later is meant to be a mechanical translation, not a redesign.
pub trait Source: Send + Sync {
    fn info(&self) -> &SourceInfo;

    fn popular(&self, page: u32) -> Result<MangasPage>;
    fn latest(&self, page: u32) -> Result<MangasPage>;
    fn search(&self, query: &str, page: u32) -> Result<MangasPage>;

    fn manga_details(&self, id: &str) -> Result<MangaDetails>;

    /// The published volume-to-chapter map, in one translation when the
    /// source has more than one, else `language` is ignored.
    fn volumes(&self, id: &str, language: Option<&str>) -> Result<Vec<VolumeChapters>>;

    /// Per-volume cover art, when the source publishes any.
    fn covers(&self, id: &str) -> Result<Vec<VolumeCover>>;

    /// Image URLs for one chapter, in reading order.
    fn page_list(&self, chapter_id: &str) -> Result<Vec<String>>;
}
