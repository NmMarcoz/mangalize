//! AniList GraphQL client — metadata only.
//!
//! AniList tracks no chapter or volume structure at all: `Media.chapters`/
//! `.volumes` are bare totals, never a chapter-to-volume map. There is
//! nothing here to list a chapter or fetch a page from, only a title match's
//! own fields, used to fill gaps in a series' metadata — so this is never
//! registered as a `Source`, only ever a [`crate::MetadataHint`].
//!
//! The GraphQL endpoint is capped at 30 requests/minute unauthenticated (down
//! from 90, after years of scraper abuse). That rules AniList out as
//! anything resembling a browse, but is fine for the one lookup a series add
//! makes.

use anyhow::Result;
use serde_json::{json, Value};

use crate::{MetadataHint, TIMEOUT, USER_AGENT};

const API: &str = "https://graphql.anilist.co";

const QUERY: &str = "
query ($search: String) {
  Page(page: 1, perPage: 1) {
    media(search: $search, type: MANGA) {
      title { romaji native }
      description(asHtml: false)
      genres
      isAdult
      coverImage { extraLarge large }
      staff(perPage: 4, sort: RELEVANCE) {
        edges { role node { name { full } } }
      }
    }
  }
}";

pub fn search(title: &str) -> Result<Option<MetadataHint>> {
    let response = ureq::post(API)
        .set("User-Agent", USER_AGENT)
        .set("Content-Type", "application/json")
        .timeout(TIMEOUT)
        .send_json(json!({ "query": QUERY, "variables": { "search": title } }))?;

    let body: Value = response.into_json()?;
    let media = &body["data"]["Page"]["media"][0];
    if media.is_null() {
        return Ok(None);
    }

    let (author, artist) = credits(&media["staff"]["edges"]);

    Ok(Some(MetadataHint {
        title_romaji: media["title"]["romaji"].as_str().map(String::from),
        title_native: media["title"]["native"].as_str().map(String::from),
        author,
        artist,
        description: media["description"].as_str().map(strip_tags),
        tags: media["genres"]
            .as_array()
            .map(|genres| genres.iter().filter_map(|g| g.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        // AniList only ever flags a title as adult or not, never a finer
        // grade, so anything else is left unknown rather than asserted safe.
        content_rating: media["isAdult"]
            .as_bool()
            .and_then(|adult| adult.then(|| "pornographic".to_string())),
        cover_url: media["coverImage"]["extraLarge"]
            .as_str()
            .or_else(|| media["coverImage"]["large"].as_str())
            .map(String::from),
    }))
}

/// AniList splits story from art by a free-text `role` string rather than two
/// fields, so this reads for "story"/"art" in it; a single-person "Story &
/// Art" credit falls into both. Falls back to the first credited name for
/// both when nothing matched at all, rather than leaving both blank when
/// there plainly was a credit.
fn credits(edges: &Value) -> (Option<String>, Option<String>) {
    let mut author = None;
    let mut artist = None;
    for edge in edges.as_array().into_iter().flatten() {
        let role = edge["role"].as_str().unwrap_or_default().to_ascii_lowercase();
        let name = edge["node"]["name"]["full"].as_str().map(String::from);
        if role.contains("story") && author.is_none() {
            author = name.clone();
        }
        if role.contains("art") && artist.is_none() {
            artist = name;
        }
    }
    if author.is_none() && artist.is_none() {
        let first = edges[0]["node"]["name"]["full"].as_str().map(String::from);
        author = first.clone();
        artist = first;
    }
    (author, artist)
}

/// AniList descriptions are HTML — mostly `<br>` and `<i>` — and this is only
/// ever shown as plain text, so tags are stripped rather than rendered.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}
