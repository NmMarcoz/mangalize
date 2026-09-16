//! `mangalize.json.decode`/`.encode` — most catalogue/chapter-list APIs answer
//! in JSON rather than HTML, so this is as essential as `html.select`.

use mlua::{Lua, Table, Value};
use serde_json::Value as Json;

/// Install `decode`/`encode` into `table`.
pub fn install(lua: &Lua, table: &Table) -> mlua::Result<()> {
    let decode = lua.create_function(|lua, text: String| {
        let value: Json = serde_json::from_str(&text)
            .map_err(|e| mlua::Error::RuntimeError(format!("invalid JSON: {e}")))?;
        json_to_lua(lua, &value)
    })?;
    table.set("decode", decode)?;

    let encode = lua.create_function(|_lua, value: Value| {
        let json = lua_to_json(&value)?;
        serde_json::to_string(&json)
            .map_err(|e| mlua::Error::RuntimeError(format!("encoding to JSON: {e}")))
    })?;
    table.set("encode", encode)
}

fn json_to_lua(lua: &Lua, value: &Json) -> mlua::Result<Value> {
    Ok(match value {
        Json::Null => Value::Nil,
        Json::Bool(b) => Value::Boolean(*b),
        Json::Number(n) => Value::Number(n.as_f64().unwrap_or_default()),
        Json::String(s) => Value::String(lua.create_string(s)?),
        Json::Array(items) => {
            let table = lua.create_table()?;
            for (i, item) in items.iter().enumerate() {
                table.set(i + 1, json_to_lua(lua, item)?)?;
            }
            Value::Table(table)
        }
        Json::Object(map) => {
            let table = lua.create_table()?;
            for (key, item) in map {
                table.set(key.as_str(), json_to_lua(lua, item)?)?;
            }
            Value::Table(table)
        }
    })
}

/// The inverse of [`json_to_lua`].
///
/// A Lua table is ambiguous between "array" and "object" (an empty table is
/// both), so the rule is: a table whose keys are exactly `1..=n` with no gaps
/// becomes a JSON array, anything else becomes an object. This matches how
/// every source script already builds its return values (numeric-indexed
/// lists from `table.insert`, string-keyed records from a `{ key = value }`
/// literal), so it never needs to think about the distinction itself.
fn lua_to_json(value: &Value) -> mlua::Result<Json> {
    Ok(match value {
        Value::Nil => Json::Null,
        Value::Boolean(b) => Json::Bool(*b),
        Value::Integer(i) => Json::Number((*i).into()),
        Value::Number(n) => serde_json::Number::from_f64(*n)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        Value::String(s) => Json::String(s.to_str()?.to_string()),
        Value::Table(table) => {
            let len = table.raw_len();
            let is_array = len > 0
                && table
                    .clone()
                    .pairs::<Value, Value>()
                    .count()
                    == len;
            if is_array {
                let mut items = Vec::with_capacity(len);
                for i in 1..=len {
                    items.push(lua_to_json(&table.get(i)?)?);
                }
                Json::Array(items)
            } else {
                let mut map = serde_json::Map::new();
                for pair in table.clone().pairs::<String, Value>() {
                    let (key, item) = pair?;
                    map.insert(key, lua_to_json(&item)?);
                }
                Json::Object(map)
            }
        }
        other => {
            return Err(mlua::Error::RuntimeError(format!(
                "cannot encode a Lua {} to JSON",
                other.type_name()
            )))
        }
    })
}
