//! Output formats. Every writer consumes the same [`Volume`] and differs only in
//! how it packages the pages.

pub mod cbz;
pub mod epub;
mod timestamp;

use std::path::Path;

use anyhow::{Context, Result};

use crate::compress::{self, Compression};
use crate::page::{Page, PageKind};
use crate::project::Direction;

/// Which writer the pages are being rendered for.
///
/// Only matters because the two disagree about what they can display, and the
/// disagreement is silent: an EPUB full of WebP opens on a Kindle as a book of
/// blank pages, with no error anywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Epub,
    Cbz,
}

/// Formats a Kindle can actually draw.
///
/// KF8, which Send to Kindle converts an EPUB into, handles JPEG, PNG, GIF and
/// BMP. Not WebP, and not AVIF — both of which scrapers now serve routinely.
const KINDLE_FORMATS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp"];

/// JPEG quality for the halves of a split spread.
const SPLIT_QUALITY: u8 = 92;

/// Callback invoked as `(pages_done, pages_total)` while a volume is written.
pub type Progress<'a> = dyn FnMut(usize, usize) + 'a;

/// One image as it will appear in the output: raw bytes, the extension they
/// should be stored under, and the dimensions the page must be laid out at.
pub struct Rendered {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
    pub width: u32,
    pub height: u32,
}

/// The bytes to write for a page, expanding a split spread into two halves.
///
/// With compression off, an unsplit page is passed through byte-for-byte:
/// re-encoding a JPEG that is already the right size only loses quality and
/// time. With it on, the page is resized and re-encoded, and the original is
/// still kept whenever that would not actually be smaller.
pub fn render_page(
    page: &Page,
    direction: Direction,
    compression: &Compression,
    target: Target,
) -> Result<Vec<Rendered>> {
    let must_split = page.split && page.kind == PageKind::Spread;

    if !must_split {
        let bytes = std::fs::read(&page.path)
            .with_context(|| format!("reading {}", page.path.display()))?;

        let rendered = match compress::compress(&bytes, compression) {
            Some(smaller) => Rendered {
                bytes: smaller.bytes,
                ext: "jpg",
                width: smaller.width,
                height: smaller.height,
            },
            None => Rendered {
                bytes,
                ext: stored_ext(page),
                width: page.width,
                height: page.height,
            },
        };
        return Ok(vec![make_displayable(rendered, target)?]);
    }

    let img = image::open(&page.path)
        .with_context(|| format!("decoding {}", page.path.display()))?;
    let half = img.width() / 2;
    let left = img.crop_imm(0, 0, half, img.height());
    let right = img.crop_imm(half, 0, img.width() - half, img.height());

    // Right-to-left titles read the right half of a spread first.
    let ordered = match direction {
        Direction::RightToLeft => [right, left],
        Direction::LeftToRight => [left, right],
    };

    // A half is already in memory, so it goes straight to the encoder rather
    // than round-tripping through JPEG to reach the same place.
    let settings = if compression.is_noop() {
        // Explicit quality, not the encoder default of 75. Splitting is the
        // normal path for a spread, so every one of them is re-encoded once; at
        // 75 the screentones and inked edges manga is made of visibly mush.
        Compression {
            max_edge: None,
            quality: SPLIT_QUALITY,
            grayscale: false,
        }
    } else {
        *compression
    };

    ordered
        .into_iter()
        .map(|part| {
            let encoded = compress::render(&part, &settings).context("encoding split half")?;
            Ok(Rendered {
                bytes: encoded.bytes,
                ext: "jpg",
                width: encoded.width,
                height: encoded.height,
            })
        })
        .collect()
}

/// Convert a page a Kindle cannot draw into one it can.
///
/// Only ever touches EPUB output, and only formats outside `KINDLE_FORMATS`.
/// A CBZ is left alone: Komga, Kavita and desktop readers handle WebP happily,
/// and re-encoding it there would lose quality for nothing.
fn make_displayable(rendered: Rendered, target: Target) -> Result<Rendered> {
    if target == Target::Cbz || KINDLE_FORMATS.contains(&rendered.ext) {
        return Ok(rendered);
    }

    let image = image::load_from_memory(&rendered.bytes)
        .with_context(|| format!("decoding a {} page for conversion", rendered.ext))?;

    let encoded = compress::render(
        &image,
        &Compression {
            max_edge: None,
            // Converting is already a loss; being stingy about quality on top
            // would compound it for no reason.
            quality: 92,
            grayscale: false,
        },
    )
    .context("converting page to JPEG")?;

    Ok(Rendered {
        bytes: encoded.bytes,
        ext: "jpg",
        width: encoded.width,
        height: encoded.height,
    })
}

/// The extension a page's original bytes should be stored under.
fn stored_ext(page: &Page) -> &'static str {
    match page
        .path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "png",
        Some("webp") => "webp",
        Some("avif") => "avif",
        _ => "jpg",
    }
}

/// The media type matching [`stored_ext`].
pub fn media_type(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "image/jpeg",
    }
}

/// Create the parent directory of an output path if needed.
pub fn ensure_parent(out: &Path) -> Result<()> {
    if let Some(dir) = out.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("creating {}", dir.display()))?;
        }
    }
    Ok(())
}

/// Escape the five XML predefined entities.
pub(crate) fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TINY_WEBP: &[u8] = &[
        82, 73, 70, 70, 30, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76,
        17, 0, 0, 0, 47, 7, 192, 2, 0, 7, 80, 143, 34, 215, 163, 255,
        129, 136, 232, 127, 0, 0,
    ];

    fn rendered(bytes: &[u8], ext: &'static str) -> Rendered {
        Rendered { bytes: bytes.to_vec(), ext, width: 8, height: 12 }
    }

    #[test]
    fn webp_is_converted_for_epub_because_kindle_cannot_draw_it() {
        let out = make_displayable(rendered(TINY_WEBP, "webp"), Target::Epub).unwrap();
        assert_eq!(out.ext, "jpg");
        assert_eq!(
            image::guess_format(&out.bytes).unwrap(),
            image::ImageFormat::Jpeg
        );
        assert_eq!((out.width, out.height), (8, 12), "dimensions must survive");
    }

    #[test]
    fn webp_is_left_alone_for_cbz_where_readers_handle_it() {
        let out = make_displayable(rendered(TINY_WEBP, "webp"), Target::Cbz).unwrap();
        assert_eq!(out.ext, "webp");
        assert_eq!(out.bytes, TINY_WEBP, "a CBZ should keep the original bytes");
    }

    #[test]
    fn a_format_kindle_understands_is_never_re_encoded() {
        // Re-encoding a JPEG that already displays would lose quality for free.
        let jpeg = b"\xff\xd8\xff\xe0 pretend jpeg".to_vec();
        let out = make_displayable(rendered(&jpeg, "jpg"), Target::Epub).unwrap();
        assert_eq!(out.bytes, jpeg);

        let png = rendered(b"pretend png", "png");
        assert_eq!(make_displayable(png, Target::Epub).unwrap().ext, "png");
    }

    #[test]
    fn escapes_xml_metacharacters() {
        assert_eq!(esc("Tom & Jerry <3"), "Tom &amp; Jerry &lt;3");
    }
}
