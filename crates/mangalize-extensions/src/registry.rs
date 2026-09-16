//! Where every known [`Source`] lives, looked up by its stable id.
//!
//! This is what replaces the `match "mangadex" | "kitsu"` that used to be
//! scattered across `src-tauri/src/library.rs` and `src-tauri/src/fetch.rs` —
//! `series.source` already stores a source id as free text, so adding a new
//! source only ever means registering it here, never touching a match arm.

use std::path::Path;
use std::sync::Arc;

use crate::lua::LuaSource;
use crate::native;
use crate::types::{Source, SourceInfo};

pub struct Registry {
    sources: Vec<(String, Arc<dyn Source>)>,
}

impl Registry {
    /// The sources that ship with the app, needing no user action to exist.
    ///
    /// MangaDex only, today. Kitsu is deliberately absent — see the crate
    /// root doc for why a source that cannot list chapters has no business
    /// being registered as one.
    pub fn load_builtin() -> Self {
        let mangadex: Arc<dyn Source> = Arc::new(native::mangadex::MangaDexSource::default());
        Self {
            sources: vec![(mangadex.info().id.clone(), mangadex)],
        }
    }

    /// Load every `.lua` file directly inside `dir` as a user-supplied source.
    ///
    /// Returns one error per file that failed to load rather than stopping at
    /// the first one — a typo in one source must not hide every other.
    pub fn load_user_extensions(&mut self, dir: &Path) -> Vec<(std::path::PathBuf, anyhow::Error)> {
        let mut failures = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return failures; // No extensions folder yet is not an error.
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("lua") {
                continue;
            }
            let result = std::fs::read_to_string(&path)
                .map_err(anyhow::Error::from)
                .and_then(LuaSource::load);
            match result {
                Ok(source) => {
                    let source: Arc<dyn Source> = Arc::new(source);
                    self.sources.push((source.info().id.clone(), source));
                }
                Err(e) => failures.push((path, e)),
            }
        }
        failures
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Source>> {
        self.sources
            .iter()
            .find(|(sid, _)| sid == id)
            .map(|(_, source)| source.clone())
    }

    pub fn all(&self) -> Vec<SourceInfo> {
        self.sources.iter().map(|(_, s)| s.info().clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mangadex_is_registered_by_default() {
        let registry = Registry::load_builtin();
        assert!(registry.get(native::mangadex::ID).is_some());
        assert_eq!(registry.all().len(), 1);
    }

    #[test]
    fn an_unknown_id_is_not_found() {
        assert!(Registry::load_builtin().get("nothing.here").is_none());
    }

    #[test]
    fn a_missing_extensions_folder_yields_no_failures() {
        let mut registry = Registry::load_builtin();
        let failures = registry.load_user_extensions(Path::new("/nonexistent/mangalize-test-dir"));
        assert!(failures.is_empty());
    }
}
