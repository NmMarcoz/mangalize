//! Commands for pulling a chapter's images off a page the user pasted.
//!
//! Progress is emitted as events rather than returned, because measuring twenty
//! images and downloading them are both long enough that a frozen dialog would
//! look broken.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mangalize_fetch::{BatchItem, BatchPlan, Candidate, Extraction};
use mangalize_library::{ChapterStatus, Library, SeriesId};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::settings;
use crate::util::blocking;

/// Emitted while a batch of URLs is being measured or downloaded.
#[derive(Clone, Serialize)]
struct FetchProgress {
    stage: &'static str,
    done: usize,
    total: usize,
}

/// Read a chapter page and report the images in its markup, measured.
///
/// An empty list is the expected answer for a page that builds itself in
/// JavaScript, and is the frontend's cue to offer the render-and-harvest path.
#[tauri::command]
pub async fn extract_chapter(app: AppHandle, url: String) -> Result<Extraction, String> {
    blocking(move || {
        mangalize_fetch::extract_page(&url, &mut emit(&app, "measuring"))
    })
    .await
}

/// Measure a list of image URLs that came from somewhere other than markup.
#[tauri::command]
pub async fn measure_images(
    app: AppHandle,
    urls: Vec<String>,
    referer: Option<String>,
) -> Result<Vec<Candidate>, String> {
    blocking(move || {
        Ok(mangalize_fetch::measure(
            &urls,
            referer.as_deref(),
            &mut emit(&app, "measuring"),
        ))
    })
    .await
}

/// A downscaled preview of a remote image, for the picker grid.
///
/// Fetched through the backend rather than by pointing an `<img>` at the URL:
/// the picker needs the same `Referer` the download will use, or every hotlink
/// protected host shows a broken image and the user cannot tell which pages
/// they are choosing.
#[tauri::command]
pub async fn preview_image(
    app: AppHandle,
    url: String,
    referer: Option<String>,
    max: u32,
) -> Result<tauri::ipc::Response, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("previews");

    blocking(move || {
        let cached = cache_dir.join(format!("{:016x}-{max}.jpg", fnv1a(url.as_bytes())));
        if let Ok(bytes) = std::fs::read(&cached) {
            return Ok(tauri::ipc::Response::new(bytes));
        }

        let (bytes, _) = mangalize_fetch::download::fetch_image(&url, referer.as_deref())?;
        let thumb = image::load_from_memory(&bytes)?.thumbnail(max, max * 3);

        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::Cursor::new(&mut out), 78)
            .encode_image(&thumb.to_rgb8())?;

        // Best effort: a cache write failing must not fail the request.
        if std::fs::create_dir_all(&cache_dir).is_ok() {
            let _ = std::fs::write(&cached, &out);
        }
        Ok(tauri::ipc::Response::new(out))
    })
    .await
}

/// Download the chosen images into a chapter of the library.
#[tauri::command]
pub async fn download_chapter(
    app: AppHandle,
    id: i64,
    chapter: String,
    urls: Vec<String>,
    referer: Option<String>,
    source_url: Option<String>,
) -> Result<ChapterStatus, String> {
    blocking(move || {
        if urls.is_empty() {
            anyhow::bail!("no pages were selected");
        }

        let library = Library::open(settings::library_root(&app)?)?;
        let series = SeriesId(id);
        let dest = library.chapter_dir(series, &chapter)?;

        // A re-download replaces the chapter rather than merging with it, or a
        // shorter second rip would leave stale pages from the first behind.
        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }

        let written = mangalize_fetch::download_pages(
            &urls,
            &dest,
            referer.as_deref(),
            &mut emit(&app, "downloading"),
        )?;

        library.record_chapter(
            series,
            &chapter,
            written.len() as u32,
            source_url.as_deref(),
        )
    })
    .await
}

/// Download a chapter straight from the metadata source.
///
/// Much better than reading a page when the source will do it: no rendering, no
/// guessing which `<img>` is a page, and the order is the publisher's own. Only
/// possible when a sync recorded the source's chapter id.
#[tauri::command]
pub async fn download_chapter_from_source(
    app: AppHandle,
    id: i64,
    chapter: String,
) -> Result<ChapterStatus, String> {
    blocking(move || {
        let library = Library::open(settings::library_root(&app)?)?;
        let series_id = SeriesId(id);
        let series = library.series(series_id)?;
        let stored = library.chapter(series_id, &chapter)?;

        let source = match series.source.as_deref() {
            Some("mangadex") => mangalize_meta::Source::MangaDex,
            Some("kitsu") => mangalize_meta::Source::Kitsu,
            _ => anyhow::bail!("{} has no metadata source to download from", series.title),
        };
        let Some(chapter_id) = stored.source_id else {
            anyhow::bail!(
                "no source id for chapter {chapter} — refresh the series layout first"
            );
        };

        // The image server is handed out per request and expires, so this is
        // resolved immediately before downloading rather than stored.
        let pages = mangalize_meta::chapter_pages(source, &chapter_id)?;

        let dest = library.chapter_dir(series_id, &chapter)?;
        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }

        let written = mangalize_fetch::download_pages(
            &pages,
            &dest,
            None,
            &mut emit(&app, "downloading"),
        )?;

        library.record_chapter(
            series_id,
            &chapter,
            written.len() as u32,
            series.site_url.as_deref(),
        )
    })
    .await
}

