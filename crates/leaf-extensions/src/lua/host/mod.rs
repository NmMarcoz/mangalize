//! Host functions exposed to a source script as `leaf.<module>.<fn>`.
//!
//! This is the entire capability surface a script has — no `io`, `os` or
//! `require` survive the sandbox's restricted stdlib (see
//! [`super::sandbox`]), so whatever isn't installed here simply isn't
//! reachable.

pub mod html;
pub mod http;
pub mod json;
pub mod time;

use mlua::{Lua, Table};

/// Populate `leaf`'s `http`/`html`/`json` sub-tables.
///
/// Called *after* the script's top-level code has already run (see
/// [`super::sandbox::new_vm`] for why that ordering is safe), once the
/// source's declared origins are known.
pub fn install(lua: &Lua, leaf: &Table, allowed_origins: Vec<String>) -> mlua::Result<()> {
    let http_table = lua.create_table()?;
    http::install(lua, &http_table, allowed_origins)?;
    leaf.set("http", http_table)?;

    let html_table = lua.create_table()?;
    html::install(lua, &html_table)?;
    leaf.set("html", html_table)?;

    let json_table = lua.create_table()?;
    json::install(lua, &json_table)?;
    leaf.set("json", json_table)?;

    let time_table = lua.create_table()?;
    time::install(lua, &time_table)?;
    leaf.set("time", time_table)
}
