//! Disk-cached page thumbnails.
//!
//! A volume is a few hundred pages and the grid shows all of them, so decoding
//! full-size JPEGs on every render is not viable. Thumbnails are generated once
//! and cached under the app cache directory, keyed by the source file's identity
//! so an edited or replaced page regenerates automatically.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};

/// JPEG quality for grid thumbnails. High enough that page art stays legible at
/// card size, low enough that the cache stays small.
pub const GRID_QUALITY: u8 = 80;

/// Quality for a page being actually read. The artefacts that go unnoticed in a
/// 150px card are plainly visible filling a screen.
pub const READING_QUALITY: u8 = 90;

/// Return a page bounded to `max` pixels, from cache when possible.
pub fn get(cache_dir: &Path, src: PathBuf, max: u32, quality: u8) -> Result<Vec<u8>> {
    let key = cache_key(&src, max, quality)?;
    let cached = cache_dir.join(format!("{key}.jpg"));

    if let Ok(bytes) = std::fs::read(&cached) {
        return Ok(bytes);
    }

    let bytes = render(&src, max, quality)?;

    // Best effort: a cache write failing must not fail the request.
    if std::fs::create_dir_all(cache_dir).is_ok() {
        let tmp = cache_dir.join(format!("{key}.tmp"));
        if std::fs::write(&tmp, &bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &cached);
        }
    }

    Ok(bytes)
}

/// Decode and downscale one page.
fn render(src: &Path, max: u32, quality: u8) -> Result<Vec<u8>> {
    let img = image::open(src).with_context(|| format!("decoding {}", src.display()))?;

    // `thumbnail` fits inside the box while preserving aspect ratio. The generous
    // height bound makes this effectively a width constraint for portrait pages,
    // while still capping absurdly tall webtoon strips.
    let thumb = img.thumbnail(max, max * 3);

    let mut out = Vec::new();
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::Cursor::new(&mut out), quality);
    encoder
        .encode_image(&thumb.to_rgb8())
        .context("encoding thumbnail")?;
    Ok(out)
}

/// Identity of a source file plus the requested size.
///
/// Includes modification time and length so replacing a page invalidates its
/// cached thumbnail without needing to hash the file contents, and the quality
/// so a reading-sized render never collides with a grid one.
fn cache_key(src: &Path, max: u32, quality: u8) -> Result<String> {
    let meta = std::fs::metadata(src)
        .with_context(|| format!("reading {}", src.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let seed = format!("{}|{}|{}|{}|{}", src.display(), mtime, meta.len(), max, quality);
    Ok(format!("{:032x}", fnv1a(seed.as_bytes())))
}

/// FNV-1a over 128 bits. Not cryptographic; collisions here only mean a stale
/// thumbnail, and the inputs are not adversarial.
fn fnv1a(bytes: &[u8]) -> u128 {
    let mut h: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    for b in bytes {
        h ^= *b as u128;
        h = h.wrapping_mul(0x0000_0000_0100_0000_0000_0000_0000_013b);
    }
    h
}
