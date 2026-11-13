//! `leaf.http.get(url, opts)` / `leaf.http.post(url, body, opts)` —
//! the actual security boundary of the sandbox. Lua itself has no ambient
//! network access; these are the only doors, and they only open onto the
//! origins the source declared.

use std::io::Read;
use std::time::Duration;

use leaf_fetch::download::build_request;
use leaf_fetch::url::origin_of;
use mlua::{Lua, Table, Value};

/// A response body larger than this is almost certainly not the HTML/JSON
/// page a source is after.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

const ACCEPT: &str = "text/html,application/json;q=0.9,*/*;q=0.8";

/// Install `get`/`post` into `table`, refusing any request whose origin isn't
/// in `allowed_origins`.
pub fn install(lua: &Lua, table: &Table, allowed_origins: Vec<String>) -> mlua::Result<()> {
    let origins = allowed_origins.clone();
    let get = lua.create_function(move |lua, (url, opts): (String, Option<Table>)| {
        request(lua, "GET", &url, None, &origins, opts)
    })?;
    table.set("get", get)?;

    // A separate function rather than an `opts.method`/`opts.body` on `get`:
    // a source script reads `leaf.http.post(url, body, opts)` at a
    // glance, where an options-bag method would need its own doc line to
    // explain what unlocks the body.
    let post = lua.create_function(move |lua, (url, body, opts): (String, String, Option<Table>)| {
        request(lua, "POST", &url, Some(body), &allowed_origins, opts)
    })?;
    table.set("post", post)
}

/// Shared by `get` and `post`: check the origin, send the request, cap and
/// return the body. `body` carries a POST's JSON payload; `get` has none.
fn request(
    lua: &Lua,
    method: &str,
    url: &str,
    body: Option<String>,
    allowed_origins: &[String],
    opts: Option<Table>,
) -> mlua::Result<Value> {
    let origin = origin_of(url).unwrap_or_default();
    if !allowed_origins.iter().any(|allowed| allowed == &origin) {
        return Err(mlua::Error::RuntimeError(format!(
            "{url:?} is outside this source's declared origins"
        )));
    }

    let referer: Option<String> = opts
        .as_ref()
        .and_then(|o| o.get::<Option<String>>("referer").ok().flatten());

    let mut built = build_request(method, url, referer.as_deref(), ACCEPT).timeout(Duration::from_secs(20));

    let response = match &body {
        Some(payload) => {
            built = built.set("Content-Type", "application/json");
            built.send_string(payload)
        }
        None => built.call(),
    }
    .map_err(|e| mlua::Error::RuntimeError(format!("fetching {url}: {e}")))?;

    let status = response.status();
    let mut text = String::new();
    response
        .into_reader()
        .take(MAX_BODY_BYTES as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|e| mlua::Error::RuntimeError(format!("reading response from {url}: {e}")))?;
    if text.len() > MAX_BODY_BYTES {
        return Err(mlua::Error::RuntimeError(format!(
            "response from {url} is unexpectedly large"
        )));
    }

    let result = lua.create_table()?;
    result.set("status", status)?;
    result.set("body", text)?;
    Ok(Value::Table(result))
}
