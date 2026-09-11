//! The `library` subcommands.
//!
//! These exist so the whole add → sync → download → build loop can be driven and
//! verified from a terminal, against real sites, without launching the desktop
//! app. That is the fastest way to find out that a page's markup is not what we
//! assumed.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::Subcommand;
use mangalize_library::model::{NewSeries, PublishedChapter, PublishedVolume};
use mangalize_library::{Library, SeriesId};

#[derive(Subcommand)]
pub enum LibraryCommand {
    /// Add a series by searching the metadata sources, and pull its layout.
    Add {
        /// Series name to search for.
        query: String,
        /// Which search result to take, 1-based.
        #[arg(long, default_value_t = 1)]
        pick: usize,
    },
    /// Add a series by hand, for titles no metadata source carries.
    New {
        title: String,
        #[arg(long, default_value = "")]
        author: String,
    },
    /// List every series in the library.
    List,
    /// Show a series' volumes and which chapters are missing.
    Status { series: i64 },
    /// Remove a series from the library.
    Remove {
        series: i64,
        /// Also delete its downloaded images. Off by default, and irreversible.
        #[arg(long)]
        delete_files: bool,
    },
    /// Re-pull the published volume layout for a series.
    Sync { series: i64 },
    /// List the images a chapter page offers, without downloading anything.
    Peek { url: String },
    /// Download a chapter's pages from a URL into the library.
    Get {
        series: i64,
        /// Chapter number as published, e.g. `7` or `7.5`.
        chapter: String,
        /// Page holding the chapter's images.
        url: String,
        /// Take every image found, not just the ones that look like pages.
        #[arg(long)]
        all: bool,
    },
    /// Build a stored volume into an EPUB or CBZ.
    Build {
        series: i64,
        volume: String,
        #[arg(short, long)]
        out: PathBuf,
    },
}

pub fn run(root: Option<PathBuf>, command: LibraryCommand) -> Result<()> {
    let mut library = Library::open(resolve_root(root)?)?;

    match command {
        LibraryCommand::Add { query, pick } => add(&mut library, &query, pick),
        LibraryCommand::New { title, author } => new(&mut library, &title, &author),
        LibraryCommand::List => list(&library),
        LibraryCommand::Status { series } => status(&library, SeriesId(series)),
        LibraryCommand::Remove { series, delete_files } => {
            remove(&library, SeriesId(series), delete_files)
        }
        LibraryCommand::Sync { series } => sync(&mut library, SeriesId(series)),
        LibraryCommand::Peek { url } => peek(&url),
        LibraryCommand::Get { series, chapter, url, all } => {
            get(&library, SeriesId(series), &chapter, &url, all)
        }
        LibraryCommand::Build { series, volume, out } => {
            build(&library, SeriesId(series), &volume, &out)
        }
    }
}

