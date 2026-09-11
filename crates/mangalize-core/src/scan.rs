//! Turn a folder of scraped chapters into an editable [`Volume`].
//!
//! Scraped folders are messy in predictable ways: site furniture mixed in with
//! pages (banners, close buttons, tracking pixels), inconsistent filename
//! schemes between chapters, and the occasional double-page spread. This module
//! applies heuristics to produce a sensible default, and records *why* each page
//! was held out so the UI can offer it back.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::natsort::{natural_cmp, trailing_number};
use crate::page::{extension_verdict, probe_dimensions, ExcludeReason, Page, PageKind};
use crate::project::{Chapter, Metadata, Volume};

/// A page shorter or taller than this fraction of the volume's norm is site
/// furniture, not a page.
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

/// Scan `root` into a volume.
///
/// Each immediate subdirectory containing images becomes a chapter, ordered
/// naturally. If `root` holds images directly and has no such subdirectories,
/// the whole folder is treated as a single chapter.
pub fn scan_volume(root: impl AsRef<Path>) -> Result<Volume> {
    let root = root.as_ref();
    let mut chapter_dirs = subdirectories(root)
        .with_context(|| format!("reading {}", root.display()))?;
    chapter_dirs.sort_by(|a, b| compare_chapter_dirs(a, b));

    let mut chapters: Vec<Chapter> = chapter_dirs
        .iter()
        .map(|dir| scan_chapter(dir))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|c| !c.pages.is_empty())
        .collect();

    if chapters.is_empty() {
        let single = scan_chapter(root)?;
        if !single.pages.is_empty() {
            chapters.push(single);
        }
    }

    // The modal page size is far more reliable across the whole volume than
    // within one chapter, since every chapter came from the same source.
    let (norm_w, norm_h) = modal_size(&chapters);
    let sample = chapters
        .iter()
        .flat_map(|c| &c.pages)
        .filter(|p| p.width > 0)
        .count();

    if sample >= MIN_SAMPLE && norm_w > 0 && norm_h > 0 {
        for chapter in &mut chapters {
            for page in &mut chapter.pages {
                if page.excluded.is_some() {
                    continue;
                }
                classify(page, norm_w, norm_h);
            }
        }
    }

    let metadata = Metadata {
        series: series_guess(root),
        volume: trailing_number(&file_name(root)).and_then(|n| u32::try_from(n).ok()),
        identifier: format!("urn:uuid:{}", stable_id(root)),
        ..Metadata::default()
    };

    Ok(Volume {
        metadata,
        cover: None,
        chapters,
        root: root.to_path_buf(),
    })
}

/// Decide whether a readable page is a single page, a spread, or off-size junk.
fn classify(page: &mut Page, norm_w: u32, norm_h: u32) {
    let rh = page.height as f32 / norm_h as f32;
    let rw = page.width as f32 / norm_w as f32;

    if !(HEIGHT_MIN..=HEIGHT_MAX).contains(&rh) {
        page.excluded = Some(ExcludeReason::OffSize {
            width: page.width,
            height: page.height,
        });
        return;
    }

    if rw >= SPREAD_MIN {
        page.kind = PageKind::Spread;
    } else if !(WIDTH_MIN..=WIDTH_MAX).contains(&rw) {
        page.excluded = Some(ExcludeReason::OffSize {
            width: page.width,
            height: page.height,
        });
    } else {
        page.kind = PageKind::Single;
    }
}

/// Read one folder's images, in natural filename order.
///
/// Size-based classification happens later, once the volume's norm is known.
fn scan_chapter(dir: &Path) -> Result<Chapter> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .with_context(|| format!("reading {}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .collect();

    entries.sort_by(|a, b| natural_cmp(&file_name(a), &file_name(b)));

    let pages = entries
        .into_iter()
        .filter_map(|path| build_page(&path))
        .collect();

    Ok(Chapter {
        title: chapter_title(dir),
        source: dir.to_path_buf(),
        pages,
    })
}

/// Build a [`Page`], or `None` for files that are not images at all.
///
/// Files rejected purely by extension are dropped rather than listed as
/// excluded: a `.css` was never a candidate and would only be noise in the UI.
/// Files that *look* like images but fail to decode are kept and flagged, since
/// those are the ones worth telling the user about.
fn build_page(path: &Path) -> Option<Page> {
    if extension_verdict(path).is_some() {
        return None;
    }

    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    match probe_dimensions(path) {
        Some((width, height)) => Some(Page {
            path: path.to_path_buf(),
            width,
            height,
            bytes,
            kind: PageKind::Single,
            excluded: None,
            split: false,
        }),
        None => Some(Page {
            path: path.to_path_buf(),
            width: 0,
            height: 0,
            bytes,
            kind: PageKind::Single,
            excluded: Some(ExcludeReason::Unreadable),
            split: false,
        }),
    }
}

/// The most common (width, height) pair among readable pages.
fn modal_size(chapters: &[Chapter]) -> (u32, u32) {
    let mut counts: HashMap<(u32, u32), usize> = HashMap::new();
    for page in chapters.iter().flat_map(|c| &c.pages) {
        if page.width > 0 && page.height > 0 {
            *counts.entry((page.width, page.height)).or_insert(0) += 1;
        }
    }
    // Ties break on the larger size, which is the safer norm to measure against.
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)))
        .map(|(size, _)| size)
        .unwrap_or((0, 0))
}

