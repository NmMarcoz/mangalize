//! Series metadata lookup against public manga databases.
//!
//! This is the only part of Mangalize that touches the network, and it is always
//! user-initiated: scanning and exporting stay entirely offline.
//!
//! [MangaDex] is the primary source because it is the only free, key-less API
//! that publishes *per-volume* cover art and a volume-to-chapter map, which is
//! what this app actually needs. [Kitsu] is the fallback for when MangaDex is
//! unreachable. AniList would otherwise be the obvious choice, but its public
//! API has been disabled by its operators.
//!
//! [MangaDex]: https://api.mangadex.org/docs/
//! [Kitsu]: https://kitsu.docs.apiary.io/

pub mod kitsu;
pub mod mangadex;

use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// MangaDex asks API consumers to identify themselves.
const USER_AGENT: &str = concat!("mangalize/", env!("CARGO_PKG_VERSION"));

const TIMEOUT: Duration = Duration::from_secs(20);

/// Where a result came from, so the UI can say so and so covers can be fetched
/// from the right place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    MangaDex,
    Kitsu,
}

/// A candidate series returned by a search.
///
/// Titles are kept separate rather than collapsed to one string: which one
/// belongs in a Kindle library is the user's call, not ours.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesMatch {
    pub source: Source,
    pub id: String,
    pub title_english: Option<String>,
    pub title_romaji: Option<String>,
    pub title_native: Option<String>,
    pub author: Option<String>,
    pub artist: Option<String>,
    pub description: Option<String>,
    pub year: Option<u32>,
    pub status: Option<String>,
    pub demographic: Option<String>,
    /// Small cover for the picker, not for embedding.
    pub thumbnail_url: Option<String>,
    pub site_url: Option<String>,
}

impl SeriesMatch {
    /// The title to show in a list, preferring the most readable form.
    pub fn display_title(&self) -> &str {
        self.title_english
            .as_deref()
            .or(self.title_romaji.as_deref())
            .or(self.title_native.as_deref())
            .unwrap_or("Untitled")
    }
}

/// One volume's cover art.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeCover {
    /// Volume number as published, e.g. `"1"`. `None` for untagged art.
    pub volume: Option<String>,
    /// Full resolution, for embedding in the book.
    pub url: String,
    /// Downscaled, for the picker.
    pub thumbnail_url: String,
}

/// How to order a browse.
///
/// Every one can run either way, which is what turns "most followed" into
/// "least followed" without a second list of options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Sort {
    /// Something new to read: whatever was uploaded to most recently.
    LatestUpload,
    /// What most people are reading.
    Follows,
    Rating,
    /// Newest entries in the catalogue, which is not the same as newest chapters.
    RecentlyAdded,
    Title,
    /// Only meaningful alongside a title query.
    Relevance,
}

impl Sort {
    /// The API's parameter name for this ordering.
    fn key(self) -> &'static str {
        match self {
            Sort::LatestUpload => "latestUploadedChapter",
            Sort::Follows => "followedCount",
            Sort::Rating => "rating",
            Sort::RecentlyAdded => "createdAt",
            Sort::Title => "title",
            Sort::Relevance => "relevance",
        }
    }
}

/// How explicit a series is allowed to be.
///
/// MangaDex's own default omits `Pornographic`; this app is narrower still and
/// starts at the first two, because a browse with no query is the first thing
/// the panel shows and should not open on anything unasked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContentRating {
    Safe,
    Suggestive,
    Erotica,
    Pornographic,
}

impl ContentRating {
    fn key(self) -> &'static str {
        match self {
            ContentRating::Safe => "safe",
            ContentRating::Suggestive => "suggestive",
            ContentRating::Erotica => "erotica",
            ContentRating::Pornographic => "pornographic",
        }
    }

    /// What a fresh install browses with.
    pub fn default_set() -> Vec<Self> {
        vec![ContentRating::Safe, ContentRating::Suggestive]
    }
}

/// A tag a series can be filed under.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    /// `genre`, `theme`, `format` or `content`.
    pub group: String,
}

/// What to browse for. Every field is optional; the default is a plain catalogue
/// listing, which is the point — exploring should not require a search term.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowseQuery {
    /// Free text. Switches the default ordering to relevance when set.
    pub title: Option<String>,
    pub sort: Sort,
    pub descending: bool,
    pub included_tags: Vec<String>,
    pub excluded_tags: Vec<String>,
    pub content_ratings: Vec<ContentRating>,
    /// `ongoing`, `completed`, `hiatus`, `cancelled`.
    pub status: Vec<String>,
    /// `shounen`, `shoujo`, `josei`, `seinen`.
    pub demographic: Vec<String>,
    pub limit: u32,
    pub offset: u32,
}

impl Default for BrowseQuery {
    fn default() -> Self {
        Self {
            title: None,
            sort: Sort::Follows,
            descending: true,
            included_tags: Vec::new(),
            excluded_tags: Vec::new(),
            content_ratings: ContentRating::default_set(),
            status: Vec::new(),
            demographic: Vec::new(),
            limit: 32,
            offset: 0,
        }
    }
}

/// One page of browse results.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowsePage {
    pub series: Vec<SeriesMatch>,
    /// How many match the query in total, for paging.
    pub total: u32,
    pub offset: u32,
}

/// One chapter as the source knows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterRef {
    /// Chapter number as published, e.g. `"7"` or `"7.5"`.
    pub number: String,
    /// The source's own identifier, which is what fetching pages needs.
    pub id: Option<String>,
    /// The source lists this chapter but cannot serve its images.
    ///
    /// True for officially licensed series: MangaDex indexes them so the volume
    /// layout is complete, but the pages live on the publisher's own reader and
    /// are not theirs to hand out.
    pub unavailable: bool,
}

