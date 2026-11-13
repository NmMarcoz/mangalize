//! Shared plumbing for the command modules.

use anyhow::Result;

/// Try to read a series' free-text `source` as `leaf_meta::Source`
/// (MangaDex/Kitsu). `None` for anything else — a registered `Source`
/// instead (a built-in beyond that pair, or a `.lua` extension) — which is
/// the caller's cue to fall back to `sources::load_registry`.
///
/// One spelling of this dispatch shared by `library.rs`, `fetch.rs`,
/// `meta.rs` and `reader.rs`, rather than four copies of the same match.
pub fn parse_meta_source(name: &str) -> Option<leaf_meta::Source> {
    match name {
        "mangadex" => Some(leaf_meta::Source::MangaDex),
        "kitsu" => Some(leaf_meta::Source::Kitsu),
        _ => None,
    }
}

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
