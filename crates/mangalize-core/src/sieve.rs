//! Deciding whether an image is a page, a spread, or site furniture.
//!
//! Extracted from [`crate::scan`] because the same judgement is needed before
//! any file exists on disk: when a chapter is downloaded from a URL, the picker
//! wants to preselect the real pages and flag the banners, using nothing but the
//! dimensions read from each image's header.

use serde::{Deserialize, Serialize};

use crate::page::{ExcludeReason, PageKind};

/// A page shorter or taller than this fraction of the norm is site furniture.
const HEIGHT_MIN: f32 = 0.55;
const HEIGHT_MAX: f32 = 1.80;

/// Width bounds for an ordinary single page, as a fraction of the norm.
const WIDTH_MIN: f32 = 0.55;
const WIDTH_MAX: f32 = 1.40;

/// At or above this fraction of the norm width, a page is a double-page spread.
const SPREAD_MIN: f32 = 1.55;

/// Below this many readable images we cannot trust a modal size, so size-based
/// filtering is skipped entirely.
const MIN_SAMPLE: usize = 3;

/// What the sieve decided about one image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    Single,
    Spread,
    /// Dimensions are wildly off the norm: a banner, a logo, a tracking pixel.
    OffSize,
}

impl Verdict {
    pub fn kind(self) -> PageKind {
        match self {
            Verdict::Spread => PageKind::Spread,
            _ => PageKind::Single,
        }
    }

    /// The exclusion this verdict implies, given the image's own dimensions.
    pub fn exclusion(self, width: u32, height: u32) -> Option<ExcludeReason> {
        match self {
            Verdict::OffSize => Some(ExcludeReason::OffSize { width, height }),
            _ => None,
        }
    }
}

/// The normal page size of a set of images, against which each one is measured.
///
/// Note what is *not* an input here: byte size. A near-blank page compresses to
/// a few kilobytes and is still a real page, so weight must never decide.
///
/// `None` means the sample was too small or too degenerate to draw a norm from,
/// in which case every image is taken at face value rather than guessed at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Norm {
    pub width: u32,
    pub height: u32,
}

impl Norm {
    /// The most common (width, height) among the given images.
    ///
    /// Sizes of zero are ignored: they are unreadable files, not measurements.
    pub fn from_sizes(sizes: impl IntoIterator<Item = (u32, u32)>) -> Option<Self> {
        let mut counts: std::collections::HashMap<(u32, u32), usize> =
            std::collections::HashMap::new();
        let mut sample = 0usize;

        for (width, height) in sizes {
            if width == 0 || height == 0 {
                continue;
            }
            sample += 1;
            *counts.entry((width, height)).or_insert(0) += 1;
        }

        if sample < MIN_SAMPLE {
            return None;
        }

        // Ties break on the larger size, which is the safer norm to measure against.
        counts
            .into_iter()
            .max_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)))
            .map(|((width, height), _)| Norm { width, height })
    }

    /// Judge one image against this norm.
    pub fn verdict(self, width: u32, height: u32) -> Verdict {
        let rh = height as f32 / self.height as f32;
        let rw = width as f32 / self.width as f32;

        if !(HEIGHT_MIN..=HEIGHT_MAX).contains(&rh) {
            return Verdict::OffSize;
        }
        if rw >= SPREAD_MIN {
            return Verdict::Spread;
        }
        if !(WIDTH_MIN..=WIDTH_MAX).contains(&rw) {
            return Verdict::OffSize;
        }
        Verdict::Single
    }
}

/// Judge a whole set of images at once, deriving the norm from the set itself.
///
/// When no norm can be established every image comes back [`Verdict::Single`]:
/// a short chapter of unusual pages is far more likely than three banners.
pub fn judge(sizes: &[(u32, u32)]) -> Vec<Verdict> {
    match Norm::from_sizes(sizes.iter().copied()) {
        Some(norm) => sizes
            .iter()
            .map(|&(w, h)| {
                // An unreadable image has nothing to measure; leave it alone and
                // let the caller's own "could not decode" handling take over.
                if w == 0 || h == 0 {
                    Verdict::Single
                } else {
                    norm.verdict(w, h)
                }
            })
            .collect(),
        None => vec![Verdict::Single; sizes.len()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spreads_are_detected_by_width() {
        let norm = Norm { width: 800, height: 1168 };
        assert_eq!(norm.verdict(1600, 1168), Verdict::Spread);
    }

    #[test]
    fn banners_are_excluded_by_height() {
        let norm = Norm { width: 800, height: 1168 };
        assert_eq!(norm.verdict(728, 90), Verdict::OffSize);
    }

    #[test]
    fn favicons_are_excluded() {
        let norm = Norm { width: 800, height: 1168 };
        assert_eq!(norm.verdict(32, 32), Verdict::OffSize);
    }

    #[test]
    fn the_norm_is_the_modal_size_not_the_average() {
        let norm = Norm::from_sizes([(800, 1168), (800, 1168), (800, 1168), (1600, 1168)]);
        assert_eq!(norm, Some(Norm { width: 800, height: 1168 }));
    }

    #[test]
    fn too_small_a_sample_yields_no_norm() {
        assert_eq!(Norm::from_sizes([(800, 1168), (800, 1168)]), None);
    }

    #[test]
    fn without_a_norm_everything_is_taken_at_face_value() {
        assert_eq!(judge(&[(728, 90), (800, 1168)]), [Verdict::Single; 2]);
    }

    #[test]
    fn a_realistic_scrape_keeps_pages_and_drops_furniture() {
        let sizes = [
            (800, 1168),
            (800, 1168),
            (800, 1168),
            (1600, 1168),
            (728, 90),
            (32, 32),
        ];
        assert_eq!(
            judge(&sizes),
            [
                Verdict::Single,
                Verdict::Single,
                Verdict::Single,
                Verdict::Spread,
                Verdict::OffSize,
                Verdict::OffSize,
            ]
        );
    }
}
