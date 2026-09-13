//! Updating the Android build.
//!
//! Everywhere else this is `tauri-plugin-updater`, which checks a signed
//! `latest.json`, downloads a bundle and swaps it in. That plugin has no Android
//! implementation at all, and the usual answer — "a phone updates through
//! whatever store installed it" — is no answer for an APK the user sideloaded.
//!
//! So: ask GitHub what the latest release is, download the APK, and hand it to
//! Android's own package installer. The install itself is never silent. The
//! system asks, the user confirms, and Android refuses outright unless the new
//! APK is signed with the same key as the installed one — which is the same
//! guarantee the desktop updater's signature check provides, enforced by the OS
//! rather than by us.
//!
//! Deliberately not a general-purpose downloader: one repository, one asset
//! naming convention, and the only thing it will ever open is an APK it just
//! wrote itself.

#[cfg(target_os = "android")]
use std::path::PathBuf;

#[cfg(target_os = "android")]
use anyhow::{bail, Context, Result};
use serde::Serialize;
#[cfg(target_os = "android")]
use tauri::{Emitter, Manager};
use tauri::AppHandle;

#[cfg(target_os = "android")]
use crate::util::blocking;

/// Where releases are published. The same repository `tauri.conf.json` points
/// the desktop updater at.
#[cfg(target_os = "android")]
const RELEASES: &str = "https://api.github.com/repos/NmMarcoz/mangalize/releases/latest";

/// GitHub rejects requests with no user agent.
#[cfg(target_os = "android")]
const AGENT: &str = "mangalize-updater";

/// What a desktop build answers, since it has a real updater.
pub const UNAVAILABLE: &str = "This build updates itself through the usual updater.";

#[derive(Serialize, Clone)]
pub struct AndroidUpdate {
    pub version: String,
    pub notes: String,
    pub url: String,
    pub bytes: u64,
}

#[cfg(target_os = "android")]
#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

/// Is there a newer release, and where is its APK?
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_update_check(app: AppHandle) -> Result<Option<AndroidUpdate>, String> {
    let current = app.package_info().version.to_string();
    blocking(move || latest(&current)).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_update_check(_app: AppHandle) -> Result<Option<AndroidUpdate>, String> {
    Err(UNAVAILABLE.to_string())
}

/// Download the APK and ask Android to install it.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_update_install(app: AppHandle, url: String) -> Result<(), String> {
    let handle = app.clone();
    let file = blocking(move || fetch_apk(&handle, &url)).await?;
    crate::export::install_apk(&app, file.to_string_lossy().into_owned()).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_update_install(_app: AppHandle, _url: String) -> Result<(), String> {
    Err(UNAVAILABLE.to_string())
}

/// Ask GitHub for the newest release, and decide whether it is worth offering.
#[cfg(target_os = "android")]
fn latest(current: &str) -> Result<Option<AndroidUpdate>> {
    let body: serde_json::Value = ureq::get(RELEASES)
        .set("User-Agent", AGENT)
        .call()
        .context("asking GitHub for the latest release")?
        .into_json()?;

    let tag = body["tag_name"].as_str().unwrap_or_default();
    let version = tag.trim_start_matches('v');
    if version.is_empty() {
        bail!("the latest release has no version tag");
    }
    if !newer(version, current) {
        return Ok(None);
    }

    // One APK per release, named for the version. Matching on the extension
    // rather than the full name means a rename does not silently stop updates.
    let asset = body["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(".apk")))
        .with_context(|| format!("release {tag} has no APK to install"))?;

    Ok(Some(AndroidUpdate {
        version: version.to_string(),
        notes: body["body"].as_str().unwrap_or_default().to_string(),
        url: asset["browser_download_url"]
            .as_str()
            .context("that APK has no download URL")?
            .to_string(),
        bytes: asset["size"].as_u64().unwrap_or(0),
    }))
}

/// Is `candidate` a later version than `current`?
///
/// Compared field by field as numbers. A string compare would call 1.10.0 older
/// than 1.9.0, which is exactly the release where it would first matter.
///
/// Not gated to Android like its callers: the rule it encodes is worth a test
/// on every platform that runs them.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn newer(candidate: &str, current: &str) -> bool {
    fn parts(v: &str) -> Vec<u32> {
        v.split(['.', '-', '+'])
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Download the APK into the app's cache, reporting progress as it goes.
#[cfg(target_os = "android")]
fn fetch_apk(app: &AppHandle, url: &str) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .context("no cache directory to download into")?
        .join("updates");
    std::fs::create_dir_all(&dir)?;

    let response = ureq::get(url)
        .set("User-Agent", AGENT)
        .call()
        .context("downloading the update")?;
    let total: u64 = response
        .header("Content-Length")
        .and_then(|l| l.parse().ok())
        .unwrap_or(0);

    // Written under a temporary name and renamed on success, so a download cut
    // off halfway can never be handed to the installer as if it were whole.
    let target = dir.join("mangalize-update.apk");
    let partial = dir.join("mangalize-update.apk.part");
    let mut source = response.into_reader();
    let mut sink = std::fs::File::create(&partial)?;

    let mut buffer = [0u8; 64 * 1024];
    let mut downloaded = 0u64;
    let mut last_reported = 0u64;
    loop {
        let read = std::io::Read::read(&mut source, &mut buffer)?;
        if read == 0 {
            break;
        }
        std::io::Write::write_all(&mut sink, &buffer[..read])?;
        downloaded += read as u64;

        // Every 512KB rather than every chunk: this crosses to the webview.
        if downloaded - last_reported >= 512 * 1024 {
            last_reported = downloaded;
            let _ = app.emit("android-update-progress", DownloadProgress { downloaded, total });
        }
    }
    drop(sink);

    if total > 0 && downloaded != total {
        let _ = std::fs::remove_file(&partial);
        bail!("the download stopped early: {downloaded} of {total} bytes");
    }

    std::fs::rename(&partial, &target)?;
    let _ = app.emit(
        "android-update-progress",
        DownloadProgress { downloaded, total: downloaded },
    );
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn a_higher_patch_is_newer() {
        assert!(newer("1.9.1", "1.9.0"));
        assert!(!newer("1.9.0", "1.9.1"));
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        assert!(!newer("1.9.0", "1.9.0"));
    }

    #[test]
    fn ten_sorts_after_nine_rather_than_before_it() {
        // The whole reason this is not a string compare.
        assert!(newer("1.10.0", "1.9.0"));
        assert!(!newer("1.9.0", "1.10.0"));
        assert!(newer("2.0.0", "1.99.99"));
    }

    #[test]
    fn a_missing_field_counts_as_zero() {
        assert!(newer("1.9", "1.8.9"));
        assert!(!newer("1.9", "1.9.0"));
    }
}
