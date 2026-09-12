//! The records the library stores, as the UI sees them.
//!
//! Every type here crosses the Tauri IPC boundary, so they are plain data with
//! serde derives and no borrowed fields.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Row id of a series. A newtype so it cannot be mixed up with a chapter id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SeriesId(pub i64);

/// A series the user has added, as stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Series {
    pub id: SeriesId,
    /// Where the metadata came from, e.g. `"mangadex"`. `None` for hand-entered.
    pub source: Option<String>,
    pub source_id: Option<String>,
    pub title: String,
    pub title_romaji: Option<String>,
    pub title_native: Option<String>,
    pub author: String,
    pub artist: String,
    pub description: String,
    pub year: Option<u32>,
    pub status: Option<String>,
    pub language: String,
    pub direction: String,
    pub site_url: Option<String>,
    /// Absolute path to the series folder inside the library.
    pub folder: PathBuf,
    /// Absolute path to the series cover, when one has been downloaded.
    pub cover_path: Option<PathBuf>,
    /// Unix seconds.
    pub added_at: i64,
    /// When the published layout was last pulled. `None` means never.
    pub synced_at: Option<i64>,
    /// Chapters present on disk, and chapters known to exist.
    pub have_chapters: u32,
    pub known_chapters: u32,
}

/// What to write when adding a series. Mirrors what a metadata search returns,
/// but the library deliberately does not depend on the crate that produced it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewSeries {
    pub source: Option<String>,
    pub source_id: Option<String>,
    pub title: String,
    pub title_romaji: Option<String>,
    pub title_native: Option<String>,
    pub author: String,
    pub artist: String,
    pub description: String,
    pub year: Option<u32>,
    pub status: Option<String>,
    pub site_url: Option<String>,
}

/// A volume of a series as published, plus what we hold of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VolumeStatus {
    /// Volume label as published, e.g. `"1"`. Not always a number.
    pub number: String,
    pub cover_url: Option<String>,
    pub cover_path: Option<PathBuf>,
    pub chapters: Vec<ChapterStatus>,
}

impl VolumeStatus {
    pub fn have(&self) -> usize {
        self.chapters.iter().filter(|c| c.downloaded()).count()
    }

    /// True when every chapter of this volume is on disk, so it can be built.
    pub fn complete(&self) -> bool {
        !self.chapters.is_empty() && self.have() == self.chapters.len()
    }
}

/// One chapter: known to exist, and either downloaded or not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChapterStatus {
    /// Chapter label as published, e.g. `"7"` or `"7.5"`.
    pub number: String,
    pub title: Option<String>,
    /// The metadata source's id for this chapter, when it has one. Present means
    /// the pages can be fetched from the source directly.
    pub source_id: Option<String>,
    /// The source indexes it but cannot serve the images, so a URL is needed.
    pub unavailable: bool,
    /// Zero-based page the reader was last on.
    pub last_page: u32,
    /// When the chapter was finished. `None` means it was not.
    pub read_at: Option<i64>,
    /// When it was last opened, finished or not. This is what history shows.
    pub opened_at: Option<i64>,
    /// Absolute path to the chapter's images. `None` means we do not have it.
    pub folder: Option<PathBuf>,
    pub page_count: u32,
    /// The URL the pages were pulled from, kept so a bad rip can be traced.
    pub source_url: Option<String>,
    pub downloaded_at: Option<i64>,
}

impl ChapterStatus {
    pub fn downloaded(&self) -> bool {
        self.folder.is_some()
    }
}

/// A published volume and its chapters, handed in after a metadata lookup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishedVolume {
    pub number: String,
    pub cover_url: Option<String>,
    pub chapters: Vec<PublishedChapter>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishedChapter {
    pub number: String,
    pub title: Option<String>,
    /// The source's own id, which is what fetching pages from it needs.
    pub source_id: Option<String>,
    /// The source lists the chapter but cannot serve its images.
    pub unavailable: bool,
}

/// One entry in the reading history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub series_id: SeriesId,
    pub series_title: String,
    pub cover_path: Option<PathBuf>,
    pub chapter: String,
    pub last_page: u32,
    pub page_count: u32,
    pub opened_at: i64,
    pub finished: bool,
}

/// What changed when a published layout was merged in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncReport {
    pub volumes: usize,
    pub chapters_added: usize,
    /// Chapters we hold on disk that the published layout no longer lists.
    /// Kept, never deleted — the user's files outrank a crowd-sourced index.
    pub orphaned: usize,
}
