//! Jikan client (an unofficial MyAnimeList API) — metadata only.
//!
//! Like AniList, this mirrors MyAnimeList's own tracking data: a title,
//! credits, a synopsis, genres and a cover, never a chapter list or a page to
//! fetch — so it is a [`crate::MetadataHint`] source, never a `Source`, for
//! the same reason AniList is not one.
//!
//! Jikan documents its own rate limit at roughly 3 requests/second and 60/
//! minute; fine for the one lookup a series add makes, not for anything
//! bulk.

use anyhow::Result;

use crate::{get_json, MetadataHint};

const API: &str = "https://api.jikan.moe/v4";

pub fn search(title: &str) -> Result<Option<MetadataHint>> {
    let body = get_json(&format!("{API}/manga"), &[("q", title), ("limit", "1")])?;
    let entry = &body["data"][0];
    if entry.is_null() {
        return Ok(None);
    }

    // MyAnimeList's search response credits "authors" without splitting story
    // from art, so the same name stands in for both rather than leaving
    // artist blank when it is really the same person.
    let author = entry["authors"][0]["name"].as_str().map(String::from);

    Ok(Some(MetadataHint {
        title_romaji: entry["title"].as_str().map(String::from),
        title_native: entry["title_japanese"].as_str().map(String::from),
        author: author.clone(),
        artist: author,
        description: entry["synopsis"].as_str().map(String::from),
        tags: entry["genres"]
            .as_array()
            .map(|genres| genres.iter().filter_map(|g| g["name"].as_str().map(String::from)).collect())
            .unwrap_or_default(),
        // MyAnimeList publishes no content rating for manga (only for anime),
        // so this is left unknown rather than guessed.
        content_rating: None,
        cover_url: entry["images"]["jpg"]["large_image_url"].as_str().map(String::from),
    }))
}
