//! A single image file and everything we infer about it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Extensions we are willing to treat as comic pages.
const RASTER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "avif", "bmp", "tif", "tiff"];

/// Extensions that show up in scraped folders but are never pages.
const JUNK_EXTS: &[&str] = &["svg", "gif", "ico", "css", "js", "html", "htm", "json", "txt"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PageKind {
    /// An ordinary single page.
    Single,
    /// A double-page spread: roughly twice the width of its chapter's norm.
    Spread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "reason")]
pub enum ExcludeReason {
    /// Extension is not a raster image, or is a known site-furniture type.
    NotAPage,
    /// Decoding the header failed, so it is not a usable image.
    Unreadable,
    /// Dimensions are wildly off the chapter's normal page size — banners, logos,
    /// tracking pixels.
    OffSize { width: u32, height: u32 },
    /// The user excluded it by hand in the UI.
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Page {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub kind: PageKind,
    /// `Some` when the page is held out of the output; the UI shows these in a
    /// collapsed "excluded" row so they can be restored.
    pub excluded: Option<ExcludeReason>,
    /// Cut a [`PageKind::Spread`] into two single pages on export.
    pub split: bool,
}

impl Page {
    pub fn is_included(&self) -> bool {
        self.excluded.is_none()
    }

    pub fn file_name(&self) -> &str {
        self.path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
    }

    /// Aspect ratio, width over height.
    pub fn aspect(&self) -> f32 {
        if self.height == 0 {
            return 0.0;
        }
        self.width as f32 / self.height as f32
    }
}

/// Classify a path by extension before we pay to read its header.
///
/// Note `.jpg.jpeg` double extensions are common in scraped folders; only the
/// final component is considered, which is the correct behaviour here.
pub fn extension_verdict(path: &Path) -> Option<ExcludeReason> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    match ext {
        Some(e) if RASTER_EXTS.contains(&e.as_str()) => None,
        Some(e) if JUNK_EXTS.contains(&e.as_str()) => Some(ExcludeReason::NotAPage),
        _ => Some(ExcludeReason::NotAPage),
    }
}

/// Read width and height from an image header without decoding pixel data.
pub fn probe_dimensions(path: &Path) -> Option<(u32, u32)> {
    image::image_dimensions(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_extension_uses_final_component() {
        assert_eq!(extension_verdict(Path::new("01.jpg.jpeg")), None);
    }

    #[test]
    fn site_furniture_is_rejected() {
        assert_eq!(
            extension_verdict(Path::new("close.svg")),
            Some(ExcludeReason::NotAPage)
        );
        assert_eq!(
            extension_verdict(Path::new("pxf.gif")),
            Some(ExcludeReason::NotAPage)
        );
    }

    #[test]
    fn extensionless_files_are_rejected() {
        assert_eq!(
            extension_verdict(Path::new("README")),
            Some(ExcludeReason::NotAPage)
        );
    }
}
