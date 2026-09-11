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

/// Which chapters a published volume contains.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeChapters {
    pub volume: String,
    pub chapters: Vec<String>,
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