fn subdirectories(root: &Path) -> Result<Vec<PathBuf>> {
    Ok(std::fs::read_dir(root)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect())
}

/// Order chapter folders by their trailing number when both have one, so `ch10`
/// follows `ch9`; otherwise fall back to natural name order.
fn compare_chapter_dirs(a: &Path, b: &Path) -> Ordering {
    let (an, bn) = (file_name(a), file_name(b));
    match (trailing_number(&an), trailing_number(&bn)) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| natural_cmp(&an, &bn)),
        _ => natural_cmp(&an, &bn),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string()
}

/// Human-facing chapter title derived from the folder name.
fn chapter_title(dir: &Path) -> String {
    let name = file_name(dir);
    match trailing_number(&name) {
        Some(n) => format!("Chapter {n}"),
        None => titlecase(&name),
    }
}

/// Best guess at the series name from the volume folder, e.g.
/// `Itch The Witch Volume 01` -> `Itch The Witch`.
fn series_guess(root: &Path) -> String {
    // Normalise separators first so `berserk-vol.3` and `Berserk Vol. 3` are
    // handled by the same markers.
    let name = file_name(root).replace(['-', '_'], " ");
    let lowered = name.to_ascii_lowercase();

    let cut = ["volume", "vol.", "vol ", "tome "]
        .iter()
        .filter_map(|marker| find_at_word_start(&lowered, marker))
        .min();

    let base = match cut {
        Some(i) => &name[..i],
        None => &name[..],
    };
    titlecase(base.trim())
}

/// Find `needle` only where it starts a word, so `volleyball` is not mistaken
/// for a `vol` marker. Both arguments must be lowercase ASCII markers.
fn find_at_word_start(haystack: &str, needle: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(needle) {
        let i = from + rel;
        if i == 0 || haystack.as_bytes()[i - 1] == b' ' {
            return Some(i);
        }
        // `needle` is ASCII, so `i + 1` is always a char boundary.
        from = i + 1;
    }
    None
}

fn titlecase(s: &str) -> String {
    s.replace(['-', '_'], " ")
        .split_whitespace()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A deterministic identifier derived from the folder name, so re-exporting the
/// same volume keeps the same EPUB identity instead of creating a duplicate in
/// the reader's library.
fn stable_id(root: &Path) -> String {
    let name = file_name(root);
    let mut h: u128 = 0xcbf2_9ce4_8422_2325;
    for b in name.as_bytes() {
        h ^= *b as u128;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let hex = format!("{h:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_guess_strips_volume_suffix() {
        assert_eq!(
            series_guess(Path::new("/x/Itch The Witch Volume 01")),
            "Itch The Witch"
        );
        assert_eq!(series_guess(Path::new("/x/berserk-vol.3")), "Berserk");
        assert_eq!(series_guess(Path::new("/x/Berserk Vol. 3")), "Berserk");
    }

    #[test]
    fn series_guess_keeps_words_that_merely_start_with_vol() {
        assert_eq!(
            series_guess(Path::new("/x/Haikyuu Volleyball Club")),
            "Haikyuu Volleyball Club"
        );
    }

    #[test]
    fn chapter_titles_come_from_trailing_numbers() {
        assert_eq!(chapter_title(Path::new("/x/itch-the-witch-ch7")), "Chapter 7");
        assert_eq!(chapter_title(Path::new("/x/extras")), "Extras");
    }

    #[test]
    fn spreads_are_detected_by_width() {
        let mut page = page_at(1600, 1168);
        classify(&mut page, 800, 1168);
        assert_eq!(page.kind, PageKind::Spread);
        assert!(page.is_included());
    }

    #[test]
    fn banners_are_excluded_by_height() {
        let mut page = page_at(728, 90);
        classify(&mut page, 800, 1168);
        assert!(matches!(page.excluded, Some(ExcludeReason::OffSize { .. })));
    }

    #[test]
    fn a_tiny_but_correctly_sized_page_is_kept() {
        // A near-blank page compresses to a few KB; size alone must never exclude.
        let mut page = Page { bytes: 3811, ..page_at(800, 1168) };
        classify(&mut page, 800, 1168);
        assert!(page.is_included());
    }

    #[test]
    fn identifier_is_stable_across_scans() {
        let a = stable_id(Path::new("/x/Itch The Witch Volume 01"));
        let b = stable_id(Path::new("/y/Itch The Witch Volume 01"));
        assert_eq!(a, b);
        assert_ne!(a, stable_id(Path::new("/x/Itch The Witch Volume 02")));
    }

    fn page_at(width: u32, height: u32) -> Page {
        Page {
            path: PathBuf::from("p.jpeg"),
            width,
            height,
            bytes: 100_000,
            kind: PageKind::Single,
            excluded: None,
            split: false,
        }
    }
}
