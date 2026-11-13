//! `leaf.html.select(document, selector)` — a real CSS selector engine
//! for source scripts to read a listing/detail/chapter page with.
//!
//! Deliberately not `leaf-fetch::extract`'s tag scanner: that module was
//! built to survive the malformed, lazy-loading markup real reader pages ship,
//! by a fixed set of heuristics no script author could adjust. A source script
//! wants the opposite — a general query capability it points at whatever
//! selectors the site actually uses — so this is backed by `scraper`, a real
//! CSS engine, instead.

use mlua::{Lua, Table, Value};
use scraper::{Html, Selector};

/// Install `select` into `table`.
pub fn install(lua: &Lua, table: &Table) -> mlua::Result<()> {
    let select = lua.create_function(|lua, (document, selector): (String, String)| {
        let selector = Selector::parse(&selector)
            .map_err(|e| mlua::Error::RuntimeError(format!("bad selector {selector:?}: {e}")))?;
        let parsed = Html::parse_document(&document);

        let matches = lua.create_table()?;
        for (i, element) in parsed.select(&selector).enumerate() {
            let row = lua.create_table()?;
            let text: String = element.text().collect::<Vec<_>>().join("");
            row.set("text", text.trim().to_string())?;
            row.set("html", element.html())?;

            let attrs = lua.create_table()?;
            for (name, value) in element.value().attrs() {
                attrs.set(name, value)?;
            }
            row.set("attrs", attrs)?;

            // Lua arrays are 1-indexed by convention.
            matches.set(i + 1, row)?;
        }
        Ok(Value::Table(matches))
    })?;

    table.set("select", select)
}
