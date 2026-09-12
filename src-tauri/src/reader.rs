//! Commands for reading a downloaded chapter.
//!
//! The reader draws from the library only: these are pages already on disk, so
//! nothing here touches the network and reading works offline.
//!
//! Page bytes go through the same disk cache the grid thumbnails use, at a
//! higher quality and a larger bound. That means the first pass over a chapter
//! pays for decoding and every pass afterwards does not, which is what keeps
//! turning pages instant on a several-hundred-page volume.

use std::path::PathBuf;

use mangalize_library::{ChapterStatus, HistoryEntry, Library, SeriesId};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::settings;
use crate::thumbs;
use crate::util::blocking;

/// Everything the reader needs to open a chapter.
#[derive(Serialize)]
pub struct ReaderChapter {
    pub series_id: i64,
    pub series_title: String,
    pub number: String,
    pub title: Option<String>,
    /// `right-to-left` or `left-to-right`, from the series.
    pub direction: String,
    /// Absolute paths, in reading order.
    pub pages: Vec<String>,
    /// Zero-based page to open on.
    pub last_page: u32,
    /// Adjacent chapters that are downloaded, for moving between them.
    pub previous: Option<String>,
    pub next: Option<String>,
}

fn open(app: &AppHandle) -> anyhow::Result<Library> {
    Library::open(settings::library_root(app)?)
}

/// Open a chapter for reading.
#[tauri::command]
pub async fn reader_chapter(
    app: AppHandle,
    id: i64,
    chapter: String,
) -> Result<ReaderChapter, String> {
    blocking(move || {
        let library = open(&app)?;
        let series_id = SeriesId(id);
        let series = library.series(series_id)?;
        let stored = library.chapter(series_id, &chapter)?;

        let pages: Vec<String> = library
            .chapter_page_files(series_id, &chapter)?
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        if pages.is_empty() {
            anyhow::bail!("chapter {chapter} has no pages on disk");
        }

        let order = library.downloaded_chapter_numbers(series_id)?;
        let at = order.iter().position(|n| n == &chapter);

        Ok(ReaderChapter {
            series_id: id,
            series_title: series.title,
            direction: series.direction,
            // A position past the end would open on a blank screen; a chapter
            // can shrink if it is re-downloaded from a shorter rip.
            last_page: stored.last_page.min(pages.len().saturating_sub(1) as u32),
            pages,
            number: chapter,
            title: stored.title,
            previous: at.and_then(|i| i.checked_sub(1)).and_then(|i| order.get(i).cloned()),
            next: at.and_then(|i| order.get(i + 1).cloned()),
        })
    })
    .await
}

/// One page, decoded and bounded, from cache when it has been seen before.
#[tauri::command]
pub async fn reader_page(
    app: AppHandle,
    path: String,
    max: u32,
) -> Result<tauri::ipc::Response, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("pages");

    tauri::async_runtime::spawn_blocking(move || {
        thumbs::get(&cache_dir, PathBuf::from(path), max, thumbs::READING_QUALITY)
            .map(tauri::ipc::Response::new)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Record where the reader is.
///
/// Called often — on every page turn — so it does the least possible work and
/// never returns anything the caller has to wait for.
#[tauri::command]
pub async fn save_reading_progress(
    app: AppHandle,
    id: i64,
    chapter: String,
    page: u32,
    finished: bool,
) -> Result<(), String> {
    blocking(move || open(&app)?.save_progress(SeriesId(id), &chapter, page, finished)).await
}

#[tauri::command]
pub async fn clear_reading_progress(
    app: AppHandle,
    id: i64,
    chapter: String,
) -> Result<(), String> {
    blocking(move || open(&app)?.clear_progress(SeriesId(id), &chapter)).await
}

/// Recently opened chapters, newest first.
#[tauri::command]
pub async fn reading_history(app: AppHandle, limit: u32) -> Result<Vec<HistoryEntry>, String> {
    blocking(move || open(&app)?.history(limit.clamp(1, 200))).await
}

/// The chapter to offer as "continue reading" for a series.
#[tauri::command]
pub async fn resume_point(app: AppHandle, id: i64) -> Result<Option<ChapterStatus>, String> {
    blocking(move || open(&app)?.resume_point(SeriesId(id))).await
}
