//! Image search for cover art.
//!
//! When metadata has no cover, the user needs a way to find one without leaving
//! the app. This module searches for images using a web search engine and
//! returns a list of image URLs the user can pick from.
//!
//! Google Images embeds image URLs directly in the initial HTML response inside
//! JavaScript data blobs. Scanning the markup for URL patterns — the same
//! approach `mangalize_fetch::extract` uses for reader pages — is enough to
//! pull out a usable grid of results without a headless browser.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{TIMEOUT, USER_AGENT};

/// One image result from a search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageResult {
    /// The full-size image URL.
    pub url: String,
    /// A thumbnail URL for preview. Google returns smaller thumbnails inline;
    /// we use the same URL when we cannot separate them.
    pub thumbnail_url: String,
}

/// Search for images matching a query.
///
/// Returns a list of image results. The scan is best-effort: a few unparseable
/// entries are skipped rather than failing the whole search.
pub fn search_images(query: &str) -> Result<Vec<ImageResult>> {
    let encoded = url_encode(query);
    let url = format!(
        "https://www.google.com/search?tbm=isch&q={encoded}&safe=active"
    );

    let response = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .timeout(TIMEOUT)
        .call()?;

    let html = response.into_string()?;

    // Google embeds image URLs inside JavaScript string literals in the HTML.
    // They appear as `https://...` followed by common image extensions, wrapped
    // in quotes or brackets. We scan for them with simple string matching.
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let extensions = [".jpg", ".jpeg", ".png", ".webp"];
    let mut search_from = 0;

    while let Some(https_pos) = html[search_from..].find("https://") {
        let abs_pos = search_from + https_pos;
        // Find the end of the URL: the next quote, bracket, space, or backslash.
        let after_scheme = abs_pos + 8;
        let end = html[after_scheme..]
            .find(|c: char| c == '"' || c == '\'' || c == ']' || c == ')' || c == '\\' || c == ' ' || c.is_control())
            .map(|i| after_scheme + i)
            .unwrap_or(html.len());

        let candidate = &html[abs_pos..end];

        // Must end with an image extension (possibly followed by query params).
        let path_end = candidate.find('?').unwrap_or(candidate.len());
        let path = &candidate[..path_end];
        let has_extension = extensions.iter().any(|ext| path.ends_with(ext));

        if has_extension && candidate.len() > 30 && !candidate.contains("data:image") {
            if seen.insert(candidate.to_string()) {
                results.push(ImageResult {
                    url: candidate.to_string(),
                    thumbnail_url: candidate.to_string(),
                });
            }
        }

        search_from = end;
        if results.len() >= 50 {
            break;
        }
    }

    Ok(results)
}

/// Minimal percent-encoding for a URL query parameter.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push_str(&format!("{byte:02X}"));
            }
        }
    }
    out
}
