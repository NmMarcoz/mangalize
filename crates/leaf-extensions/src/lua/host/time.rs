//! `leaf.time.now()` — the current Unix timestamp, in seconds.
//!
//! A source script has no other way to learn the time: `os` is stripped from
//! the sandbox's stdlib entirely (see `sandbox.rs`), yet some sites gate an
//! API behind a timestamp-derived token. This hands back a number and nothing
//! else — no way to sleep, format a calendar, or touch the OS clock any other
//! way than reading it.

use std::time::{SystemTime, UNIX_EPOCH};

use mlua::{Lua, Table};

/// Install `now` into `table`.
pub fn install(lua: &Lua, table: &Table) -> mlua::Result<()> {
    let now = lua.create_function(|_, ()| {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Ok(secs)
    })?;
    table.set("now", now)
}
