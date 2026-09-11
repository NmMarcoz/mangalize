//! Where the library lives, remembered between runs.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Serialize, Deserialize)]
struct Settings {
    library_root: Option<PathBuf>,
}

/// The library folder: what the user chose, else the default.
pub fn library_root(app: &AppHandle) -> Result<PathBuf> {
    if let Some(chosen) = load(app)?.library_root {
        return Ok(chosen);
    }
    default_root()
}

/// `~/Mangalize`.
///
/// Deliberately a plain, visible folder in the home directory rather than an
/// app-private one, and deliberately the same default the CLI uses so both
/// front ends see the same collection. This is the user's library; they should
/// be able to find it, back it up and move it without our help.
pub fn default_root() -> Result<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .context("could not find your home directory")?;
    Ok(PathBuf::from(home).join("Mangalize"))
}

pub fn set_library_root(app: &AppHandle, root: PathBuf) -> Result<()> {
    let mut settings = load(app)?;
    settings.library_root = Some(root);
    save(app, &settings)
}

fn path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("settings.json"))
}

fn load(app: &AppHandle) -> Result<Settings> {
    let file = path(app)?;
    match std::fs::read(&file) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        // A missing or unreadable settings file is not worth failing over; the
        // defaults are perfectly usable.
        Err(_) => Ok(Settings::default()),
    }
}

fn save(app: &AppHandle, settings: &Settings) -> Result<()> {
    let file = path(app)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&file, serde_json::to_vec_pretty(settings)?)
        .with_context(|| format!("writing {}", file.display()))?;
    Ok(())
}
