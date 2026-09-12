//! Getting a built volume off the device it was built on.
//!
//! On a desktop this is `revealItemInDir` and there is nothing to do here: the
//! file is already somewhere the user can see it. Android has no file manager
//! to reveal into, no Send to Kindle (see `send.rs`), and an export directory
//! under `Android/data` that recent versions hide from most file pickers — so
//! the share sheet is the only way out, and it needs a plugin of our own
//! because `tauri-plugin-opener` only knows how to open a URL there.
//!
//! Deliberately narrow: one command, one file, and the user picks the
//! destination in a system sheet. Nothing here writes anywhere or decides where
//! a volume should go.

use tauri::{AppHandle, Runtime};

#[cfg(target_os = "android")]
use tauri::{
    plugin::{PluginApi, PluginHandle},
    Manager,
};

/// What a desktop build answers, since the button is not offered there.
pub const UNAVAILABLE: &str = "Sharing is an Android feature; on a desktop the \
    built volume is already in a folder you can open.";

#[cfg(target_os = "android")]
struct Share<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareArgs {
    path: String,
    title: Option<String>,
}

/// Registers the Kotlin side. A no-op plugin elsewhere, so `lib.rs` stays free
/// of a `cfg` around the builder chain.
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri::plugin::Builder::new("mangalize-export");

    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api: PluginApi<R, ()>| {
        // Resolved by reflection as `<identifier>.<class>`, so this has to
        // match the package `SharePlugin.kt` declares.
        let handle = api.register_android_plugin("dev.mangalize.app", "SharePlugin")?;
        app.manage(Share(handle));
        Ok(())
    });

    builder.build()
}

/// Offer a built volume to another app.
#[tauri::command]
pub async fn share_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    title: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let share = app.state::<Share<R>>();
        share
            .0
            .run_mobile_plugin::<()>("shareFile", ShareArgs { path, title })
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path, title);
        Err(UNAVAILABLE.to_string())
    }
}
