//! Commands for online metadata lookup. Always user-initiated.

use mangalize_meta::{BrowsePage, BrowseQuery, SeriesMatch, Source, Tag, VolumeChapters, VolumeCover};
use tauri::{AppHandle, Manager};

use crate::util::blocking;

/// Search public manga databases for a series.
#[tauri::command]
pub async fn search_series(query: String) -> Result<Vec<SeriesMatch>, String> {
    blocking(move || mangalize_meta::search(&query, 8)).await
}

/// Browse the catalogue by ordering and filters, with or without a search term.
#[tauri::command]
pub async fn browse_series(query: BrowseQuery) -> Result<BrowsePage, String> {
    blocking(move || mangalize_meta::browse(&query)).await
}

/// Every tag a series can carry, for the filter picker.
///
/// Effectively static, so the frontend asks once per session rather than per
/// keystroke.
#[tauri::command]
pub async fn mangadex_tags() -> Result<Vec<Tag>, String> {
    blocking(mangalize_meta::tags).await
}

/// Every published volume cover for a series.
#[tauri::command]
pub async fn series_covers(source: Source, id: String) -> Result<Vec<VolumeCover>, String> {
    blocking(move || mangalize_meta::volume_covers(source, &id)).await
}

/// The published volume-to-chapter layout, for checking a folder against it.
#[tauri::command]
pub async fn series_chapters(source: Source, id: String) -> Result<Vec<VolumeChapters>, String> {
    blocking(move || mangalize_meta::volume_chapters(source, &id)).await
}

/// Download a cover and return its local path.
///
/// Covers are written into the app cache rather than next to the volume: they
/// are replaceable, and the source folder belongs to the user.
#[tauri::command]
pub async fn save_cover(app: AppHandle, url: String) -> Result<String, String> {
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