/// Where the library lives: the flag, else the environment, else a folder in
/// the user's home. Never a hidden directory — this is the user's collection.
pub fn resolve_root(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(root) = explicit {
        return Ok(root);
    }
    if let Ok(root) = std::env::var("MANGALIZE_LIBRARY") {
        return Ok(PathBuf::from(root));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .context("no HOME set; pass --library")?;
    Ok(PathBuf::from(home).join("Mangalize"))
}

fn add(library: &mut Library, query: &str, pick: usize) -> Result<()> {
    let hits = mangalize_meta::search(query, 8)?;
    if hits.is_empty() {
        bail!("no matches for {query:?}");
    }
    if pick == 0 || pick > hits.len() {
        for (i, hit) in hits.iter().enumerate() {
            println!("{:>2}  {}  [{:?}]", i + 1, hit.display_title(), hit.source);
        }
        bail!("--pick must be between 1 and {}", hits.len());
    }

    let hit = &hits[pick - 1];
    let series = library.add_series(NewSeries {
        source: Some(format!("{:?}", hit.source).to_lowercase()),
        source_id: Some(hit.id.clone()),
        title: hit.display_title().to_string(),
        title_romaji: hit.title_romaji.clone(),
        title_native: hit.title_native.clone(),
        author: hit.author.clone().unwrap_or_default(),
        artist: hit.artist.clone().unwrap_or_default(),
        description: hit.description.clone().unwrap_or_default(),
        year: hit.year,
        status: hit.status.clone(),
        site_url: hit.site_url.clone(),
    })?;

    println!("added [{}] {}", series.id.0, series.title);
    println!("       {}", series.folder.display());
    sync(library, series.id)
}

/// Add a series with no upstream source.
///
/// Nothing will sync it, so every chapter arrives as an orphan under
/// `Unsorted` until the user says which volume it belongs to.
fn new(library: &mut Library, title: &str, author: &str) -> Result<()> {
    let series = library.add_series(NewSeries {
        title: title.to_string(),
        author: author.to_string(),
        ..NewSeries::default()
    })?;
    println!("added [{}] {}", series.id.0, series.title);
    println!("       {}", series.folder.display());
    Ok(())
}

fn sync(library: &mut Library, id: SeriesId) -> Result<()> {
    let series = library.series(id)?;
    let (source, source_id) = match (&series.source, &series.source_id) {
        (Some(source), Some(source_id)) => (source.clone(), source_id.clone()),
        _ => bail!("{} was added by hand and has no source to sync from", series.title),
    };

    let source = parse_source(&source)?;
    let published = mangalize_meta::volume_chapters(source, &source_id)?;
    let covers = mangalize_meta::volume_covers(source, &source_id)?;

    let volumes: Vec<PublishedVolume> = published
        .into_iter()
        .map(|v| PublishedVolume {
            cover_url: covers
                .iter()
                .find(|c| c.volume.as_deref() == Some(v.volume.as_str()))
                .map(|c| c.url.clone()),
            chapters: v
                .chapters
                .into_iter()
                .map(|number| PublishedChapter { number, title: None })
                .collect(),
            number: v.volume,
        })
        .collect();

    let report = library.sync_layout(id, &volumes)?;
    println!(
        "{}: {} volumes, {} new chapters{}",
        series.title,
        report.volumes,
        report.chapters_added,
        if report.orphaned > 0 {
            format!(", {} held but unlisted", report.orphaned)
        } else {
            String::new()
        }
    );
    Ok(())
}

fn list(library: &Library) -> Result<()> {
    let all = library.all_series()?;
    if all.is_empty() {
        println!("library is empty — try `mangalize library add \"…\"`");
        return Ok(());
    }
    for series in all {
        println!(
            "{:>3}  {:<44} {:>4}/{:<4} chapters",
            series.id.0,
            truncate(&series.title, 44),
            series.have_chapters,
            series.known_chapters
        );
    }
    Ok(())
}

fn status(library: &Library, id: SeriesId) -> Result<()> {
    let series = library.series(id)?;
    println!("{}", series.title);
    if !series.author.is_empty() {
        println!("{}", series.author);
    }
    println!();

    for volume in library.volumes(id)? {
        let missing: Vec<&str> = volume
            .chapters
            .iter()
            .filter(|c| !c.downloaded())
            .map(|c| c.number.as_str())
            .collect();

        println!(
            "volume {:<8} {}/{} chapters{}",
            volume.number,
            volume.have(),
            volume.chapters.len(),
            if volume.complete() { "  complete" } else { "" }
        );
        if !missing.is_empty() {
            println!("    missing  {}", missing.join(", "));
        }
    }
    Ok(())
}

fn remove(library: &Library, id: SeriesId, delete_files: bool) -> Result<()> {
    let series = library.series(id)?;
    library.remove_series(id, delete_files)?;

    println!("removed {}", series.title);
    if delete_files {
        println!("deleted {}", series.folder.display());
    } else {
        println!("files kept in {}", series.folder.display());
    }
    Ok(())
}

fn peek(url: &str) -> Result<()> {
    let found = mangalize_fetch::extract_page(url, &mut progress("measuring"))?;
    eprintln!();

    if found.candidates.is_empty() {
        println!("no images in that page's markup.");
        println!("it probably builds itself in JavaScript — use the desktop app,");
        println!("which can render the page and harvest what it actually loads.");
        return Ok(());
    }

    for (i, candidate) in found.candidates.iter().enumerate() {
        println!(
            "{:>3}  {:>5}x{:<5} {:<9} {}  {}",
            i + 1,
            candidate.width,
            candidate.height,
            format!("{:?}", candidate.verdict).to_lowercase(),
            if candidate.selected { "take" } else { "skip" },
            truncate(&candidate.url, 70)
        );
    }
    Ok(())
}

fn get(library: &Library, id: SeriesId, chapter: &str, url: &str, all: bool) -> Result<()> {
    let found = mangalize_fetch::extract_page(url, &mut progress("measuring"))?;
    eprintln!();

    let chosen: Vec<String> = found
        .candidates
        .iter()
        .filter(|c| all || c.selected)
        .map(|c| c.url.clone())
        .collect();

    if chosen.is_empty() {
        bail!("nothing to download from that page (try --all, or `library peek` first)");
    }

    let dest = library.chapter_dir(id, chapter)?;
    let written = mangalize_fetch::download_pages(
        &chosen,
        &dest,
        Some(&found.page_url),
        &mut progress("downloading"),
    )?;
    eprintln!();

    let stored = library.record_chapter(id, chapter, written.len() as u32, Some(url))?;
    println!(
        "chapter {} — {} pages into {}",
        stored.number,
        written.len(),
        dest.display()
    );
    Ok(())
}

fn build(library: &Library, id: SeriesId, volume_number: &str, out: &PathBuf) -> Result<()> {
    let volume = library.build_volume(id, volume_number)?;
    if volume.total_included() == 0 {
        bail!("volume {volume_number} has no pages");
    }

    match out.extension().and_then(|e| e.to_str()) {
        Some("cbz") => mangalize_core::writers::cbz::write(&volume, out)?,
        _ => mangalize_core::writers::epub::write(&volume, out)?,
    }

    let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    println!(
        "wrote {} ({} chapters, {} pages, {:.1} MB)",
        out.display(),
        volume.chapters.len(),
        volume.total_included(),
        size as f64 / 1_048_576.0
    );
    Ok(())
}

/// A one-line progress counter on stderr, so piping stdout stays clean.
fn progress(label: &'static str) -> impl FnMut(usize, usize) {
    move |done, total| {
        eprint!("\r{label} {done}/{total}");
    }
}

fn parse_source(name: &str) -> Result<mangalize_meta::Source> {
    match name {
        "mangadex" => Ok(mangalize_meta::Source::MangaDex),
        "kitsu" => Ok(mangalize_meta::Source::Kitsu),
        other => bail!("unknown metadata source {other:?}"),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{kept}…")
}
