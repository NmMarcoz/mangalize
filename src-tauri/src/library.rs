//! Commands over the stored library. Translation only: every decision about
//! what a library *is* lives in `mangalize-library`.

use std::path::PathBuf;

use anyhow::Result;
use mangalize_core::project::Volume;
use mangalize_library::model::{NewSeries, PublishedChapter, PublishedVolume};
use mangalize_library::{ChapterStatus, Library, Series, SeriesId, SyncReport, VolumeStatus};
use mangalize_meta::{SeriesMatch, Source};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use mangalize_core::writers;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::settings;
use crate::util::blocking;
use crate::volume::{apply_spread_policy, build_path, Format};

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
pub async fn library_add_series(
    app: AppHandle,
    series: SeriesMatch,
    language: Option<String>,
) -> Result<Series, String> {
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
            // Carried over so the library can be filtered by the same things
            // Explore is browsed by, without going back to the network.
            tags: series.tags.iter().map(|t| t.name.clone()).collect(),
            content_rating: series.content_rating.clone(),
        })?;

        // The translation chosen when adding decides which chapters the library
        // tracks, and doubles as the language written into an exported EPUB.
        if let Some(language) = language.as_deref().filter(|l| !l.is_empty()) {
            let _ = library.update_series(
                added.id,
                &added.title,
                &added.author,
                &added.description,
                language,
                &added.direction,
            );
        }

        // Best effort from here: a series in the library with no layout yet is
        // recoverable with the Refresh button, a failed add is not.
        let _ = pull_layout(
            &mut library,
            added.id,
            series.source,
            &series.id,
            language.as_deref(),
        );
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
        // Whatever translation the series was added in; syncing must not
        // silently widen it back to every language.
        let language = series.language.clone();
        pull_layout(
            &mut library,
            series.id,
            source,
            &source_id,
            Some(language.as_str()),
        )
    })
    .await
}

/// Which translations the source has for a series already in the library.
///
/// Asked of the source rather than remembered: a series picks up translations
/// over time, and the list is only ever looked at when someone is about to
/// choose from it.
#[tauri::command]
pub async fn library_languages(app: AppHandle, id: i64) -> Result<Vec<String>, String> {
    blocking(move || {
        let library = open(&app)?;
        let series = library.series(SeriesId(id))?;
        let (Some(source), Some(source_id)) = (&series.source, &series.source_id) else {
            return Ok(Vec::new());
        };
        match parse_source(source)? {
            Source::MangaDex => Ok(mangalize_meta::mangadex::manga(source_id)?.available_languages),
            // Kitsu indexes no chapters, so it offers no translations either.
            Source::Kitsu => Ok(Vec::new()),
        }
    })
    .await
}

