//! The `sources` subcommands.
//!
//! A way to exercise a source — built-in or a `.lua` script under development
//! — from a terminal, the same reasoning as the `library` subcommands: it is
//! much the fastest way to find out a script's `SOURCE.base_url`/selectors are
//! wrong, without launching the desktop app.

use anyhow::{Context, Result};
use clap::Subcommand;
use leaf_extensions::lua::LuaSource;
use leaf_extensions::{Registry, Source};

#[derive(Subcommand)]
pub enum SourcesCommand {
    /// List every registered source.
    List,
    /// Run a `.lua` source script against one manga id and print what it
    /// returns, without registering it anywhere.
    Test {
        script: std::path::PathBuf,
        /// Manga id to look up, in whatever form the source expects.
        id: String,
        /// Also print the source's popular list, page 1.
        #[arg(long)]
        popular: bool,
    },
}

pub fn run(command: SourcesCommand) -> Result<()> {
    match command {
        SourcesCommand::List => list(),
        SourcesCommand::Test { script, id, popular } => test(&script, &id, popular),
    }
}

fn list() -> Result<()> {
    for info in Registry::load_builtin().all() {
        println!("{:<24} {:<20} {}", info.id, info.name, info.lang);
    }
    Ok(())
}

fn test(script: &std::path::Path, id: &str, popular: bool) -> Result<()> {
    let text = std::fs::read_to_string(script)
        .with_context(|| format!("reading {}", script.display()))?;
    let source = LuaSource::load(text).context("loading the source script")?;

    println!("id       {}", source.info().id);
    println!("name     {}", source.info().name);
    println!("lang     {}", source.info().lang);
    println!("base_url {}", source.info().base_url);
    println!();

    if popular {
        let page = source.popular(1).context("popular(1)")?;
        println!("popular  {} results, has_next_page={}", page.manga.len(), page.has_next_page);
        for m in &page.manga {
            println!("  {:<20} {}", m.id, m.title);
        }
        println!();
    }

    let details = source.manga_details(id).context("manga_details")?;
    println!("title    {}", details.title);
    if let Some(author) = &details.author {
        println!("author   {author}");
    }
    println!("tags     {}", details.tags.join(", "));

    let volumes = source.volumes(id, None).context("volumes")?;
    println!("volumes  {}", volumes.len());
    for v in &volumes {
        println!("  volume {:<4} {} chapters", v.volume, v.chapters.len());
    }

    let covers = source.covers(id).context("covers")?;
    println!("covers   {}", covers.len());

    if let Some(first) = volumes.first().and_then(|v| v.chapters.first()) {
        if let Some(chapter_id) = &first.id {
            let pages = source.page_list(chapter_id).context("page_list")?;
            println!("chapter {} has {} pages", first.number, pages.len());
        }
    }

    Ok(())
}
