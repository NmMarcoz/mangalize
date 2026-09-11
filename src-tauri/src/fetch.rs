//! Commands for pulling a chapter's images off a page the user pasted.
//!
//! Progress is emitted as events rather than returned, because measuring twenty
//! images and downloading them are both long enough that a frozen dialog would
//! look broken.

use std::path::PathBuf;

use mangalize_fetch::{Candidate, Extraction};
use mangalize_library::{ChapterStatus, Library, SeriesId};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

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