/// Import a folder the user already has as a chapter of a series.
#[tauri::command]
pub async fn import_chapter(
    app: AppHandle,
    id: i64,
    chapter: String,
    folder: String,
) -> Result<ChapterStatus, String> {
    blocking(move || {
        let library = Library::open(settings::library_root(&app)?)?;
        let series = SeriesId(id);
        let source = PathBuf::from(folder);
        let dest = library.chapter_dir(series, &chapter)?;

        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }
        std::fs::create_dir_all(&dest)?;

        // Copied, never moved: the user's own folder is not ours to empty.
        let scanned = mangalize_core::scan_volume(&source)?;
        let mut count = 0usize;
        for page in scanned.included_pages() {
            let ext = page
                .path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg");
            std::fs::copy(&page.path, dest.join(format!("{:04}.{ext}", count + 1)))?;
            count += 1;
        }

        if count == 0 {
            let _ = std::fs::remove_dir_all(&dest);
            anyhow::bail!("no usable images in {}", source.display());
        }

        library.record_chapter(series, &chapter, count as u32, None)
    })
    .await
}

/* --------------------------------------------------------------- batch fetch */

/// Lets a running batch be stopped from the UI.
///
/// A batch is the one operation here long enough that the user will change their
/// mind halfway through, and abandoning the command future would not stop the
/// blocking work already on the pool.
#[derive(Default)]
pub struct BatchControl {
    cancelled: Arc<AtomicBool>,
}

/// How long to wait between chapters.
///
/// The images all come from one host, usually a small one. Downloading fifty
/// chapters back to back as fast as the pool allows is both rude and the fastest
/// way to get the user rate-limited out of their own batch.
const BETWEEN_CHAPTERS: Duration = Duration::from_millis(400);

#[derive(Clone, Serialize)]
struct BatchProgress {
    chapter: String,
    /// 1-based position of this chapter in the batch.
    index: usize,
    total: usize,
    stage: &'static str,
    done: usize,
    page_total: usize,
}

#[derive(Serialize)]
pub struct BatchFailure {
    number: String,
    error: String,
}

#[derive(Serialize)]
pub struct BatchReport {
    downloaded: Vec<String>,
    failed: Vec<BatchFailure>,
    cancelled: bool,
}

/// Fetch missing chapters straight from the metadata source.
///
/// The other batch path exists because most sites are only reachable by pasting
/// a URL and inferring the rest. When the source hosts the images itself —
/// MangaDex does, for everything it is allowed to — there is nothing to infer:
/// the library already holds a chapter id for each one.
///
/// Bounded the same way `download_batch` is: the caller passes the chapters it
/// wants, this never looks for more, and a chapter that fails is recorded while
/// the run carries on. One dead chapter must not cost the other forty.
#[tauri::command]
pub async fn download_from_source(
    app: AppHandle,
    control: State<'_, BatchControl>,
    id: i64,
    chapters: Vec<String>,
) -> Result<BatchReport, String> {
    let cancelled = control.cancelled.clone();
    cancelled.store(false, Ordering::Relaxed);

    blocking(move || {
        let library = Library::open(settings::library_root(&app)?)?;
        let series_id = SeriesId(id);
        let series = library.series(series_id)?;
        let total = chapters.len();

        let source = match series.source.as_deref() {
            Some("mangadex") => mangalize_meta::Source::MangaDex,
            Some("kitsu") => mangalize_meta::Source::Kitsu,
            _ => anyhow::bail!("{} has no metadata source to download from", series.title),
        };

        let mut downloaded = Vec::new();
        let mut failed = Vec::new();

        for (index, number) in chapters.iter().enumerate() {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(BatchReport { downloaded, failed, cancelled: true });
            }
            // The images all come from one volunteer network; the pause is the
            // same courtesy the URL batch extends to a small site.
            if index > 0 {
                std::thread::sleep(BETWEEN_CHAPTERS);
            }

            let report = |stage: &'static str, done: usize, page_total: usize| {
                let _ = app.emit(
                    "batch-progress",
                    BatchProgress {
                        chapter: number.clone(),
                        index: index + 1,
                        total,
                        stage,
                        done,
                        page_total,
                    },
                );
            };
            report("reading", 0, 0);

            match one_from_source(&app, &library, series_id, &series, source, number, &report) {
                Ok(()) => downloaded.push(number.clone()),
                Err(e) => failed.push(BatchFailure {
                    number: number.clone(),
                    error: format!("{e:#}"),
                }),
            }
        }

        Ok(BatchReport { downloaded, failed, cancelled: false })
    })
    .await
}

