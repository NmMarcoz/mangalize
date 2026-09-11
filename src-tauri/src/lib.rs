//! Tauri bindings. Every command is a thin translation between the frontend and
//! `mangalize-core`; no pipeline logic lives here.

mod thumbs;

use std::path::PathBuf;

use mangalize_core::project::Volume;
use mangalize_core::{scan_volume, writers};
use mangalize_meta::{SeriesMatch, Source, VolumeChapters, VolumeCover};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Epub,
    Cbz,
}

impl Format {
    fn extension(self) -> &'static str {
        match self {
            Format::Epub => "epub",
            Format::Cbz => "cbz",
        }
    }
}

#[derive(Serialize, Clone)]
struct BuildProgress {
    done: usize,
    total: usize,
}

#[derive(Serialize)]
pub struct BuildReport {
    path: String,
    bytes: u64,
    pages: usize,
}

/// Scan a folder into an editable volume.
///
/// Dropping a loose image rather than its folder is an easy mistake to make, so
/// a file path is treated as a request to scan the folder containing it.
#[tauri::command]
async fn scan(path: String) -> Result<Volume, String> {
    let mut root = PathBuf::from(path);
    if root.is_file() {
        if let Some(parent) = root.parent() {
            root = parent.to_path_buf();
        }
    }

    // Probing a few hundred image headers is slow enough to block the UI thread.
    tauri::async_runtime::spawn_blocking(move || scan_volume(&root).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

/// A resized JPEG preview of one page, cached on disk between runs.
#[tauri::command]
async fn thumbnail(app: AppHandle, path: String, max: u32) -> Result<tauri::ipc::Response, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");

    tauri::async_runtime::spawn_blocking(move || {
        thumbs::get(&cache_dir, PathBuf::from(path), max)
            .map(tauri::ipc::Response::new)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write the volume to disk, emitting `build-progress` as pages are encoded.
#[tauri::command]
async fn build(
    app: AppHandle,
    volume: Volume,
    out: String,
    format: Format,
) -> Result<BuildReport, String> {
    let out = PathBuf::from(out);
    let pages = volume.total_included();

    tauri::async_runtime::spawn_blocking(move || {
        // Emitting on every page would flood the IPC channel on a long volume;
        // one event per page is fine at these counts but we coalesce anyway.
        let mut last = 0usize;
        let mut progress = |done: usize, total: usize| {
            if done == total || done.saturating_sub(last) >= 4 {
                last = done;
                let _ = app.emit("build-progress", BuildProgress { done, total });
            }
        };

        let result = match format {
            Format::Epub => writers::epub::write_with_progress(&volume, &out, &mut progress),
            Format::Cbz => writers::cbz::write_with_progress(&volume, &out, &mut progress),
        };
        result.map_err(|e| format!("{e:#}"))?;

        let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        Ok(BuildReport {
            path: out.to_string_lossy().into_owned(),
            bytes,
            pages,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A filename to pre-fill the save dialog with, e.g. `Itch The Witch v01.epub`.
#[tauri::command]
fn suggest_filename(volume: Volume, format: Format) -> String {
    let m = &volume.metadata;
    let series = if m.series.is_empty() {
        "volume".to_string()
    } else {
        m.series.clone()
    };
    let stem = match m.volume {
        Some(v) => format!("{series} v{v:02}"),
        None => series,
    };
    // Strip characters that are illegal in filenames on at least one target OS.
    let safe: String = stem
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    format!("{}.{}", safe.trim(), format.extension())
}

/* ------------------------------------------------------------ metadata lookup */

/// Search public manga databases for a series.
#[tauri::command]
async fn search_series(query: String) -> Result<Vec<SeriesMatch>, String> {
    blocking(move || mangalize_meta::search(&query, 8)).await
}

/// Every published volume cover for a series.
#[tauri::command]
async fn series_covers(source: Source, id: String) -> Result<Vec<VolumeCover>, String> {
    blocking(move || mangalize_meta::volume_covers(source, &id)).await
}

/// The published volume-to-chapter layout, for checking a folder against it.
#[tauri::command]
async fn series_chapters(source: Source, id: String) -> Result<Vec<VolumeChapters>, String> {
    blocking(move || mangalize_meta::volume_chapters(source, &id)).await
}

/// Download a cover and return its local path.
///
/// Covers are written into the app cache rather than next to the volume: they
/// are replaceable, and the source folder belongs to the user.
#[tauri::command]
async fn save_cover(app: AppHandle, url: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("covers");

    blocking(move || {
        let bytes = mangalize_meta::download_image(&url)?;
        std::fs::create_dir_all(&dir)?;

        // Name by content so re-picking the same cover reuses the same file.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for b in &bytes {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x1000_0000_01b3);
        }
        let path = dir.join(format!("{hash:016x}.jpg"));
        if !path.exists() {
            std::fs::write(&path, &bytes)?;
        }
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

/// Run a fallible blocking job on the pool, flattening both error kinds into
/// the string the frontend expects.
async fn blocking<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || job().map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan,
            thumbnail,
            build,
            suggest_filename,
            search_series,
            series_covers,
            series_chapters,
            save_cover
        ])
        .run(tauri::generate_context!())
        .expect("error while running mangalize");
}
