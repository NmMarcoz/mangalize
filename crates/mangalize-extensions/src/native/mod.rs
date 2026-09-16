//! Sources implemented directly in Rust rather than loaded as a script.
//!
//! There is exactly one today: MangaDex. It stays native rather than becoming
//! a Lua source because `mangalize-meta::mangadex` already handles a subtle
//! protocol correctly and is already tested — MangaDex@Home's short-lived
//! per-request signed URLs, the two-request language-fallback merge for
//! volume/chapter aggregation. "Works as an extension" means it is reached
//! through the same [`crate::Source`] trait and [`crate::Registry`] as
//! anything else, not that its implementation language has to match.

pub mod mangadex;