fn one_from_source(
    app: &AppHandle,
    library: &Library,
    series_id: SeriesId,
    series: &mangalize_library::Series,
    source: mangalize_meta::Source,
    number: &str,
    report: &dyn Fn(&'static str, usize, usize),
) -> anyhow::Result<()> {
    let stored = library.chapter(series_id, number)?;
    let Some(chapter_id) = stored.source_id else {
        anyhow::bail!("no source id for chapter {number} — refresh the series layout first");
    };

    // Handed out per request and expiring, so resolved immediately before use.
    let pages = mangalize_meta::chapter_pages(source, &chapter_id)?;
    report("downloading", 0, pages.len());

    let dest = library.chapter_dir(series_id, number)?;
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }

    let written =
        mangalize_fetch::download_pages(&pages, &dest, None, &mut emit(app, "downloading"))?;
    library.record_chapter(
        series_id,
        number,
        written.len() as u32,
        series.site_url.as_deref(),
    )?;
    Ok(())
}

/// Work out how to reach each wanted chapter from one URL the user pasted.
#[tauri::command]
pub async fn plan_batch(
    app: AppHandle,
    url: String,
    wanted: Vec<String>,
) -> Result<BatchPlan, String> {
    blocking(move || mangalize_fetch::plan_batch(&url, &wanted, &mut emit(&app, "checking"))).await
}

/// Stop the batch currently running, if any.
#[tauri::command]
pub fn cancel_batch(control: State<BatchControl>) {
    control.cancelled.store(true, Ordering::Relaxed);
}

/// Download a whole planned batch into the library.
///
/// Chapters are taken one at a time and a failure is recorded against that
/// chapter rather than ending the run: one dead page in chapter 30 should not
/// cost the user chapters 31 to 50. Where each chapter lands is decided entirely
/// by the library, so the published volume layout organises the result for free.
#[tauri::command]
pub async fn download_batch(
    app: AppHandle,
    control: State<'_, BatchControl>,
    id: i64,
    items: Vec<BatchItem>,
) -> Result<BatchReport, String> {
    let cancelled = control.cancelled.clone();
    cancelled.store(false, Ordering::Relaxed);

    blocking(move || {
        let library = Library::open(settings::library_root(&app)?)?;
        let series = SeriesId(id);
        let total = items.len();

        let mut downloaded = Vec::new();
        let mut failed = Vec::new();

        for (index, item) in items.iter().enumerate() {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(BatchReport { downloaded, failed, cancelled: true });
            }
            if index > 0 {
                std::thread::sleep(BETWEEN_CHAPTERS);
            }

            let report = |stage: &'static str, done: usize, page_total: usize| {
                let _ = app.emit(
                    "batch-progress",
                    BatchProgress {
                        chapter: item.number.clone(),
                        index: index + 1,
                        total,
                        stage,
                        done,
                        page_total,
                    },
                );
            };
            report("reading", 0, 0);

            match fetch_one(&library, series, item, &report) {
                Ok(pages) => downloaded.push(format!("{} ({pages} pages)", item.number)),
                Err(e) => failed.push(BatchFailure {
                    number: item.number.clone(),
                    error: format!("{e:#}"),
                }),
            }
        }

        Ok(BatchReport { downloaded, failed, cancelled: false })
    })
    .await
}

/// One chapter of a batch: find its pages, save them, record it.
fn fetch_one(
    library: &Library,
    series: SeriesId,
    item: &BatchItem,
    report: &dyn Fn(&'static str, usize, usize),
) -> anyhow::Result<usize> {
    // No picker here, so the size sieve does the choosing. A page that offers
    // nothing it recognises is reported rather than silently stored empty.
    let pages = mangalize_fetch::chapter_pages(&item.url, &mut |done, total| {
        report("reading", done, total)
    })?;

    if pages.is_empty() {
        anyhow::bail!("no page images found at {}", item.url);
    }

    let dest = library.chapter_dir(series, &item.number)?;
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }

    let page_total = pages.len();
    let written = mangalize_fetch::download_pages(
        &pages,
        &dest,
        Some(&item.url),
        &mut |done, _| report("downloading", done, page_total),
    )?;

    library.record_chapter(series, &item.number, written.len() as u32, Some(&item.url))?;
    Ok(written.len())
}

/// A progress callback that emits `fetch-progress`, coalesced.
fn emit<'a>(app: &'a AppHandle, stage: &'static str) -> impl FnMut(usize, usize) + 'a {
    let mut last = 0usize;
    move |done, total| {
        if done == total || done.saturating_sub(last) >= 2 {
            last = done;
            let _ = app.emit("fetch-progress", FetchProgress { stage, done, total });
        }
    }
}

/// Non-cryptographic; it only has to name a cache file deterministically.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}
