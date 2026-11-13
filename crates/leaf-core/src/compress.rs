//! Making pages smaller without making them look worse.
//!
//! A scraped volume is routinely two to four times the size it needs to be, for
//! two reasons that have nothing to do with how good it looks on a reader:
//!
//! - **Pixels nobody can see.** A Kindle Paperwhite is 1236×1648. A page scanned
//!   at 2000 pixels tall is throwing away a third of its detail the moment it is
//!   displayed, and paying full file size for the privilege.
//! - **Three identical colour channels.** Interior manga pages are black and
//!   white, but scrapes almost always store them as RGB JPEG. Encoding a
//!   greyscale page as greyscale costs nothing visually and removes roughly a
//!   third of the file.
//!
//! Both are applied per page, so a colour cover in an otherwise monochrome
//! volume keeps its colour, and a page already smaller than the cap is left
//! alone. Recompression is never allowed to make a page *bigger*: if the result
//! is larger than what came in, the original is kept.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// How hard to work at shrinking pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Compression {
    /// Longest edge in pixels. `None` leaves the page at its original size.
    pub max_edge: Option<u32>,
    /// JPEG quality, 1–100.
    pub quality: u8,
    /// Store a page that is already black and white as greyscale.
    pub grayscale: bool,
}

impl Compression {
    /// Leave every page exactly as it was found.
    ///
    /// The honest default for someone who scanned their own books, and what the
    /// CBZ path wants when it is feeding a desktop reader on a large screen.
    pub const ORIGINAL: Self = Self {
        max_edge: None,
        quality: 100,
        grayscale: false,
    };

    /// Sized for the e-ink Kindles: Paperwhite, Oasis, and older models.
    ///
    /// 1600 is just above the 1648-pixel height of a Paperwhite, so a page still
    /// fills the screen, and panning into a split spread still has real detail
    /// behind it.
    pub const KINDLE: Self = Self {
        max_edge: Some(1600),
        quality: 85,
        grayscale: true,
    };

    /// For a Kindle Scribe or a tablet, where the screen is genuinely larger.
    pub const LARGE: Self = Self {
        max_edge: Some(2400),
        quality: 88,
        grayscale: true,
    };

    /// When the volume has to fit an email attachment limit.
    pub const COMPACT: Self = Self {
        max_edge: Some(1280),
        quality: 78,
        grayscale: true,
    };

    /// Whether this would change a page at all.
    pub fn is_noop(&self) -> bool {
        self.max_edge.is_none() && !self.grayscale && self.quality >= 100
    }
}

impl Default for Compression {
    fn default() -> Self {
        Self::KINDLE
    }
}

/// A page that has been re-encoded.
pub struct Compressed {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Recompress one page, or return `None` to keep the original bytes.
///
/// `None` means "this was not worth it" — the page decoded to something no
/// smaller, or could not be decoded at all. Callers fall back to passing the
/// original through untouched, which is always safe.
pub fn compress(original: &[u8], settings: &Compression) -> Option<Compressed> {
    if settings.is_noop() {
        return None;
    }

    let compressed = try_compress(original, settings).ok()?;

    // Recompressing an already-small JPEG can easily inflate it. Keeping the
    // larger of the two would be absurd, so the original wins ties.
    if compressed.bytes.len() >= original.len() {
        return None;
    }
    Some(compressed)
}

fn try_compress(original: &[u8], settings: &Compression) -> Result<Compressed> {
    let image = image::load_from_memory(original).context("decoding page")?;
    render(&image, settings)
}

/// Resize and encode an image already in memory.
///
/// Used directly by the spread splitter, which has just cropped a half and would
/// otherwise have to encode it and decode it again to get here.
pub fn render(image: &image::DynamicImage, settings: &Compression) -> Result<Compressed> {
    let image = match settings.max_edge {
        // Only ever downscale. Enlarging a small page invents detail and costs
        // size for it.
        Some(max) if image.width().max(image.height()) > max => {
            let (w, h) = scaled_to(image.width(), image.height(), max);
            // CatmullRom keeps inked edges crisp without the ringing Lanczos
            // produces on the hard black-on-white lines manga is made of.
            image.resize(w, h, image::imageops::FilterType::CatmullRom)
        }
        _ => image.clone(),
    };

    let (width, height) = (image.width(), image.height());
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
        std::io::Cursor::new(&mut bytes),
        settings.quality.clamp(1, 100),
    );

