//! Where the library lives, where builds go, and the defaults that go with them.
//!
//! Stored as one small JSON file in the app config directory. A missing or
//! unreadable file is never an error: the defaults are perfectly usable, and a
//! corrupt settings file should not stop someone opening their library.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Everything the user can configure, as the frontend sees it.
///
/// Paths are resolved here rather than in the UI, so `library_root` and
/// `output_root` are always real, absolute paths by the time they cross IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub library_root: PathBuf,
    /// Where "Build" writes without asking. `None` until the user picks one.
    pub output_root: Option<PathBuf>,
    /// Pre-selected in the editor and used for batch builds.
    pub default_format: String,
    /// Put each volume in a folder named after its series.
    pub folder_per_series: bool,
    /// Cut double-page spreads into two pages.
    ///
    /// On by default because that is what a Kindle needs; readers that handle a
    /// wide page properly can turn it off.
    pub split_spreads: bool,
    /// Whether the first-run screen has been answered.
    ///
    /// Separate from `output_root` being set, because "decide later" is a valid
    /// answer that must not re-prompt on every launch.
    pub welcomed: bool,
}

/// The on-disk shape. Every field optional so an older file still loads.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    library_root: Option<PathBuf>,
    output_root: Option<PathBuf>,
    default_format: Option<String>,
    folder_per_series: Option<bool>,
    split_spreads: Option<bool>,
    welcomed: Option<bool>,
}

pub fn load(app: &AppHandle) -> Result<Settings> {
    let stored = read(app)?;
    Ok(Settings {
        library_root: match stored.library_root {
            Some(root) => root,
            None => default_library_root()?,
        },
        output_root: stored.output_root,
        default_format: stored.default_format.unwrap_or_else(|| "epub".into()),
        // On by default: a flat folder of a hundred volume files from a dozen
        // series is the thing this is meant to avoid.
        folder_per_series: stored.folder_per_series.unwrap_or(true),
        split_spreads: stored.split_spreads.unwrap_or(true),
        welcomed: stored.welcomed.unwrap_or(false),
    })
}

/// Overwrite the stored settings with `next`.
pub fn save(app: &AppHandle, next: &Settings) -> Result<()> {
    write(
        app,
        &Stored {
            library_root: Some(next.library_root.clone()),
            output_root: next.output_root.clone(),
            default_format: Some(next.default_format.clone()),
            folder_per_series: Some(next.folder_per_series),
            split_spreads: Some(next.split_spreads),
            welcomed: Some(next.welcomed),
        },
    )
}

/// The library folder: what the user chose, else the default.
pub fn library_root(app: &AppHandle) -> Result<PathBuf> {
    Ok(load(app)?.library_root)
}

/// Point the library at a different folder, leaving everything else alone.
pub fn set_library_root(app: &AppHandle, root: PathBuf) -> Result<()> {
    let mut settings = load(app)?;
    settings.library_root = root;
    save(app, &settings)
}

/* ----------------------------------------------------------------- commands */

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<Settings, String> {
    crate::util::blocking(move || load(&app)).await
}

/// Replace the stored settings, creating any folder that was named.
///
/// Creating them here means a path the user typed or picked is real by the time
/// anything tries to build into it, rather than failing at export.
#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    crate::util::blocking(move || {
        std::fs::create_dir_all(&settings.library_root).with_context(|| {
            format!("creating library folder {}", settings.library_root.display())
        })?;
        if let Some(output) = &settings.output_root {
            std::fs::create_dir_all(output)
                .with_context(|| format!("creating output folder {}", output.display()))?;
        }
        save(&app, &settings)?;
        load(&app)
    })
    .await
}

/// The folder offered on first run, so the UI can show it before it exists.
#[tauri::command]
pub fn suggested_output_root() -> Result<String, String> {
    default_output_root()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("{e:#}"))
}

/// `~/Mangalize`.
///
/// Deliberately a plain, visible folder in the home directory rather than an
/// app-private one, and deliberately the same default the CLI uses so both
/// front ends see the same collection. This is the user's library; they should
/// be able to find it, back it up and move it without our help.
pub fn default_library_root() -> Result<PathBuf> {
    Ok(home()?.join("Mangalize"))
}

/// Where builds land by default, offered on first run.
pub fn default_output_root() -> Result<PathBuf> {
    Ok(home()?.join("Mangalize").join("Exports"))
}

fn home() -> Result<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .context("could not find your home directory")?;
    Ok(PathBuf::from(home))
}

fn path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("settings.json"))
}

fn read(app: &AppHandle) -> Result<Stored> {
    let file = path(app)?;
    match std::fs::read(&file) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(_) => Ok(Stored::default()),
    }
}

fn write(app: &AppHandle, stored: &Stored) -> Result<()> {
    let file = path(app)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&file, serde_json::to_vec_pretty(stored)?)
        .with_context(|| format!("writing {}", file.display()))?;
    Ok(())
}
