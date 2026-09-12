//! Turn a folder of scraped chapters into an editable [`Volume`].
//!
//! Scraped folders are messy in predictable ways: site furniture mixed in with
//! pages (banners, close buttons, tracking pixels), inconsistent filename
//! schemes between chapters, and the occasional double-page spread. This module
//! applies heuristics to produce a sensible default, and records *why* each page
//! was held out so the UI can offer it back.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::natsort::{natural_cmp, trailing_number};
use crate::page::{extension_verdict, probe_dimensions, ExcludeReason, Page, PageKind};
use crate::project::{Chapter, Metadata, Volume};
use crate::sieve::Norm;

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
    let norm = Norm::from_sizes(
        chapters
            .iter()
            .flat_map(|c| &c.pages)
            .map(|p| (p.width, p.height)),
    );

    if let Some(norm) = norm {
        for chapter in &mut chapters {
            for page in &mut chapter.pages {
                if page.excluded.is_some() {
                    continue;
                }
                let verdict = norm.verdict(page.width, page.height);
                page.kind = verdict.kind();
                page.excluded = verdict.exclusion(page.width, page.height);

                // Spreads are split by default. A Kindle shown a page twice the
                // width of every other one does not scale it down to fit; it
                // picks a region and zooms, so the reader sees half a drawing
                // with no way to tell there is more. Two ordinary pages always
                // read correctly. `S` in the editor rejoins one.
                page.split = page.kind == PageKind::Spread;
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
    fn identifier_is_stable_across_scans() {
        let a = stable_id(Path::new("/x/Itch The Witch Volume 01"));
        let b = stable_id(Path::new("/y/Itch The Witch Volume 01"));
        assert_eq!(a, b);
        assert_ne!(a, stable_id(Path::new("/x/Itch The Witch Volume 02")));
    }
}
