//! Commands for the folder-in, file-out path: scan a folder, preview it, export
//! it. Thin translation over `mangalize-core`; no pipeline logic lives here.

use std::path::PathBuf;

use mangalize_core::project::Volume;
use mangalize_core::{scan_volume, writers};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::thumbs;

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
pub async fn scan(path: String) -> Result<Volume, String> {
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
pub async fn thumbnail(
    app: AppHandle,
    path: String,
    max: u32,
) -> Result<tauri::ipc::Response, String> {
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
pub async fn build(
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
pub fn suggest_filename(volume: Volume, format: Format) -> String {
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
