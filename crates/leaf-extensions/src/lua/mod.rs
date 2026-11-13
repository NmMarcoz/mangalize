//! [`LuaSource`]: a [`crate::Source`] backed by a sandboxed Lua script.
//!
//! The VM lives on a dedicated thread that owns it exclusively for its whole
//! life, and every [`Source`] method is really a message sent to that thread
//! over a channel. This isn't just a convenience: `mlua::Lua` is not
//! `Send`/`Sync`, so a VM can never be shared across threads directly, and a
//! single VM was never meant to be called into reentrantly from several
//! threads at once anyway. Confining it to one thread and mediating every
//! call through a channel is the same pattern `src-tauri/src/tasks.rs` already
//! uses for its single background worker, applied here for the same reason:
//! it makes something inherently single-threaded safe to hand out as a plain
//! `Arc<dyn Source + Send + Sync>`.

mod host;
mod sandbox;

use std::sync::mpsc;

use anyhow::{anyhow, bail, Result};
use mlua::Table;

use crate::types::{
    ChapterRef, MangaDetails, MangaSummary, MangasPage, Source, SourceInfo, VolumeChapters,
    VolumeCover,
};

type Reply<T> = mpsc::Sender<Result<T>>;

/// One request to the VM's owning thread. Each variant carries its own
/// reply channel rather than a boxed `dyn Any`, so the thread loop and every
/// call site stay plainly typed.
enum Call {
    Popular(u32, Reply<MangasPage>),
    Latest(u32, Reply<MangasPage>),
    Search(String, u32, Reply<MangasPage>),
    MangaDetails(String, Reply<MangaDetails>),
    Volumes(String, Option<String>, Reply<Vec<VolumeChapters>>),
    Covers(String, Reply<Vec<VolumeCover>>),
    PageList(String, Reply<Vec<String>>),
}

pub struct LuaSource {
    info: SourceInfo,
    tx: mpsc::Sender<Call>,
}

impl LuaSource {
    /// Load and validate a source script, starting its owning thread.
    ///
    /// Blocks until the script has run to completion and its `SOURCE`
    /// manifest has been read, so a broken script fails here rather than on
    /// its first real use.
    pub fn load(script: String) -> Result<Self> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<SourceInfo>>();
        let (call_tx, call_rx) = mpsc::channel::<Call>();

        std::thread::Builder::new()
            .name("leaf-lua-source".to_string())
            .spawn(move || run(script, ready_tx, call_rx))
            .map_err(|e| anyhow!("starting the source's thread: {e}"))?;

        let info = ready_rx
            .recv()
            .map_err(|_| anyhow!("the source's thread exited before it finished loading"))??;

        Ok(Self { info, tx: call_tx })
    }

    /// Send a call and wait for its reply. The only way this fails is the
    /// owning thread having already exited, which only happens if a previous
    /// call poisoned it — treated as the source being unusable from here on,
    /// same as any other permanent failure.
    fn ask<T>(&self, build: impl FnOnce(Reply<T>) -> Call) -> Result<T> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(build(reply_tx))
            .map_err(|_| anyhow!("{} is no longer running", self.info.name))?;
        reply_rx
            .recv()
            .map_err(|_| anyhow!("{} did not answer", self.info.name))?
    }
}

impl Source for LuaSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn popular(&self, page: u32) -> Result<MangasPage> {
        self.ask(|reply| Call::Popular(page, reply))
    }

    fn latest(&self, page: u32) -> Result<MangasPage> {
        self.ask(|reply| Call::Latest(page, reply))
    }

    fn search(&self, query: &str, page: u32) -> Result<MangasPage> {
        self.ask(|reply| Call::Search(query.to_string(), page, reply))
    }

    fn manga_details(&self, id: &str) -> Result<MangaDetails> {
        self.ask(|reply| Call::MangaDetails(id.to_string(), reply))
    }

    fn volumes(&self, id: &str, language: Option<&str>) -> Result<Vec<VolumeChapters>> {
        self.ask(|reply| Call::Volumes(id.to_string(), language.map(str::to_string), reply))
    }

    fn covers(&self, id: &str) -> Result<Vec<VolumeCover>> {
        self.ask(|reply| Call::Covers(id.to_string(), reply))
    }

    fn page_list(&self, chapter_id: &str) -> Result<Vec<String>> {
        self.ask(|reply| Call::PageList(chapter_id.to_string(), reply))
    }
}

