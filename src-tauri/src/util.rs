//! Shared plumbing for the command modules.

use anyhow::Result;

/// Run a fallible blocking job on the pool, flattening both error kinds into
/// the string the frontend expects.
///
/// Everything this app does off the UI thread is blocking work — decoding
/// images, walking folders, SQLite, HTTP — so every command funnels through
/// here rather than pretending to be async.
pub async fn blocking<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || job().map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}