/// Read the series in a different translation.
///
/// The layout is re-pulled straight away, because the chapter numbering is what
/// changes: translations disagree about where volumes end and which chapters
/// exist. Downloaded chapters are kept — `sync_layout` never deletes — so this
/// is a change of what the library is *tracking*, not of what it holds.
#[tauri::command]
pub async fn library_set_language(
    app: AppHandle,
    id: i64,
    language: String,
) -> Result<SyncReport, String> {
    blocking(move || {
        let mut library = open(&app)?;
        let series = library.series(SeriesId(id))?;
        let (source, source_id) = match (&series.source, &series.source_id) {
            (Some(source), Some(source_id)) => (parse_source(source)?, source_id.clone()),
            _ => anyhow::bail!("{} has no source to read from", series.title),
        };

        library.update_series(
            series.id,
            &series.title,
            &series.author,
            &series.description,
            &language,
            &series.direction,
        )?;

        pull_layout(&mut library, series.id, source, &source_id, Some(&language))
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
    blocking(move || {
        let settings = settings::load(&app)?;
        let mut built = Library::open(&settings.library_root)?.build_volume(SeriesId(id), &volume)?;
        apply_spread_policy(&mut built, settings.split_spreads);
        Ok(built)
    })
    .await
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

/* ------------------------------------------------------------ batch building */

/// Lets a running batch build be stopped from the UI.
#[derive(Default)]
pub struct BuildControl {
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
struct BuildBatchProgress {
    volume: String,
    /// 1-based position in the batch.
    index: usize,
    total: usize,
    done: usize,
    pages: usize,
}

/// What the UI is told about a volume that was just written. Distinct from the
/// library's `BuiltVolume`, which is what gets remembered about it afterwards.
#[derive(Serialize)]
pub struct BuiltVolume {
    volume: String,
    path: String,
    bytes: u64,
    pages: usize,
}

#[derive(Serialize)]
pub struct BuildBatchReport {
    built: Vec<BuiltVolume>,
    failed: Vec<BuildFailure>,
    cancelled: bool,
}

#[derive(Serialize)]
pub struct BuildFailure {
    volume: String,
    error: String,
}

#[tauri::command]
pub fn cancel_build(control: State<BuildControl>) {
    control.cancelled.store(true, Ordering::Relaxed);
}

/// Build several stored volumes in one go.
///
/// Assembling and writing happens entirely in the backend: shipping a `Volume`
/// per item across IPC just to send it straight back would move a lot of page
/// metadata for nothing.
///
/// A volume that fails is recorded and the batch carries on. Twelve volumes
/// should not be lost because the fourth has an unreadable page.
///
/// `out_dir` overrides the configured output folder, which is what "Build as…"
/// passes.
#[tauri::command]
pub async fn build_library_volumes(
    app: AppHandle,
    control: State<'_, BuildControl>,
    id: i64,
    volumes: Vec<String>,
    format: Format,
    out_dir: Option<String>,
) -> Result<BuildBatchReport, String> {
    let cancelled = control.cancelled.clone();
    cancelled.store(false, Ordering::Relaxed);

    blocking(move || {
        let settings = settings::load(&app)?;
        let root = match out_dir.map(std::path::PathBuf::from).or_else(|| settings.output_root.clone()) {
            Some(root) => root,
            None => anyhow::bail!("no output folder is set — choose one in Settings"),
        };

        let library = open_at(&settings.library_root)?;
        let series = SeriesId(id);
        let total = volumes.len();
        let options = BuildOptions {
            format,
            root: &root,
            folder_per_series: settings.folder_per_series,
            split_spreads: settings.split_spreads,
            compression: settings::compression(&settings.compression),
        };

        let mut built = Vec::new();
        let mut failed = Vec::new();

        for (index, number) in volumes.iter().enumerate() {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(BuildBatchReport { built, failed, cancelled: true });
            }

            match build_one(
                &library,
                series,
                number,
                &options,
                &|done, pages| {
                    let _ = app.emit(
                        "build-batch-progress",
                        BuildBatchProgress {
                            volume: number.clone(),
                            index: index + 1,
                            total,
                            done,
                            pages,
                        },
                    );
                },
            ) {
                Ok(done) => built.push(done),
                Err(e) => failed.push(BuildFailure {
                    volume: number.clone(),
                    error: format!("{e:#}"),
                }),
            }
        }

        Ok(BuildBatchReport { built, failed, cancelled: false })
    })
    .await
}

/// Remember a volume the editor wrote.
///
/// The batch builder records its own, but a volume opened in the editor is
/// written by a command that knows nothing about the library — by design. The
/// caller that opened the editor knows what the volume was, and says so here.
#[tauri::command]
pub async fn library_record_built(
    app: AppHandle,
    id: i64,
    volume: String,
    path: String,
    bytes: u64,
) -> Result<(), String> {
    blocking(move || {
        open(&app)?.record_built(SeriesId(id), &volume, std::path::Path::new(&path), bytes)
    })
    .await
}

/// Forget a recorded build. The file is left alone.
#[tauri::command]
pub async fn library_clear_built(app: AppHandle, id: i64, volume: String) -> Result<(), String> {
    blocking(move || open(&app)?.clear_built(SeriesId(id), &volume)).await
}

/// How a batch writes each volume. Travels together because every item in a
/// batch shares it.
struct BuildOptions<'a> {
    format: Format,
    root: &'a std::path::Path,
    folder_per_series: bool,
    split_spreads: bool,
    compression: mangalize_core::Compression,
}

/// Assemble one stored volume and write it out.
fn build_one(
    library: &Library,
    series: SeriesId,
    number: &str,
    options: &BuildOptions,
    report: &dyn Fn(usize, usize),
) -> anyhow::Result<BuiltVolume> {
    let mut volume = library.build_volume(series, number)?;
    apply_spread_policy(&mut volume, options.split_spreads);
    let pages = volume.total_included();
    if pages == 0 {
        anyhow::bail!("volume {number} has no pages");
    }

    let out = build_path(options.root, &volume, options.format, options.folder_per_series);
    let mut progress = |done: usize, _total: usize| report(done, pages);

    match options.format {
        Format::Epub => {
            writers::epub::write_with_progress(&volume, &out, &options.compression, &mut progress)?
        }
        Format::Cbz => {
            writers::cbz::write_with_progress(&volume, &out, &options.compression, &mut progress)?
        }
    }

    let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    // Remembered so the volume page can offer to share this file rather than
    // spend another minute producing an identical one. Failing to record it is
    // not worth failing the build over — the file is written either way.
    let _ = library.record_built(series, number, &out, bytes);

    Ok(BuiltVolume {
        volume: number.to_string(),
        bytes,
        path: out.to_string_lossy().into_owned(),
        pages,
    })
}

fn open_at(root: &std::path::Path) -> Result<Library> {
    Library::open(root)
}

/// Fetch the published layout and covers, and merge them in.
fn pull_layout(
    library: &mut Library,
    id: SeriesId,
    source: Source,
    source_id: &str,
    language: Option<&str>,
) -> Result<SyncReport> {
    let published = mangalize_meta::volume_chapters_in(source, source_id, language)?;
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
                .map(|c| PublishedChapter {
                    number: c.number,
                    title: None,
                    source_id: c.id,
                    unavailable: c.unavailable,
                })
                .collect(),
            number: v.volume,
        })
        .collect();

    // Tags and content rating come along for free: a library that predates
    // them, or one whose series were re-tagged upstream, is only ever one sync
    // away from being filterable. Failing here must not fail the sync — the
    // layout is what was asked for.
    if let Source::MangaDex = source {
        if let Ok(fresh) = mangalize_meta::mangadex::manga(source_id) {
            let tags: Vec<String> = fresh.tags.iter().map(|t| t.name.clone()).collect();
            let _ = library.set_classification(id, &tags, fresh.content_rating.as_deref());
        }
    }

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
