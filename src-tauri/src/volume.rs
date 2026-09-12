//! Commands for the folder-in, file-out path: scan a folder, preview it, export
//! it. Thin translation over `mangalize-core`; no pipeline logic lives here.

use std::path::{Path, PathBuf};

use mangalize_core::project::Volume;
use mangalize_core::{scan_volume, writers};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::settings;
use crate::thumbs;
use crate::util::blocking;

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
    format!("{}.{}", file_stem(&volume), format.extension())
}

/// Where "Build" writes without asking, or `None` when no output folder is set.
///
/// The shape is `<output>/<Series>/<Series v01.epub>`. Naming lives here rather
/// than in the UI so a one-off "Build as…" and an unattended batch produce
/// byte-identical names.
#[tauri::command]
pub async fn resolve_build_path(
    app: AppHandle,
    volume: Volume,
    format: Format,
) -> Result<Option<String>, String> {
    blocking(move || {
        let settings = settings::load(&app)?;
        Ok(settings
            .output_root
            .map(|root| build_path(&root, &volume, format, settings.folder_per_series))
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
}

/// `<root>/<Series>/<Series v01.epub>`, or a flat `<root>/<Series v01.epub>`.
pub(crate) fn build_path(
    root: &Path,
    volume: &Volume,
    format: Format,
    folder_per_series: bool,
) -> PathBuf {
    let name = format!("{}.{}", file_stem(volume), format.extension());
    if folder_per_series {
        let series = safe_component(&volume.metadata.series);
        let folder = if series.is_empty() { "Unsorted".to_string() } else { series };
        root.join(folder).join(name)
    } else {
        root.join(name)
    }
}

/// Apply the user's spread preference to a freshly assembled volume.
///
/// The scanner splits spreads by default; this is the one place that decision is
/// reversed, so the editor and an unattended batch agree on what a volume looks
/// like before anything is written.
pub(crate) fn apply_spread_policy(volume: &mut Volume, split: bool) {
    for chapter in &mut volume.chapters {
        for page in &mut chapter.pages {
            if page.kind == mangalize_core::PageKind::Spread {
                page.split = split;
            }
        }
    }
}

/// `Itch The Witch v01`, without an extension.
pub(crate) fn file_stem(volume: &Volume) -> String {
    let m = &volume.metadata;
    let series = safe_component(&m.series);
    let series = if series.is_empty() { "volume".to_string() } else { series };
    match m.volume {
        Some(v) => format!("{series} v{v:02}"),
        None => series,
    }
}

/// Strip characters that are illegal in a filename on at least one target OS.
///
/// Trailing dots and spaces go too: Windows silently drops them, which would
/// make the path we report and the file that exists disagree.
pub(crate) fn safe_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '-' } else { c })
        .collect();
    cleaned.trim().trim_end_matches(['.', ' ']).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mangalize_core::project::Metadata;

    fn volume(series: &str, number: Option<u32>) -> Volume {
        Volume {
            metadata: Metadata {
                series: series.into(),
                volume: number,
                ..Metadata::default()
            },
            cover: None,
            chapters: Vec::new(),
            root: PathBuf::new(),
        }
    }

    #[test]
    fn a_volume_is_filed_under_its_series() {
        let path = build_path(
            Path::new("/out"),
            &volume("Ichi the Witch", Some(1)),
            Format::Epub,
            true,
        );
        assert_eq!(
            path,
            Path::new("/out/Ichi the Witch/Ichi the Witch v01.epub")
        );
    }

    #[test]
    fn volume_numbers_are_padded_so_v2_sorts_before_v10() {
        let stem = |n| file_stem(&volume("X", Some(n)));
        let mut names = [stem(10), stem(2), stem(1)];
        names.sort();
        assert_eq!(names, ["X v01", "X v02", "X v10"]);
    }

    #[test]
    fn a_flat_layout_skips_the_series_folder() {
        let path = build_path(
            Path::new("/out"),
            &volume("Ichi the Witch", Some(3)),
            Format::Cbz,
            false,
        );
        assert_eq!(path, Path::new("/out/Ichi the Witch v03.cbz"));
    }

    #[test]
    fn a_series_name_cannot_escape_the_output_folder() {
        // Separators become dashes, so a title like this is one oddly-named
        // folder rather than a walk up out of the output directory.
        let path = build_path(
            Path::new("/out"),
            &volume("../../etc", Some(1)),
            Format::Epub,
            true,
        );

        let under: Vec<_> = path.strip_prefix("/out").unwrap().components().collect();
        assert_eq!(under.len(), 2, "expected <series>/<file>, got {path:?}");
        assert!(
            !under
                .iter()
                .any(|c| matches!(c, std::path::Component::ParentDir)),
            "no component may be a parent reference: {path:?}"
        );
    }

    #[test]
    fn a_title_made_only_of_dots_does_not_produce_a_dot_folder() {
        // "." and ".." are real directories; naming a folder after one would
        // silently write into the output root or above it.
        assert_eq!(safe_component(".."), "");
        assert_eq!(safe_component("."), "");
        assert_eq!(
            build_path(Path::new("/out"), &volume("..", Some(1)), Format::Epub, true),
            Path::new("/out/Unsorted/volume v01.epub")
        );
    }

    #[test]
    fn a_volume_with_no_number_is_named_after_the_series_alone() {
        assert_eq!(file_stem(&volume("Oneshot Collection", None)), "Oneshot Collection");
    }

    #[test]
    fn an_untitled_volume_still_gets_a_usable_name() {
        assert_eq!(file_stem(&volume("", Some(2))), "volume v02");
        assert_eq!(
            build_path(Path::new("/out"), &volume("", Some(2)), Format::Epub, true),
            Path::new("/out/Unsorted/volume v02.epub")
        );
    }

    #[test]
    fn windows_hostile_names_are_made_safe() {
        assert_eq!(safe_component("Re:Zero"), "Re-Zero");
        assert_eq!(safe_component("Vol."), "Vol");
        assert_eq!(safe_component("  spaced  "), "spaced");
    }
}
