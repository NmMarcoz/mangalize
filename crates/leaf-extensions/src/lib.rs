//! A pluggable manga [`Source`], with MangaDex as the first one registered.
//!
//! This replaces the closed `leaf_meta::Source` enum (`MangaDex | Kitsu`)
//! that used to be matched by hand everywhere a library series' backend
//! mattered. `leaf-library`'s `series.source` column is already free
//! text — added for exactly this — so a source only ever needs registering
//! here, in [`Registry`], never a schema change or a new match arm.
//!
//! Third-party sources are written in **Lua** ([`lua::LuaSource`]), not
//! compiled Rust and not WASM: easier to read, and easier to port a
//! Keiyoushi/Tachiyomi extension into by eye, since [`Source`]'s methods
//! mirror Tachiyomi's own `CatalogueSource`/`HttpSource` on purpose. A script
//! runs inside a sandbox with a whitelisted standard library and no ambient
//! network access at all — see [`lua::sandbox`] — so what it can do is
//! entirely bounded by the host functions this crate hands it.
//!
//! MangaDex itself ([`native::mangadex`]) stays native Rust, delegating to the
//! already-tested `leaf-meta::mangadex` client, rather than being
//! rewritten into a script: "works as an extension" means it is reached
//! through the same trait and registry as anything else, not that its
//! implementation language has to match.
//!
//! Deliberately out of scope here: a repo/index for installing new sources,
//! and any path to running actual Keiyoushi APKs (that would mean embedding a
//! JVM and an Android-API compatibility shim on desktop, and a wholly separate
//! native APK loader on Android — two unrelated heavy subsystems for one
//! feature, decided against).

pub mod lua;
pub mod native;
pub mod registry;
pub mod types;

pub use registry::Registry;
pub use types::{
    ChapterRef, MangaDetails, MangaSummary, MangasPage, Source, SourceInfo, VolumeChapters,
    VolumeCover,
};