    if settings.grayscale && looks_grayscale(&image) {
        encoder
            .encode_image(&image.to_luma8())
            .context("encoding greyscale page")?;
    } else {
        encoder
            .encode_image(&image.to_rgb8())
            .context("encoding page")?;
    }

    Ok(Compressed { bytes, width, height })
}

/// Dimensions that fit inside `max` on the longest edge, keeping the ratio.
fn scaled_to(width: u32, height: u32, max: u32) -> (u32, u32) {
    if width >= height {
        let scaled = (height as u64 * max as u64 / width as u64).max(1) as u32;
        (max, scaled)
    } else {
        let scaled = (width as u64 * max as u64 / height as u64).max(1) as u32;
        (scaled, max)
    }
}

/// How far a channel may drift from the others before a page counts as colour.
///
/// Not zero: JPEG is lossy, and a scan of a black-and-white page picks up a
/// little chroma noise that nobody can see.
const CHROMA_TOLERANCE: u8 = 12;

/// Roughly how many pixels to look at. Enough to catch a small colour element,
/// cheap enough to run on every page of a long volume.
const SAMPLE_TARGET: u32 = 20_000;

/// Whether a page is black and white in everything but its encoding.
///
/// Sampled rather than exhaustive: a full pass over a few hundred pages would
/// cost more than the saving is worth, and a colour page is colour nearly
/// everywhere it matters.
pub fn looks_grayscale(image: &image::DynamicImage) -> bool {
    let rgb = image.to_rgb8();
    let (width, height) = rgb.dimensions();
    if width == 0 || height == 0 {
        return false;
    }

    let total = width as u64 * height as u64;
    let step = (total / SAMPLE_TARGET as u64).max(1) as usize;

    for pixel in rgb.pixels().step_by(step) {
        let [r, g, b] = pixel.0;
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        if max - min > CHROMA_TOLERANCE {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    /// A page shaped like real line work: mostly white, a few panels with hard
    /// borders, and a band of screentone-ish gradient.
    ///
    /// Deliberately not a fine checkerboard. Resampling one of those produces
    /// anti-aliased edges over the whole frame, which is the worst case JPEG
    /// has, and it grows on recompression — true of the fixture and of nothing
    /// a reader will ever open.
    fn inked_page(width: u32, height: u32) -> DynamicImage {
        let mut image = RgbImage::from_pixel(width, height, Rgb([255, 255, 255]));

        // Three stacked panels with black borders.
        for panel in 0..3u32 {
            let top = height * panel / 3 + height / 40;
            let bottom = height * (panel + 1) / 3 - height / 40;
            let (left, right) = (width / 20, width - width / 20);
            for y in top..bottom {
                for x in left..right {
                    let edge = y < top + 3 || y + 3 >= bottom || x < left + 3 || x + 3 >= right;
                    if edge {
                        image.put_pixel(x, y, Rgb([10, 10, 10]));
                    }
                }
            }
        }

        // A soft tonal wash inside the middle panel, as screentone reads once
        // it has been scanned.
        for y in height / 3..height * 2 / 3 {
            for x in width / 4..width * 3 / 4 {
                let shade = 120 + ((x * 90) / width.max(1)) as u8 % 90;
                image.put_pixel(x, y, Rgb([shade, shade, shade]));
            }
        }

        DynamicImage::ImageRgb8(image)
    }

    fn colour_page(width: u32, height: u32) -> DynamicImage {
        let mut image = RgbImage::from_pixel(width, height, Rgb([250, 250, 250]));
        // A patch of saturated colour, as a cover would have.
        for y in 0..height / 4 {
            for x in 0..width / 4 {
                image.put_pixel(x, y, Rgb([200, 40, 40]));
            }
        }
        DynamicImage::ImageRgb8(image)
    }

    fn encode(image: &DynamicImage, quality: u8) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(
            std::io::Cursor::new(&mut bytes),
            quality,
        )
        .encode_image(&image.to_rgb8())
        .unwrap();
        bytes
    }

    #[test]
    fn a_black_and_white_page_is_recognised_as_such() {
        assert!(looks_grayscale(&inked_page(400, 600)));
    }

    #[test]
    fn a_colour_cover_is_not() {
        assert!(!looks_grayscale(&colour_page(400, 600)));
    }

    #[test]
    fn an_oversized_page_is_scaled_to_the_cap() {
        let original = encode(&inked_page(2000, 3000), 95);
        let result = compress(&original, &Compression::KINDLE).expect("should compress");

        // Fitting inside the box rounds down, so 1599 is a correct answer for
        // 1600; what matters is that nothing exceeds the cap.
        assert!(result.height <= 1600 && result.height >= 1598, "{}", result.height);
        assert!(result.width <= 1067, "{}", result.width);

        let ratio = result.width as f64 / result.height as f64;
        assert!((ratio - 2.0 / 3.0).abs() < 0.01, "aspect ratio drifted: {ratio}");
    }

    #[test]
    fn an_oversized_page_gets_dramatically_smaller() {
        // The whole point of the feature. A volume of 30 MB has to come down far
        // enough to clear a 25 MB mail attachment limit with base64 overhead on
        // top, which needs well over half.
        let original = encode(&inked_page(2000, 3000), 95);
        let result = compress(&original, &Compression::KINDLE).expect("should compress");

        let saved = 1.0 - (result.bytes.len() as f64 / original.len() as f64);
        assert!(saved > 0.5, "only saved {:.0}%", saved * 100.0);
    }

    #[test]
    fn a_page_already_under_the_cap_keeps_its_dimensions() {
        let original = encode(&inked_page(800, 1200), 95);
        let result = compress(&original, &Compression::KINDLE).expect("should compress");
        assert_eq!((result.width, result.height), (800, 1200));
    }

    #[test]
    fn a_page_is_never_enlarged_to_meet_the_cap() {
        let original = encode(&inked_page(400, 600), 95);
        let result = compress(&original, &Compression::LARGE);
        // Either it declined, or it left the size alone. What it must not do is
        // scale a small page up to 2400.
        if let Some(result) = result {
            assert_eq!((result.width, result.height), (400, 600));
        }
    }

    #[test]
    fn original_settings_change_nothing() {
        assert!(Compression::ORIGINAL.is_noop());
        let original = encode(&inked_page(800, 1200), 95);
        assert!(compress(&original, &Compression::ORIGINAL).is_none());
    }

    #[test]
    fn a_page_that_would_grow_is_left_alone() {
        // Colour, so greyscale cannot rescue it, and already crushed to q20.
        // Re-encoding at q95 without resizing can only add bytes.
        let original = encode(&colour_page(300, 400), 20);
        let settings = Compression { max_edge: None, quality: 95, grayscale: false };

        assert!(
            compress(&original, &settings).is_none(),
            "recompression must never inflate a page"
        );
    }

    #[test]
    fn undecodable_bytes_fall_back_to_the_original() {
        assert!(compress(b"this is not an image", &Compression::KINDLE).is_none());
    }

    #[test]
    fn scaling_keeps_the_aspect_ratio_both_ways_round() {
        assert_eq!(scaled_to(2000, 3000, 1500), (1000, 1500));
        assert_eq!(scaled_to(3000, 2000, 1500), (1500, 1000));
        // A spread half is still portrait; the cap applies to the long edge.
        assert_eq!(scaled_to(800, 1600, 800), (400, 800));
    }

    #[test]
    fn greyscale_encoding_beats_rgb_on_an_inked_page() {
        let page = inked_page(1200, 1600);
        let original = encode(&page, 90);

        let as_grey = compress(&original, &Compression {
            max_edge: None,
            quality: 90,
            grayscale: true,
        })
        .expect("greyscale should be smaller");

        let as_rgb = compress(&original, &Compression {
            max_edge: None,
            quality: 90,
            grayscale: false,
        });

        let rgb_len = as_rgb.map(|r| r.bytes.len()).unwrap_or(original.len());
        assert!(
            as_grey.bytes.len() < rgb_len,
            "greyscale {} should beat rgb {rgb_len}",
            as_grey.bytes.len()
        );
    }
}
