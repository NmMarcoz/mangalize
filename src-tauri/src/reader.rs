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
    /// Where this series came from, when it came from anywhere. Enough to read
    /// the same chapter in another translation, which means streaming it — the
    /// pages on disk are in one language and cannot be swapped.
    pub source: Option<String>,
    pub series_source_id: Option<String>,
    pub language: String,
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
            series_title: series.title.clone(),
            direction: series.direction.clone(),
            // A position past the end would open on a blank screen; a chapter
            // can shrink if it is re-downloaded from a shorter rip.
            last_page: stored.last_page.min(pages.len().saturating_sub(1) as u32),
            pages,
            number: chapter,
            title: stored.title,
            previous: at.and_then(|i| i.checked_sub(1)).and_then(|i| order.get(i).cloned()),
            next: at.and_then(|i| order.get(i + 1).cloned()),
            source: series.source,
            series_source_id: series.source_id,
            language: series.language,
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

/// Note that a series is being read from its source, and give back the row to
/// record progress against.
///
/// History is meant to be the same question whatever the source, and it cannot
/// be if only downloaded chapters have somewhere to record it. So a streamed
/// series gets a row — but an *unshelved* one: it shows up in history and can be
/// resumed, while the library grid stays what the user chose to put there.
/// Adding it properly later finds the same row and shelves it.
/// One chapter of a translation, as the reader needs it: an id to open and a
/// number to match against.
#[derive(Serialize)]
pub struct OnlineChapterRef {
    pub id: String,
    pub number: String,
}

/// Every chapter of a series in one translation, in reading order.
///
/// The reader needs this for two things that look different and are the same
/// question. Moving to the next chapter needs to know what comes next, and
/// history reopening a streamed chapter has to rebuild that list from nothing.
/// Switching translation is the third: the chapter *numbers* line up across
/// languages even though the ids do not, so the same list answers "where is
/// chapter 6 in Portuguese".
#[tauri::command]
pub async fn reader_online_chapters(
    source: mangalize_meta::Source,
    series_source_id: String,
    language: Option<String>,
) -> Result<Vec<OnlineChapterRef>, String> {
    blocking(move || {
        let volumes = mangalize_meta::volume_chapters_in(
            source,
            &series_source_id,
            language.as_deref().filter(|l| !l.is_empty()),
        )?;
        Ok(volumes
            .into_iter()
            .flat_map(|v| v.chapters)
            .filter(|c| !c.unavailable)
            .filter_map(|c| {
                c.id.map(|id| OnlineChapterRef {
                    id,
                    number: c.number,
                })
            })
            .collect())
    })
    .await
}

/// What the reader knows about a chapter it is streaming.
///
/// A struct rather than seven arguments: they travel together, and the caller
/// already sends them as one object.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineRead {
    source: String,
    series_source_id: String,
    title: String,
    cover_url: Option<String>,
    chapter: String,
    chapter_source_id: String,
    /// How long the chapter is, so history can say "page 4 of 37".
    pages: u32,
    /// Which translation is being read. Recorded so that coming back to this
    /// series later opens the language it was started in rather than a default.
    language: Option<String>,
}

#[tauri::command]
pub async fn reader_track_online(app: AppHandle, read: OnlineRead) -> Result<i64, String> {
    blocking(move || {
        let mut library = open(&app)?;
        let series = library.record_unshelved_series(mangalize_library::NewSeries {
            source: Some(read.source),
            source_id: Some(read.series_source_id),
            title: read.title,
            ..Default::default()
        })?;

        // Only for a series that is not on the shelf: one the user added has a
        // language they chose, and reading it must not quietly change that.
        if !series.shelved {
            if let Some(language) = read.language.as_deref().filter(|l| !l.is_empty()) {
                if language != series.language {
                    library.update_series(
                        series.id,
                        &series.title,
                        &series.author,
                        &series.description,
                        language,
                        &series.direction,
                    )?;
                }
            }
        }

        library.record_streamed_chapter(
            series.id,
            &read.chapter,
            Some(&read.chapter_source_id),
            read.pages,
        )?;

        // History is a wall of covers; one without art is hard to pick out of a
        // list. Fetched once, and a failure here is not worth refusing to read
        // over.
        if series.cover_path.is_none() {
            if let Some(url) = read.cover_url.as_deref() {
                if let Ok(bytes) = mangalize_meta::download_image(url) {
                    let _ = library.set_cover(series.id, &bytes);
                }
            }
        }

        Ok(series.id.0)
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

/// What was read of one series, newest first.
#[tauri::command]
pub async fn series_history(
    app: AppHandle,
    id: i64,
    limit: u32,
) -> Result<Vec<HistoryEntry>, String> {
    blocking(move || open(&app)?.series_history(SeriesId(id), limit)).await
}

/// Forget everything that was read. No file is touched.
#[tauri::command]
pub async fn clear_history(app: AppHandle) -> Result<(), String> {
    blocking(move || open(&app)?.clear_history()).await
}

/// Forget everything that was read of one series.
#[tauri::command]
pub async fn clear_series_history(app: AppHandle, id: i64) -> Result<(), String> {
    blocking(move || open(&app)?.clear_series_history(SeriesId(id))).await
}

/// The chapter to offer as "continue reading" for a series.
#[tauri::command]
pub async fn resume_point(app: AppHandle, id: i64) -> Result<Option<ChapterStatus>, String> {
    blocking(move || open(&app)?.resume_point(SeriesId(id))).await
}
