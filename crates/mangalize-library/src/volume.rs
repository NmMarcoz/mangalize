//! Handing a stored volume to the existing pipeline.
//!
//! Once chapters are on disk the library has nothing further to add: the scanner
//! already knows how to read a folder of chapter folders, and the editor and the
//! writers already know what to do with the result. This module only fills in
//! the metadata the library knows and the scanner cannot guess.

use anyhow::{bail, Result};
use mangalize_core::project::{Direction, Volume};
use mangalize_core::scan_volume;

use crate::model::{SeriesId, VolumeStatus};
use crate::Library;

impl Library {
    /// Build an editable [`Volume`] from the chapters of `volume_number` that
    /// are actually on disk.
    ///
    /// Missing chapters are simply absent rather than an error: assembling a
    /// partial volume to check how it reads is a normal thing to want, and the
    /// UI already shows what is missing.
    pub fn build_volume(&self, id: SeriesId, volume_number: &str) -> Result<Volume> {
        let series = self.series(id)?;
        let status = self
            .volumes(id)?
            .into_iter()
            .find(|v| v.number == volume_number)
            .ok_or_else(|| anyhow::anyhow!("{} has no volume {volume_number}", series.title))?;

        let mut volume = scan_stored(&status)?;

        volume.metadata.series = series.title.clone();
        volume.metadata.volume = crate::paths::sort_key(volume_number)
            .filter(|n| n.fract() == 0.0 && *n >= 0.0)
            .map(|n| n as u32);
        volume.metadata.author = author_line(&series.author, &series.artist);
        volume.metadata.description = series.description.clone();
        volume.metadata.language = series.language.clone();
        volume.metadata.direction = match series.direction.as_str() {
            "left-to-right" => Direction::LeftToRight,
            _ => Direction::RightToLeft,
        };
        // Identity must be stable per series *and* volume, so re-exporting
        // replaces the book in a reader's library rather than duplicating it.
        volume.metadata.identifier = format!(
            "urn:uuid:{}",
            stable_id(&format!("{}|{volume_number}", series.id.0))
        );

        // Prefer the published per-volume art over page one.
        volume.cover = status.cover_path.clone().filter(|p| p.exists());

        // The scanner titles chapters from folder names like `c0007`; the
        // library knows the real numbers and titles.
        for (chapter, stored) in volume
            .chapters
            .iter_mut()
            .zip(status.chapters.iter().filter(|c| c.downloaded()))
        {
            chapter.title = match &stored.title {
                Some(t) if !t.trim().is_empty() => format!("Chapter {} — {t}", stored.number),
                _ => format!("Chapter {}", stored.number),
            };
        }

        Ok(volume)
    }
}

/// Scan the chapters folder, then keep only the chapters this volume claims.
///
/// Scanning the whole folder rather than each chapter separately is deliberate:
/// the page-size norm is far more reliable across every chapter of a series than
/// across the handful in one volume.
fn scan_stored(status: &VolumeStatus) -> Result<Volume> {
    let dirs: Vec<_> = status
        .chapters
        .iter()
        .filter_map(|c| c.folder.clone())
        .filter(|p| p.is_dir())
        .collect();

    if dirs.is_empty() {
        bail!("no chapters of volume {} are downloaded yet", status.number);
    }

    let chapters_root = dirs[0]
        .parent()
        .ok_or_else(|| anyhow::anyhow!("chapter folder has no parent"))?
        .to_path_buf();

    let mut volume = scan_volume(&chapters_root)?;
    volume.chapters.retain(|c| dirs.contains(&c.source));
    volume.root = chapters_root;
    Ok(volume)
}

/// `"Author, Artist"`, collapsing the common case where they are one person.
fn author_line(author: &str, artist: &str) -> String {
    let (author, artist) = (author.trim(), artist.trim());
    match (author.is_empty(), artist.is_empty() || artist == author) {
        (true, true) => String::new(),
        (true, false) => artist.to_string(),
        (false, true) => author.to_string(),
        (false, false) => format!("{author}, {artist}"),
    }
}

/// FNV-1a over 128 bits, formatted as a UUID. Not cryptographic; it only has to
/// be deterministic so the same volume keeps the same identity.
fn stable_id(seed: &str) -> String {
    let mut h: u128 = 0xcbf2_9ce4_8422_2325;
    for b in seed.as_bytes() {
        h ^= *b as u128;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let hex = format!("{h:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_person_drawing_and_writing_is_named_once() {
        assert_eq!(author_line("Nishi Osamu", "Nishi Osamu"), "Nishi Osamu");
        assert_eq!(author_line("Nishi Osamu", ""), "Nishi Osamu");
    }

    #[test]
    fn a_writer_and_an_artist_are_both_credited() {
        assert_eq!(
            author_line("Nishi Osamu", "Usazaki Shiro"),
            "Nishi Osamu, Usazaki Shiro"
        );
    }

    #[test]
    fn volume_identity_is_stable_and_distinct_per_volume() {
        assert_eq!(stable_id("1|3"), stable_id("1|3"));
        assert_ne!(stable_id("1|3"), stable_id("1|4"));
    }
}