/// The body of the source's dedicated thread: build the VM, run the script,
/// report readiness, then serve calls until the sender side is dropped (which
/// is what ends the `for` loop and lets this function, and the thread, exit).
fn run(script: String, ready: mpsc::Sender<Result<SourceInfo>>, calls: mpsc::Receiver<Call>) {
    let (lua, info) = match init(&script) {
        Ok(pair) => pair,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    if ready.send(Ok(info)).is_err() {
        return; // Nobody is waiting for this source any more.
    }

    // Each arm's reply carries a different `T`, so every arm discards its own
    // `send` result rather than the `match` producing one shared type — a
    // reply nobody is listening for any more (e.g. a cancelled task) is not
    // this thread's problem to handle beyond that.
    for call in calls {
        match call {
            Call::Popular(page, reply) => {
                let _ = reply.send(call_paged(&lua, "popular", page));
            }
            Call::Latest(page, reply) => {
                let _ = reply.send(call_paged(&lua, "latest", page));
            }
            Call::Search(query, page, reply) => {
                let _ = reply.send(call_search(&lua, &query, page));
            }
            Call::MangaDetails(id, reply) => {
                let _ = reply.send(call_manga_details(&lua, &id));
            }
            Call::Volumes(id, language, reply) => {
                let _ = reply.send(call_volumes(&lua, &id, language.as_deref()));
            }
            Call::Covers(id, reply) => {
                let _ = reply.send(call_covers(&lua, &id));
            }
            Call::PageList(id, reply) => {
                let _ = reply.send(call_page_list(&lua, &id));
            }
        }
    }
}

/// Run the script once, read its `SOURCE` manifest, then install the host
/// functions now that the allowed origins are known. See [`sandbox::new_vm`]'s
/// doc for why this order — script first, host functions after — is safe.
fn init(script: &str) -> Result<(mlua::Lua, SourceInfo)> {
    let (lua, leaf) = sandbox::new_vm()?;
    lua.load(script)
        .exec()
        .map_err(|e| anyhow!("running source script: {e}"))?;

    let source_table: Table = lua
        .globals()
        .get("SOURCE")
        .map_err(|_| anyhow!("script does not define a SOURCE table"))?;
    let id: String = source_table.get("id").map_err(|_| anyhow!("SOURCE.id is required"))?;
    let name: String = source_table
        .get("name")
        .map_err(|_| anyhow!("SOURCE.name is required"))?;
    let lang: String = source_table.get("lang").unwrap_or_else(|_| "en".to_string());
    let base_url: String = source_table
        .get("base_url")
        .map_err(|_| anyhow!("SOURCE.base_url is required"))?;
    let mirrors: Vec<String> = source_table.get("mirrors").unwrap_or_default();

    let mut allowed_origins: Vec<String> = leaf_fetch::url::origin_of(&base_url)
        .into_iter()
        .collect();
    for mirror in &mirrors {
        allowed_origins.extend(leaf_fetch::url::origin_of(mirror));
    }
    if allowed_origins.is_empty() {
        bail!("SOURCE.base_url {base_url:?} is not a valid http(s) URL");
    }

    host::install(&lua, &leaf, allowed_origins)
        .map_err(|e| anyhow!("installing host functions: {e}"))?;

    Ok((lua, SourceInfo { id, name, lang, base_url }))
}

fn call_paged(lua: &mlua::Lua, function: &str, page: u32) -> Result<MangasPage> {
    let f: mlua::Function = lua
        .globals()
        .get(function)
        .map_err(|_| anyhow!("script does not define {function}(page)"))?;
    let table: Table = sandbox::call_with_timeout(lua, sandbox::CALL_TIMEOUT, || f.call(page))
        .map_err(|e| anyhow!("{function}({page}): {e}"))?;
    read_manga_page(&table)
}

fn call_search(lua: &mlua::Lua, query: &str, page: u32) -> Result<MangasPage> {
    let f: mlua::Function = lua
        .globals()
        .get("search")
        .map_err(|_| anyhow!("script does not define search(query, page)"))?;
    let table: Table = sandbox::call_with_timeout(lua, sandbox::CALL_TIMEOUT, || f.call((query, page)))
        .map_err(|e| anyhow!("search({query:?}, {page}): {e}"))?;
    read_manga_page(&table)
}

fn call_manga_details(lua: &mlua::Lua, id: &str) -> Result<MangaDetails> {
    let f: mlua::Function = lua
        .globals()
        .get("manga_details")
        .map_err(|_| anyhow!("script does not define manga_details(id)"))?;
    let table: Table = sandbox::call_with_timeout(lua, sandbox::CALL_TIMEOUT, || f.call(id))
        .map_err(|e| anyhow!("manga_details({id:?}): {e}"))?;
    read_manga_details(&table)
}

fn call_volumes(lua: &mlua::Lua, id: &str, language: Option<&str>) -> Result<Vec<VolumeChapters>> {
    let f: mlua::Function = lua
        .globals()
        .get("volumes")
        .map_err(|_| anyhow!("script does not define volumes(id, language)"))?;
    let table: Table = sandbox::call_with_timeout(lua, sandbox::CALL_TIMEOUT, || f.call((id, language)))
        .map_err(|e| anyhow!("volumes({id:?}, {language:?}): {e}"))?;
    read_volume_chapters(&table)
}

fn call_covers(lua: &mlua::Lua, id: &str) -> Result<Vec<VolumeCover>> {
    let f: mlua::Function = lua
        .globals()
        .get("covers")
        .map_err(|_| anyhow!("script does not define covers(id)"))?;
    let table: Table = sandbox::call_with_timeout(lua, sandbox::CALL_TIMEOUT, || f.call(id))
        .map_err(|e| anyhow!("covers({id:?}): {e}"))?;
    read_volume_covers(&table)
}

fn call_page_list(lua: &mlua::Lua, chapter_id: &str) -> Result<Vec<String>> {
    let f: mlua::Function = lua
        .globals()
        .get("page_list")
        .map_err(|_| anyhow!("script does not define page_list(chapter_id)"))?;
    let table: Table = sandbox::call_with_timeout(lua, sandbox::CALL_TIMEOUT, || f.call(chapter_id))
        .map_err(|e| anyhow!("page_list({chapter_id:?}): {e}"))?;
    read_strings(&table)
}

/* ------------------------------------------------------- Lua -> Rust shapes */

fn read_manga_page(table: &Table) -> Result<MangasPage> {
    let rows: Table = table
        .get("manga")
        .map_err(|_| anyhow!("expected a `manga` array"))?;
    let has_next_page: bool = table.get("has_next_page").unwrap_or(false);

    let mut manga = Vec::with_capacity(rows.raw_len());
    for pair in rows.sequence_values::<Table>() {
        let row = pair.map_err(|e| anyhow!("reading a manga entry: {e}"))?;
        manga.push(MangaSummary {
            id: row.get("id").map_err(|_| anyhow!("a manga entry is missing `id`"))?,
            title: row
                .get("title")
                .map_err(|_| anyhow!("a manga entry is missing `title`"))?,
            cover_url: row.get("cover_url").unwrap_or(None),
        });
    }
    Ok(MangasPage { manga, has_next_page })
}

fn read_manga_details(table: &Table) -> Result<MangaDetails> {
    Ok(MangaDetails {
        title: table
            .get("title")
            .map_err(|_| anyhow!("manga_details is missing `title`"))?,
        title_romaji: table.get("title_romaji").unwrap_or(None),
        title_native: table.get("title_native").unwrap_or(None),
        author: table.get("author").unwrap_or(None),
        artist: table.get("artist").unwrap_or(None),
        description: table.get("description").unwrap_or(None),
        tags: table
            .get::<Option<Table>>("tags")
            .unwrap_or(None)
            .map(|t| read_strings(&t))
            .transpose()?
            .unwrap_or_default(),
        content_rating: table.get("content_rating").unwrap_or(None),
        available_languages: table
            .get::<Option<Table>>("available_languages")
            .unwrap_or(None)
            .map(|t| read_strings(&t))
            .transpose()?
            .unwrap_or_default(),
        cover_url: table.get("cover_url").unwrap_or(None),
    })
}

fn read_volume_chapters(table: &Table) -> Result<Vec<VolumeChapters>> {
    let mut volumes = Vec::with_capacity(table.raw_len());
    for pair in table.clone().sequence_values::<Table>() {
        let row = pair.map_err(|e| anyhow!("reading a volume entry: {e}"))?;
        let volume: String = row
            .get("volume")
            .map_err(|_| anyhow!("a volume entry is missing `volume`"))?;
        let chapter_rows: Table = row
            .get("chapters")
            .map_err(|_| anyhow!("volume {volume:?} is missing `chapters`"))?;

        let mut chapters = Vec::with_capacity(chapter_rows.raw_len());
        for pair in chapter_rows.sequence_values::<Table>() {
            let c = pair.map_err(|e| anyhow!("reading a chapter entry: {e}"))?;
            chapters.push(ChapterRef {
                number: c
                    .get("number")
                    .map_err(|_| anyhow!("a chapter entry is missing `number`"))?,
                id: c.get("id").unwrap_or(None),
                unavailable: c.get("unavailable").unwrap_or(false),
            });
        }
        volumes.push(VolumeChapters { volume, chapters });
    }
    Ok(volumes)
}

fn read_volume_covers(table: &Table) -> Result<Vec<VolumeCover>> {
    let mut covers = Vec::with_capacity(table.raw_len());
    for pair in table.clone().sequence_values::<Table>() {
        let row = pair.map_err(|e| anyhow!("reading a cover entry: {e}"))?;
        let url: String = row
            .get("url")
            .map_err(|_| anyhow!("a cover entry is missing `url`"))?;
        // A script that has no separate thumbnail can just omit it.
        let thumbnail_url: String = row.get("thumbnail_url").unwrap_or_else(|_| url.clone());
        covers.push(VolumeCover {
            volume: row.get("volume").unwrap_or(None),
            url,
            thumbnail_url,
        });
    }
    Ok(covers)
}

fn read_strings(table: &Table) -> Result<Vec<String>> {
    table
        .clone()
        .sequence_values::<String>()
        .collect::<mlua::Result<Vec<_>>>()
        .map_err(|e| anyhow!("expected an array of strings: {e}"))
}
