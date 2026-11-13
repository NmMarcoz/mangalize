//! Image search for cover art.
//!
//! When metadata has no cover, the user needs a way to find one without leaving
//! the app. This module provides two approaches:
//!
//! 1. **Wikimedia Commons API** — a proper JSON API for searching images.
//!    Reliable and won't get blocked, though coverage depends on what
//!    contributors have uploaded.
//! 2. **Direct URL import** — the user pastes an image URL (e.g. copied from
//!    Google Images) and we download it. This is the most reliable fallback
//!    since it works with any image on the web.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::{TIMEOUT, USER_AGENT};

/// One image result from a search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageResult {
    /// The full-size image URL.
    pub url: String,
    /// A smaller thumbnail for the preview grid.
    pub thumbnail_url: String,
    /// A title or description, when available.
    pub title: Option<String>,
}

/// Search Wikimedia Commons for images matching a query.
///
/// Uses the Wikimedia Commons API which returns JSON — no HTML scraping needed.
/// The API is free, key-less, and does not block automated requests.
pub fn search_images(query: &str) -> Result<Vec<ImageResult>> {
    let encoded = url_encode(query);

    // Search for images, asking for both the original URL and a thumbnail.
    let url = format!(
        "https://commons.wikimedia.org/w/api.php\
         ?action=query\
         &generator=search\
         &gsrnamespace=6\
         &gsrsearch={encoded}\
         &gsrlimit=30\
         &prop=imageinfo\
         &iiprop=url|thumburl|mime\
         &iiurlwidth=240\
         &format=json"
    );

    let response = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .timeout(TIMEOUT)
        .call()?;

    let body: serde_json::Value = response.into_json()?;

    let mut results = Vec::new();

    // The response structure is:
    // { "query": { "pages": { "123": { "title": "...", "imageinfo": [{ "url": "...", "thumburl": "...", "mime": "..." }] } } } }
    if let Some(pages) = body.get("query").and_then(|q| q.get("pages")).and_then(|p| p.as_object()) {
        for page in pages.values() {
            let title = page.get("title").and_then(|t| t.as_str());

            // Only include actual image files, not other page types.
            if let Some(t) = title {
                if !is_image_page(t) {
                    continue;
                }
            }

            if let Some(infos) = page.get("imageinfo").and_then(|i| i.as_array()) {
                if let Some(info) = infos.first() {
                    if let (Some(url), Some(thumb)) = (
                        info.get("url").and_then(|u| u.as_str()),
                        info.get("thumburl").or_else(|| info.get("url")).and_then(|u| u.as_str()),
                    ) {
                        // Skip tiny thumbnails and non-image files.
                        let mime = info.get("mime").and_then(|m| m.as_str()).unwrap_or("");
                        if !mime.starts_with("image/") && !url.ends_with(".jpg")
                            && !url.ends_with(".jpeg") && !url.ends_with(".png")
                            && !url.ends_with(".webp")
                        {
                            continue;
                        }

                        results.push(ImageResult {
                            url: url.to_string(),
                            thumbnail_url: thumb.to_string(),
                            title: title.map(|t| t.strip_prefix("File:").unwrap_or(t).to_string()),
                        });
                    }
                }
            }

            if results.len() >= 30 {
                break;
            }
        }
    }

    Ok(results)
}

/// Download an image from a URL and return its bytes.
///
/// Used both for search results and for user-pasted URLs.
pub fn download_image(url: &str) -> Result<Vec<u8>> {
    const MAX_BYTES: usize = 32 * 1024 * 1024;

    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Referer", "https://www.google.com/")
        .timeout(TIMEOUT)
        .call()?;

    let content_type = response.content_type().to_ascii_lowercase();
    if !content_type.starts_with("image/") {
        bail!("expected an image, got {content_type}");
    }

    let reader = response.into_reader();
    let mut limited = std::io::Read::take(reader, MAX_BYTES as u64 + 1);

    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut limited, &mut bytes)?;

    if bytes.len() > MAX_BYTES {
        bail!("image is unexpectedly large (over {} MB)", MAX_BYTES / 1_048_576);
    }
    Ok(bytes)
}

/// A Wikimedia title is an image if it starts with "File:" and has an image extension.
fn is_image_page(title: &str) -> bool {
    if !title.starts_with("File:") {
        return false;
    }
    let ext = title.rsplit('.').next().unwrap_or("").to_lowercase();
    matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif")
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
