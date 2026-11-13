//! Image cover import.
//!
//! Download a cover image from any URL. The user pastes a direct image URL
//! (e.g. right-click → copy image address from a browser search) and we
//! download it to the app cache. No API needed — works with any image on the web.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::{TIMEOUT, USER_AGENT};

/// Download an image from a URL and return its bytes.
///
/// Used for user-pasted cover URLs. Accepts any URL that returns image content.
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

/// A placeholder result type for API compatibility.
/// The actual import flow is URL → download → cache, no search needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageResult {
    pub url: String,
    pub thumbnail_url: String,
}
