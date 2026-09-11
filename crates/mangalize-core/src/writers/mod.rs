//! Output formats. Every writer consumes the same [`Volume`] and differs only in
//! how it packages the pages.

pub mod cbz;
pub mod epub;
mod timestamp;

use std::path::Path;

use anyhow::{Context, Result};

use crate::page::{Page, PageKind};
use crate::project::Direction;

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
/// Unsplit pages are passed through byte-for-byte: re-encoding a JPEG that is
/// already the right size only loses quality and time.
pub fn render_page(page: &Page, direction: Direction) -> Result<Vec<Rendered>> {
    let must_split = page.split && page.kind == PageKind::Spread;

    if !must_split {
        let bytes = std::fs::read(&page.path)
            .with_context(|| format!("reading {}", page.path.display()))?;
        return Ok(vec![Rendered {
            bytes,
            ext: stored_ext(page),
            width: page.width,
            height: page.height,
        }]);
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

    ordered
        .into_iter()
        .map(|part| {
            let (width, height) = (part.width(), part.height());
            let mut bytes = Vec::new();
            part.write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Jpeg,
            )
            .context("encoding split half")?;
            Ok(Rendered {
                bytes,
                ext: "jpg",
                width,
                height,
            })
        })
        .collect()
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

    #[test]
    fn escapes_xml_metacharacters() {
        assert_eq!(esc("Tom & Jerry <3"), "Tom &amp; Jerry &lt;3");
    }
}
