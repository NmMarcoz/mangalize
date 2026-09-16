//! The restricted Lua environment a source script runs in.
//!
//! Two layers of restriction, not one: the standard library loaded is a
//! whitelist (`table`/`string`/`utf8`/`math` only — no `io`, `os`, `package`
//! or `debug`, so there is no ambient filesystem/process/module-loading
//! surface to begin with), and the *only* way a script reaches the network at
//! all is the `mangalize.http.get` function this crate hands it, which is
//! itself scoped to the source's declared origins. A script cannot be used to
//! make the app fetch or touch anything its author didn't declare.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use mlua::{HookTriggers, Lua, StdLib, VmState};

/// How many VM instructions between timeout checks. Low enough that a tight
/// infinite loop is caught quickly, high enough not to make every call slower.
const HOOK_EVERY_INSTRUCTIONS: u32 = 10_000;

/// A source script gets this long per call before it's aborted. Generous: it
/// covers a slow host, not just a slow script, and a script that legitimately
/// needs longer than this to answer one call is not one worth waiting on.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// A fresh restricted VM with an empty `mangalize` global table ready for the
/// host modules to be installed into.
///
/// The `mangalize` table is created before the script ever runs and handed
/// back so the caller can run the script *first* (to read its manifest) and
/// only populate `http`/`html`/`json` afterward, once the source's declared
/// origins are known. This works because the script's functions only look
/// `mangalize.http.get` up when they're actually called, not when they're
/// defined — by the time `popular`/`search`/etc. run, the table has long
/// since been filled in.
pub fn new_vm() -> Result<(Lua, mlua::Table)> {
    let libs = StdLib::TABLE | StdLib::STRING | StdLib::UTF8 | StdLib::MATH;
    let lua = Lua::new_with(libs, mlua::LuaOptions::default())
        .map_err(|e| anyhow!("creating sandboxed Lua state: {e}"))?;

    // `load`/`loadstring`/`dofile`/`loadfile`/`require` are base-library
    // functions: unlike `io`, `os` etc. they aren't gated by any `StdLib` flag
    // and survive regardless of which libraries were requested above, so they
    // have to be stripped by hand. Left in, `load` would let a script compile
    // and run new code from a string — including, since Lua 5.2, precompiled
    // *bytecode*, which the reference manual itself warns is unsafe to accept
    // from anything you don't already trust.
    let globals = lua.globals();
    for name in ["load", "loadstring", "loadfile", "dofile", "require", "collectgarbage"] {
        globals
            .set(name, mlua::Value::Nil)
            .map_err(|e| anyhow!("removing the {name} global: {e}"))?;
    }

    // mlua's error type isn't unconditionally `Send + Sync`, so it can't cross
    // through `anyhow`'s blanket `From` via `?` — spelled out by hand instead.
    let mangalize = lua
        .create_table()
        .map_err(|e| anyhow!("creating the mangalize host table: {e}"))?;
    globals
        .set("mangalize", &mangalize)
        .map_err(|e| anyhow!("installing the mangalize host table: {e}"))?;
    Ok((lua, mangalize))
}

/// Run `f` against `lua`, aborting it if it runs past `timeout`.
///
/// Lua 5.4 (unlike Luau) has no built-in interrupt hook, but its debug-hook
/// mechanism does the same job: fire every `N` VM instructions, and error out
/// of the running script once the deadline has passed. The error propagates
/// through the script exactly like any other Lua runtime error.
///
/// Takes the timeout as a parameter rather than always using [`CALL_TIMEOUT`]
/// so tests can use a short one — nothing about a runaway-script test should
/// need to actually wait out the production timeout.
pub fn call_with_timeout<T>(
    lua: &Lua,
    timeout: Duration,
    f: impl FnOnce() -> mlua::Result<T>,
) -> mlua::Result<T> {
    let deadline = Instant::now() + timeout;
    lua.set_hook(
        HookTriggers {
            every_nth_instruction: Some(HOOK_EVERY_INSTRUCTIONS),
            ..HookTriggers::default()
        },
        move |_lua, _debug| {
            if Instant::now() > deadline {
                return Err(mlua::Error::RuntimeError(
                    "source script exceeded its time limit".to_string(),
                ));
            }
            Ok(VmState::Continue)
        },
    )?;
    let result = f();
    lua.remove_hook();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricted_stdlib_has_no_filesystem_or_process_access() {
        let (lua, _) = new_vm().unwrap();
        for global in [
            "io",
            "os",
            "require",
            "load",
            "loadstring",
            "loadfile",
            "dofile",
            "collectgarbage",
            "debug",
            "package",
        ] {
            assert!(
                lua.globals().get::<mlua::Value>(global).unwrap().is_nil(),
                "{global} should not be reachable from a source script"
            );
        }
    }

    #[test]
    fn an_infinite_loop_is_aborted_rather_than_hanging() {
        let (lua, _) = new_vm().unwrap();
        let result = call_with_timeout(&lua, Duration::from_millis(50), || {
            lua.load("while true do end").exec()
        });
        assert!(result.is_err());
    }

    #[test]
    fn ordinary_scripts_run_to_completion_within_the_timeout() {
        let (lua, _) = new_vm().unwrap();
        let sum: i64 = call_with_timeout(&lua, CALL_TIMEOUT, || {
            lua.load("local s = 0 for i = 1, 1000 do s = s + i end return s")
                .eval()
        })
        .unwrap();
        assert_eq!(sum, 500_500);
    }
}