/// Which chapters a published volume contains.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeChapters {
    pub volume: String,
    pub chapters: Vec<ChapterRef>,
}

/// Search for a series, falling back to Kitsu if MangaDex is unavailable.
///
/// A MangaDex failure is not surfaced when Kitsu succeeds; the user only cares
/// that they got results.
pub fn search(query: &str, limit: u32) -> Result<Vec<SeriesMatch>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    match mangadex::search(query, limit) {
        Ok(hits) if !hits.is_empty() => Ok(hits),
        primary => match kitsu::search(query, limit) {
            Ok(hits) => Ok(hits),
            Err(fallback_err) => match primary {
                // Both failed: report the primary error, it is the more useful one.
                Err(e) => Err(e),
                Ok(_) => Err(fallback_err),
            },
        },
    }
}

/// Every volume cover for a series. Only MangaDex publishes these per volume;
/// Kitsu has a single series poster, returned as one untagged entry.
pub fn volume_covers(source: Source, id: &str) -> Result<Vec<VolumeCover>> {
    match source {
        Source::MangaDex => mangadex::volume_covers(id),
        Source::Kitsu => kitsu::poster(id).map(|c| c.into_iter().collect()),
    }
}

/// Report a page fetch back to the network that served it.
///
/// See [`mangadex::report_at_home`]. A no-op for anything not served by
/// MangaDex@Home.
pub fn report_page_fetch(url: &str, success: bool, cached: bool, bytes: usize, millis: u64) {
    mangadex::report_at_home(url, success, cached, bytes, millis);
}

/// Browse the catalogue, with or without a search term.
///
/// Only MangaDex: Kitsu is a fallback for looking a known title up, not
/// something to explore.
pub fn browse(query: &BrowseQuery) -> Result<BrowsePage> {
    mangadex::browse(query)
}

/// Every tag a series can carry, for building a filter picker.
pub fn tags() -> Result<Vec<Tag>> {
    mangadex::tags()
}

/// Where a chapter's images live, distinguishing "not hosted here" from an
/// error. See [`mangadex::ChapterImages`].
pub fn chapter_images(source: Source, chapter_id: &str) -> Result<mangadex::ChapterImages> {
    match source {
        Source::MangaDex => mangadex::chapter_images(chapter_id),
        Source::Kitsu => bail!("Kitsu does not host chapter images"),
    }
}

/// Image URLs for one chapter, straight from the source.
///
/// Far better than reading a page: no rendering, no guessing which `<img>` is a
/// page, and the ordering is the publisher's own. Only MangaDex offers this.
pub fn chapter_pages(source: Source, chapter_id: &str) -> Result<Vec<String>> {
    match source {
        Source::MangaDex => mangadex::chapter_pages(chapter_id),
        Source::Kitsu => bail!("Kitsu does not host chapter images"),
    }
}

/// The published volume-to-chapter map, when the source has one.
pub fn volume_chapters(source: Source, id: &str) -> Result<Vec<VolumeChapters>> {
    match source {
        Source::MangaDex => mangadex::volume_chapters(id),
        // Kitsu has no volume-level chapter listing.
        Source::Kitsu => Ok(Vec::new()),
    }
}

/// GET a URL and parse the body as JSON.
pub(crate) fn get_json(url: &str, params: &[(&str, &str)]) -> Result<serde_json::Value> {
    let mut request = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/json")
        .timeout(TIMEOUT);

    for (key, value) in params {
        request = request.query(key, value);
    }

    let response = request.call()?;
    Ok(response.into_json()?)
}

/// Download binary content, refusing anything that is not an image or is large
/// enough to suggest we followed the wrong link.
pub fn download_image(url: &str) -> Result<Vec<u8>> {
    const MAX_BYTES: usize = 32 * 1024 * 1024;

    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(TIMEOUT)
        .call()?;

    let content_type = response.content_type().to_ascii_lowercase();
    if !content_type.starts_with("image/") {
        bail!("expected an image, got {content_type}");
    }

    // `into_reader` hands back a boxed trait object, so `take` has to be called
    // on the box itself rather than through a deref.
    let reader = response.into_reader();
    let mut limited = std::io::Read::take(reader, MAX_BYTES as u64 + 1);

    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut limited, &mut bytes)?;

    if bytes.len() > MAX_BYTES {
        bail!("cover is unexpectedly large (over {} MB)", MAX_BYTES / 1_048_576);
    }
    Ok(bytes)
}

/// Order volume labels numerically, keeping unparseable ones at the end.
pub(crate) fn volume_sort_key(volume: &str) -> (u8, f64) {
    match volume.parse::<f64>() {
        Ok(n) => (0, n),
        Err(_) => (1, 0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volumes_order_numerically_not_lexicographically() {
        let mut volumes = vec!["10", "2", "1"];
        volumes.sort_by(|a, b| {
            volume_sort_key(a)
                .partial_cmp(&volume_sort_key(b))
                .unwrap()
        });
        assert_eq!(volumes, ["1", "2", "10"]);
    }

    #[test]
    fn unparseable_volume_labels_sort_last() {
        assert!(volume_sort_key("special") > volume_sort_key("99"));
    }

    #[test]
    fn an_empty_query_makes_no_request() {
        assert!(search("   ", 5).unwrap().is_empty());
    }
}
