//! Commands for reading a chapter, downloaded or not.
//!
//! Two sources, one reader. A chapter in the library is read from disk and works
//! with no network at all. A chapter that is only browsed is streamed from the
//! source a page at a time, which is what makes sampling a series possible
//! without committing a few hundred megabytes to it first.
//!
//! Both go through a disk cache at reading quality and a bounded size, so the
//! first pass over a chapter pays for decoding and fetching, and every pass
//! afterwards pays for neither. For streamed pages that cache is keyed on the
//! image rather than the URL, because the server handing it out changes.

use std::path::PathBuf;

use mangalize_library::{ChapterStatus, HistoryEntry, Library, SeriesId};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::settings;
use crate::thumbs;
use crate::util::blocking;

/// Page URLs for a chapter read straight from the source.
///
/// An empty `pages` with `external_url` set is not a failure — it is the source
/// saying it indexes the chapter but the publisher hosts it. The reader shows
/// that as a destination rather than an error.
#[derive(Serialize)]
pub struct OnlineChapter {
    pub pages: Vec<String>,
    pub external_url: Option<String>,
    /// Ready to show. Empty when the pages came back fine.
    pub message: Option<String>,
}

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

/// Resolve a chapter's page URLs without downloading anything.
///
/// The image server is chosen per request and its address expires, so this is
/// called when the chapter is opened rather than cached.
#[tauri::command]
pub async fn reader_online_chapter(
    source: mangalize_meta::Source,
    chapter_id: String,
) -> Result<OnlineChapter, String> {
    blocking(move || {
        use mangalize_meta::mangadex::{unhosted_message, ChapterImages};

        Ok(match mangalize_meta::chapter_images(source, &chapter_id)? {
            ChapterImages::Hosted(pages) => OnlineChapter {
                pages,
                external_url: None,
                message: None,
            },
            ChapterImages::External(url) => OnlineChapter {
                pages: Vec::new(),
                message: Some(unhosted_message(url.as_deref())),
                external_url: url,
            },
        })
    })
    .await
}

/// One page fetched from the source, decoded, bounded and cached.
#[tauri::command]
pub async fn reader_remote_page(
    app: AppHandle,
    url: String,
    max: u32,
) -> Result<tauri::ipc::Response, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("online-pages");

    blocking(move || {
        let cached = cache_dir.join(format!("{:016x}-{max}.jpg", stable_key(&url)));
        if let Ok(bytes) = std::fs::read(&cached) {
            return Ok(tauri::ipc::Response::new(bytes));
        }

        let started = std::time::Instant::now();
        let fetched = mangalize_fetch::download::fetch_image(&url, None);
        let millis = started.elapsed().as_millis() as u64;

        // Tell the volunteer network how its server did, either way. See
        // `mangalize_meta::report_page_fetch`.
        let bytes = match &fetched {
            Ok((bytes, _)) => bytes.len(),
            Err(_) => 0,
        };
        mangalize_meta::report_page_fetch(&url, fetched.is_ok(), false, bytes, millis);

        let (raw, _) = fetched?;
        let page = image::load_from_memory(&raw)?.thumbnail(max, max * 3);

        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(
            std::io::Cursor::new(&mut out),
            thumbs::READING_QUALITY,
        )
        .encode_image(&page.to_rgb8())?;

        // Best effort: a cache write failing must not fail the read.
        if std::fs::create_dir_all(&cache_dir).is_ok() {
            let _ = std::fs::write(&cached, &out);
        }
        Ok(tauri::ipc::Response::new(out))
    })
    .await
}

/// A cache key that survives the server changing.
///
/// MangaDex@Home hands out a different host on every request, so hashing the
/// whole URL would miss every time and re-download a page the moment you turned
/// back to it. The path — `/data/<hash>/<file>` — identifies the image itself.
fn stable_key(url: &str) -> u64 {
    let path = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .and_then(|rest| rest.find('/').map(|i| &rest[i..]))
        .unwrap_or(url);

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
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
