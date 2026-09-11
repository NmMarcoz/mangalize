//! Commands over the stored library. Translation only: every decision about
//! what a library *is* lives in `mangalize-library`.

use std::path::PathBuf;

use anyhow::Result;
use mangalize_core::project::Volume;
use mangalize_library::model::{NewSeries, PublishedChapter, PublishedVolume};
use mangalize_library::{ChapterStatus, Library, Series, SeriesId, SyncReport, VolumeStatus};
use mangalize_meta::{SeriesMatch, Source};
use tauri::AppHandle;

use crate::settings;
use crate::util::blocking;

/// Open the library for one request.
///
/// Opening per call rather than holding a connection in app state keeps every
/// command a plain blocking job with no shared mutable state to reason about;
/// SQLite makes this cheap.
fn open(app: &AppHandle) -> Result<Library> {
    Library::open(settings::library_root(app)?)
}

#[tauri::command]
pub async fn library_root(app: AppHandle) -> Result<String, String> {
    blocking(move || {
        let root = settings::library_root(&app)?;
        // Opening creates the folder, so the path shown is always a real one.
        Library::open(&root)?;
        Ok(root.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn set_library_root(app: AppHandle, path: String) -> Result<String, String> {
    blocking(move || {
        let root = PathBuf::from(path);
        Library::open(&root)?;
        settings::set_library_root(&app, root.clone())?;
        Ok(root.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn library_series(app: AppHandle) -> Result<Vec<Series>, String> {
    blocking(move || open(&app)?.all_series()).await
}

/// Add a search result to the library, then pull its published layout and cover.
///
/// All three happen together because a series with no layout cannot answer the
/// question the library exists to answer — which chapters am I missing.
#[tauri::command]
pub async fn library_add_series(app: AppHandle, series: SeriesMatch) -> Result<Series, String> {
    blocking(move || {
        let mut library = open(&app)?;
        let added = library.add_series(NewSeries {
            source: Some(source_name(series.source).to_string()),
            source_id: Some(series.id.clone()),
            title: series.display_title().to_string(),
            title_romaji: series.title_romaji.clone(),
            title_native: series.title_native.clone(),
            author: series.author.clone().unwrap_or_default(),
            artist: series.artist.clone().unwrap_or_default(),
            description: series.description.clone().unwrap_or_default(),
            year: series.year,
            status: series.status.clone(),
            site_url: series.site_url.clone(),
        })?;

        // Best effort from here: a series in the library with no layout yet is
        // recoverable with the Refresh button, a failed add is not.
        let _ = pull_layout(&mut library, added.id, series.source, &series.id);
        if let Some(url) = &series.thumbnail_url {
            if let Ok(bytes) = mangalize_meta::download_image(url) {
                let _ = library.set_cover(added.id, &bytes);
            }
        }

        library.series(added.id)
    })
    .await
}

/// Re-pull the published layout for a series.
#[tauri::command]
pub async fn library_sync_series(app: AppHandle, id: i64) -> Result<SyncReport, String> {
    blocking(move || {
        let mut library = open(&app)?;
        let series = library.series(SeriesId(id))?;
        let (source, source_id) = match (&series.source, &series.source_id) {
            (Some(source), Some(source_id)) => (parse_source(source)?, source_id.clone()),
            _ => anyhow::bail!("{} was added by hand; there is no source to sync from", series.title),
        };
        pull_layout(&mut library, series.id, source, &source_id)
    })
    .await
}

#[tauri::command]
pub async fn library_remove_series(
    app: AppHandle,
    id: i64,
    delete_files: bool,
) -> Result<(), String> {
    blocking(move || open(&app)?.remove_series(SeriesId(id), delete_files)).await
}

#[tauri::command]
pub async fn library_update_series(
    app: AppHandle,
    id: i64,
    title: String,
    author: String,
    description: String,
    language: String,
    direction: String,
) -> Result<Series, String> {
    blocking(move || {
        open(&app)?.update_series(SeriesId(id), &title, &author, &description, &language, &direction)
    })
    .await
}

#[tauri::command]
pub async fn library_volumes(app: AppHandle, id: i64) -> Result<Vec<VolumeStatus>, String> {
    blocking(move || open(&app)?.volumes(SeriesId(id))).await
}

/// Download any published volume covers we do not already hold.
///
/// Returns how many were fetched. Individual failures are skipped rather than
/// failing the call: a missing cover is a cosmetic problem, and retrying is just
/// opening the series again.
#[tauri::command]
pub async fn library_download_covers(app: AppHandle, id: i64) -> Result<usize, String> {
    blocking(move || {
        let library = open(&app)?;
        let series = SeriesId(id);
        let mut fetched = 0;

        for (number, url) in library.volumes_missing_covers(series)? {
            if let Ok(bytes) = mangalize_meta::download_image(&url) {
                if library.set_volume_cover(series, &number, &bytes).is_ok() {
                    fetched += 1;
                }
            }
        }
        Ok(fetched)
    })
    .await
}

/// Hand a stored volume to the editor the folder path already uses.
#[tauri::command]
pub async fn library_build_volume(
    app: AppHandle,
    id: i64,
    volume: String,
) -> Result<Volume, String> {
    blocking(move || open(&app)?.build_volume(SeriesId(id), &volume)).await
}

#[tauri::command]
pub async fn library_delete_chapter(
    app: AppHandle,
    id: i64,
    chapter: String,
) -> Result<ChapterStatus, String> {
    blocking(move || {
        let library = open(&app)?;
        library.delete_chapter(SeriesId(id), &chapter)?;
        library.chapter(SeriesId(id), &chapter)
    })
    .await
}

/// Fetch the published layout and covers, and merge them in.
fn pull_layout(
    library: &mut Library,
    id: SeriesId,
    source: Source,
    source_id: &str,
) -> Result<SyncReport> {
    let published = mangalize_meta::volume_chapters(source, source_id)?;
    let covers = mangalize_meta::volume_covers(source, source_id)?;

    let volumes: Vec<PublishedVolume> = published
        .into_iter()
        .map(|v| PublishedVolume {
            cover_url: covers
                .iter()
                .find(|c| c.volume.as_deref() == Some(v.volume.as_str()))
                .map(|c| c.url.clone()),
            chapters: v
                .chapters
                .into_iter()
                .map(|number| PublishedChapter { number, title: None })
                .collect(),
            number: v.volume,
        })
        .collect();

    library.sync_layout(id, &volumes)
}

fn source_name(source: Source) -> &'static str {
    match source {
        Source::MangaDex => "mangadex",
        Source::Kitsu => "kitsu",
    }
}

fn parse_source(name: &str) -> Result<Source> {
    match name {
        "mangadex" => Ok(Source::MangaDex),
        "kitsu" => Ok(Source::Kitsu),
        other => anyhow::bail!("unknown metadata source {other:?}"),
    }
}
