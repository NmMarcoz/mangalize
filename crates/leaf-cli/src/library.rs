//! The `library` subcommands.
//!
//! These exist so the whole add → sync → download → build loop can be driven and
//! verified from a terminal, against real sites, without launching the desktop
//! app. That is the fastest way to find out that a page's markup is not what we
//! assumed.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use clap::Subcommand;
use leaf_extensions::Registry;
use leaf_library::model::{ChapterStatus, NewSeries, PublishedChapter, PublishedVolume, Series};
use leaf_library::{Library, SeriesId};

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
    /// Add a series found directly through a registered source — built in, or
    /// a `.lua` extension — for a site MangaDex/Kitsu don't list at all.
    AddSource {
        /// A registered source id, e.g. `user.mangataro` — see `sources list`.
        source: String,
        query: String,
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
    /// Re-fetch a series' own metadata — title, credits, description, tags
    /// and (if none is set) a cover — rather than its chapter layout.
    Refetch { series: i64 },
    /// Move a batch of chapters into a volume by hand. Locked against a
    /// future `sync` overwriting the choice — see `unlock-volume`.
    AssignVolume {
        series: i64,
        volume: String,
        /// Chapter numbers as published, e.g. `7 7.5 8`.
        chapters: Vec<String>,
    },
    /// Undo a manual assignment and re-pull the real volume from the source.
    UnlockVolume { series: i64, chapters: Vec<String> },
    /// List the images a chapter page offers, without downloading anything.
    Peek { url: String },
    /// Download a chapter's pages into the library.
    Get {
        series: i64,
        /// Chapter number as published, e.g. `7` or `7.5`.
        chapter: String,
        /// Page holding the chapter's images. Omit it for a chapter recorded
        /// from a registered source at `sync` time — its own id is used
        /// instead of scraping a pasted page.
        url: Option<String>,
        /// Take every image found, not just the ones that look like pages.
        /// Only meaningful together with a pasted `url`.
        #[arg(long)]
        all: bool,
    },
    /// Find and download every missing chapter.
    Batch {
        series: i64,
        /// A chapter page, or the series index — either is enough to learn
        /// the site's URL pattern. Omit it for a series added from a
        /// registered source; each chapter's own id (recorded at `sync` time)
        /// is used instead.
        url: Option<String>,
        /// Show the plan and stop, without downloading anything.
        #[arg(long)]
        dry_run: bool,
    },
    /// Build a stored volume into an EPUB or CBZ.
    Build {
        series: i64,
        volume: String,
        #[arg(short, long)]
        out: PathBuf,
    },
    /// Download any published volume covers not already on disk.
    DownloadCovers { series: i64 },
}

pub fn run(root: Option<PathBuf>, command: LibraryCommand) -> Result<()> {
    let root = resolve_root(root)?;
    let mut library = Library::open(&root)?;
    let registry = load_registry(&root);

    match command {
        LibraryCommand::Add { query, pick } => add(&mut library, &registry, &query, pick),
        LibraryCommand::AddSource { source, query, pick } => {
            add_source(&mut library, &registry, &source, &query, pick)
        }
        LibraryCommand::New { title, author } => new(&mut library, &title, &author),
        LibraryCommand::List => list(&library),
        LibraryCommand::Status { series } => status(&library, SeriesId(series)),
        LibraryCommand::Remove { series, delete_files } => {
            remove(&library, SeriesId(series), delete_files)
        }
        LibraryCommand::Sync { series } => sync(&mut library, &registry, SeriesId(series)),
        LibraryCommand::Refetch { series } => refetch(&library, &registry, SeriesId(series)),
        LibraryCommand::AssignVolume { series, volume, chapters } => {
            assign_volume(&mut library, SeriesId(series), &volume, &chapters)
        }
        LibraryCommand::UnlockVolume { series, chapters } => {
            unlock_volume(&mut library, SeriesId(series), &chapters)
        }
        LibraryCommand::Peek { url } => peek(&url),
        LibraryCommand::Get { series, chapter, url, all } => {
            get(&library, &registry, SeriesId(series), &chapter, url.as_deref(), all)
        }
        LibraryCommand::Batch { series, url, dry_run } => {
            batch(&library, &registry, SeriesId(series), url.as_deref(), dry_run)
        }
        LibraryCommand::Build { series, volume, out } => {
            build(&library, SeriesId(series), &volume, &out)
        }
        LibraryCommand::DownloadCovers { series } => download_covers(&library, SeriesId(series)),
    }
}

/// Built-in sources plus every `.lua` file under `<library>/extensions/` —
/// the same folder either front end could point a user at, per this crate's
/// `sources` doc. A script that fails to load only warns: one typo in one
/// extension must not make every other `library` command unusable.
fn load_registry(root: &Path) -> Registry {
    let mut registry = Registry::load_builtin();
    for (path, e) in registry.load_user_extensions(&root.join("extensions")) {
        eprintln!("warning: {} failed to load: {e:#}", path.display());
    }
    registry
}

/// Where the library lives: the flag, else the environment, else a folder in
/// the user's home. Never a hidden directory — this is the user's collection.
pub fn resolve_root(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(root) = explicit {
        return Ok(root);
    }
    if let Ok(root) = std::env::var("leaf_library") {
        return Ok(PathBuf::from(root));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .context("no HOME set; pass --library")?;
    Ok(PathBuf::from(home).join("Leaf"))
}

fn add(library: &mut Library, registry: &Registry, query: &str, pick: usize) -> Result<()> {
    let hits = leaf_meta::search(query, 8)?;
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
        tags: hit.tags.iter().map(|t| t.name.clone()).collect(),
        content_rating: hit.content_rating.clone(),
    })?;

    println!("added [{}] {}", series.id.0, series.title);
    println!("       {}", series.folder.display());
    sync(library, registry, series.id)
}

/// Add a series found through a registered source directly — a built-in one,
/// or a `.lua` extension for a site MangaDex/Kitsu have no listing for at
/// all. `manga_details` is fetched right away for the fields the search
/// result itself doesn't carry (author, description, tags).
fn add_source(
    library: &mut Library,
    registry: &Registry,
    source_id: &str,
    query: &str,
    pick: usize,
) -> Result<()> {
    let source = registry
        .get(source_id)
        .ok_or_else(|| anyhow!("unknown source {source_id:?} — see `Leaf sources list`"))?;

    let hits = source.search(query, 1)?.manga;
    if hits.is_empty() {
        bail!("no matches for {query:?} on {source_id}");
    }
    if pick == 0 || pick > hits.len() {
        for (i, hit) in hits.iter().enumerate() {
            println!("{:>2}  {}", i + 1, hit.title);
        }
        bail!("--pick must be between 1 and {}", hits.len());
    }

    let hit = &hits[pick - 1];
    let details = leaf_extensions::MangaDetails::best_effort(source.as_ref(), &hit.id, &hit.title);
    let series = library.add_series(NewSeries {
        source: Some(source_id.to_string()),
        source_id: Some(hit.id.clone()),
        title: details.title,
        title_romaji: details.title_romaji,
        title_native: details.title_native,
        author: details.author.unwrap_or_default(),
        artist: details.artist.unwrap_or_default(),
        description: details.description.unwrap_or_default(),
        year: None,
        status: None,
        site_url: None,
        tags: details.tags,
        content_rating: details.content_rating,
    })?;

    println!("added [{}] {}", series.id.0, series.title);
    println!("       {}", series.folder.display());
    sync(library, registry, series.id)
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

fn sync(library: &mut Library, registry: &Registry, id: SeriesId) -> Result<()> {
    let series = library.series(id)?;
    let (source, source_id) = match (&series.source, &series.source_id) {
        (Some(source), Some(source_id)) => (source.clone(), source_id.clone()),
        _ => bail!("{} was added by hand and has no source to sync from", series.title),
    };

    let (mut published, mut covers) = if let Ok(meta_source) = parse_source(&source) {
        (
            leaf_meta::volume_chapters(meta_source, &source_id)?,
            leaf_meta::volume_covers(meta_source, &source_id)?,
        )
    } else {
        let extension = registry
            .get(&source)
            .ok_or_else(|| anyhow!("unknown source {source:?} — is its extension installed?"))?;
        (extension.volumes(&source_id, None)?, extension.covers(&source_id)?)
    };

    // A flat, volume-less source (most scraped sites) gets a best-effort
    // remap onto MangaDex's own volume numbers, rather than shipping every
    // chapter into "Unsorted" when MangaDex would actually know better.
    if published.len() == 1 && published[0].volume == leaf_library::UNSORTED {
        if let Some((remapped, mangadex_covers)) =
            leaf_meta::mangadex::remap_onto_volumes(&series.title, &published)
        {
            let matched: usize = remapped
                .iter()
                .filter(|v| v.volume != leaf_library::UNSORTED)
                .map(|v| v.chapters.len())
                .sum();
            println!("matched {matched} chapters to MangaDex's volume numbers");
            published = remapped;
            // The source's own gallery (if any) has no idea these volume
            // numbers exist, so MangaDex's own covers are the only ones that
            // can actually match them; kept second so a real match from the
            // source's own gallery still wins where one somehow exists.
            for cover in mangadex_covers {
                if !covers.iter().any(|c| c.volume == cover.volume) {
                    covers.push(cover);
                }
            }
        }
    }

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
                .map(|c| PublishedChapter {
                    number: c.number,
                    title: None,
                    source_id: c.id,
                    unavailable: c.unavailable,
                })
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

/// Re-fetch a series' own metadata — title, credits, description, tags and
/// (if none is set yet) a cover — rather than its chapter layout. Its own
/// command rather than folded into `sync`: re-pulling the chapter list and
/// re-fetching the blurb are different costs and different failure modes.
///
/// Runs the same fallback chain `add`/`add-source` do at add time
/// (`MangaDetails::best_effort`): the source's own listing first for a
/// registered extension, MangaDex falling back to Kitsu for the metadata
/// pair, then AniList, then Jikan, for whatever is still blank.
fn refetch(library: &Library, registry: &Registry, id: SeriesId) -> Result<()> {
    let series = library.series(id)?;
    let (source, source_id) = match (&series.source, &series.source_id) {
        (Some(source), Some(source_id)) => (source.clone(), source_id.clone()),
        _ => bail!("{} was added by hand and has no source to refetch from", series.title),
    };

    let details = if parse_source(&source).is_ok() {
        // MangaDex/Kitsu are themselves the metadata pair, so there is no
        // source page of their own to try first.
        let mut details = leaf_extensions::MangaDetails::default();
        details.fill_from_metadata_search(&series.title);
        details
    } else {
        let extension = registry
            .get(&source)
            .ok_or_else(|| anyhow!("unknown source {source:?} — is its extension installed?"))?;
        leaf_extensions::MangaDetails::best_effort(extension.as_ref(), &source_id, &series.title)
    };

    library.set_classification(id, &details.tags, details.content_rating.as_deref())?;

    // Only when there is none already: improving the blurb must not silently
    // replace a cover the user picked by hand.
    if series.cover_path.is_none() {
        if let Some(url) = &details.cover_url {
            if let Ok(bytes) = leaf_meta::download_image(url) {
                library.set_cover(id, &bytes)?;
            }
        }
    }

    let updated = library.set_fetched_metadata(
        id,
        &leaf_library::FetchedMetadata {
            title: if details.title.is_empty() { series.title.clone() } else { details.title },
            title_romaji: details.title_romaji,
            title_native: details.title_native,
            author: details.author.unwrap_or_default(),
            artist: details.artist.unwrap_or_default(),
            description: details.description.unwrap_or_default(),
        },
    )?;
    println!("refetched {}", updated.title);
    Ok(())
}

/// Move a batch of chapters into a volume by hand, locked against a future
/// sync overwriting the choice.
fn assign_volume(library: &mut Library, id: SeriesId, volume: &str, chapters: &[String]) -> Result<()> {
    if chapters.is_empty() {
        bail!("no chapters given");
    }
    library.assign_chapters_to_volume(id, chapters, volume)?;
    println!("assigned {} chapter(s) to volume {volume}", chapters.len());
    Ok(())
}

/// Undo a manual assignment. Only clears the lock and drops the chapter to
/// "Unsorted" — run `sync` afterward to re-pull the real volume.
fn unlock_volume(library: &mut Library, id: SeriesId, chapters: &[String]) -> Result<()> {
    if chapters.is_empty() {
        bail!("no chapters given");
    }
    library.unlock_chapters(id, chapters)?;
    println!("unlocked {} chapter(s) — run `sync` to re-pull their real volume", chapters.len());
    Ok(())
}

fn list(library: &Library) -> Result<()> {
    let all = library.all_series()?;
    if all.is_empty() {
        println!("library is empty — try `Leaf library add \"…\"`");
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
    let found = leaf_fetch::extract_page(url, &mut progress("measuring"))?;
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

fn get(
    library: &Library,
    registry: &Registry,
    id: SeriesId,
    chapter: &str,
    url: Option<&str>,
    all: bool,
) -> Result<()> {
    let (chosen, referer) = match url {
        Some(url) => {
            let found = leaf_fetch::extract_page(url, &mut progress("measuring"))?;
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
            (chosen, found.page_url)
        }
        None => pages_from_source(library, registry, id, chapter)?,
    };

    let dest = library.chapter_dir(id, chapter)?;
    let written =
        leaf_fetch::download_pages(&chosen, &dest, Some(&referer), &mut progress("downloading"))?;
    eprintln!();

    let stored = library.record_chapter(id, chapter, written.len() as u32, Some(&referer))?;
    println!(
        "chapter {} — {} pages into {}",
        stored.number,
        written.len(),
        dest.display()
    );
    Ok(())
}

/// Look up a chapter's own source id — recorded on its row at `sync` time,
/// from `PublishedChapter::source_id` — and fetch its page URLs directly
/// through the registered source that indexed it, rather than scraping a
/// pasted page. This is what `Source::page_list` exists for.
///
/// The source's `base_url` stands in for a real chapter-page referer: `Source`
/// only hands back image URLs, not the reader page they came from, and a
/// site's hotlink check almost always only cares about the referer's origin.
fn pages_from_source(
    library: &Library,
    registry: &Registry,
    id: SeriesId,
    chapter: &str,
) -> Result<(Vec<String>, String)> {
    let series = library.series(id)?;
    let source_name = series
        .source
        .as_deref()
        .ok_or_else(|| anyhow!("{} has no source — pass a URL instead", series.title))?;
    let source = registry
        .get(source_name)
        .ok_or_else(|| anyhow!("{source_name:?} is not a registered source — pass a URL instead"))?;

    let chapter_source_id = library
        .volumes(id)?
        .into_iter()
        .flat_map(|v| v.chapters)
        .find(|c| c.number == chapter)
        .and_then(|c| c.source_id)
        .ok_or_else(|| anyhow!("chapter {chapter} has no source id on record — pass a URL instead"))?;

    eprint!("fetching chapter {chapter} from {source_name}");
    let pages = source.page_list(&chapter_source_id)?;
    eprintln!();
    if pages.is_empty() {
        bail!("no page images found");
    }
    Ok((pages, source.info().base_url.clone()))
}

fn batch(library: &Library, registry: &Registry, id: SeriesId, url: Option<&str>, dry_run: bool) -> Result<()> {
    let series = library.series(id)?;

    // Only the gaps. There is no crawling outward: the published layout decides
    // what is worth looking for, and the library decides what is already here.
    let missing: Vec<ChapterStatus> = library
        .volumes(id)?
        .into_iter()
        .flat_map(|v| v.chapters)
        .filter(|c| !c.downloaded())
        .collect();

    if missing.is_empty() {
        println!("{} has no missing chapters.", series.title);
        return Ok(());
    }
    println!("{} is missing {} chapters.", series.title, missing.len());

    match url {
        Some(url) => batch_by_url(library, id, &missing, url, dry_run),
        None => batch_from_source(library, registry, id, &series, &missing, dry_run),
    }
}

fn batch_by_url(library: &Library, id: SeriesId, missing: &[ChapterStatus], url: &str, dry_run: bool) -> Result<()> {
    let wanted: Vec<String> = missing.iter().map(|c| c.number.clone()).collect();
    let plan = leaf_fetch::plan_batch(url, &wanted, &mut progress("checking"))?;
    eprintln!();

    if let Some(pattern) = &plan.pattern {
        println!("pattern  {pattern}");
    }
    println!("found    {} chapters", plan.items.len());
    if !plan.unresolved.is_empty() {
        println!("no url   {}", plan.unresolved.join(", "));
    }
    if plan.items.is_empty() {
        bail!("nothing to download from that URL");
    }

    for item in plan.items.iter().take(5) {
        println!("    {:<6} {:?}  {}", item.number, item.found, item.url);
    }
    if plan.items.len() > 5 {
        println!("    … and {} more", plan.items.len() - 5);
    }

    if dry_run {
        return Ok(());
    }

    let mut failures = 0usize;
    for (index, item) in plan.items.iter().enumerate() {
        // One host, often a small one: take these one at a time.
        if index > 0 {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        eprint!("\r[{}/{}] chapter {}          ", index + 1, plan.items.len(), item.number);

        match fetch_one(library, id, &item.number, &item.url) {
            Ok(pages) => println!("\rchapter {:<6} {pages} pages", item.number),
            Err(e) => {
                failures += 1;
                println!("\rchapter {:<6} failed: {e:#}", item.number);
            }
        }
    }

    println!(
        "\n{} of {} chapters downloaded",
        plan.items.len() - failures,
        plan.items.len()
    );
    Ok(())
}

/// The registered-source counterpart of `batch_by_url`: no URL pattern to
/// discover, since every missing chapter already carries the source's own id
/// on its row (recorded from `PublishedChapter::source_id` at `sync` time).
fn batch_from_source(
    library: &Library,
    registry: &Registry,
    id: SeriesId,
    series: &Series,
    missing: &[ChapterStatus],
    dry_run: bool,
) -> Result<()> {
    let source_name = series
        .source
        .as_deref()
        .ok_or_else(|| anyhow!("{} has no source — pass a chapter URL instead", series.title))?;
    let source = registry
        .get(source_name)
        .ok_or_else(|| anyhow!("{source_name:?} is not a registered source — pass a chapter URL instead"))?;

    let ready: Vec<&ChapterStatus> = missing.iter().filter(|c| c.source_id.is_some()).collect();
    let unresolved: Vec<&str> = missing
        .iter()
        .filter(|c| c.source_id.is_none())
        .map(|c| c.number.as_str())
        .collect();

    println!("found    {} chapters", ready.len());
    if !unresolved.is_empty() {
        println!("no id    {}", unresolved.join(", "));
    }
    if ready.is_empty() {
        bail!("nothing to download from {source_name}");
    }

    for item in ready.iter().take(5) {
        println!("    {:<6} {}", item.number, item.source_id.as_deref().unwrap_or(""));
    }
    if ready.len() > 5 {
        println!("    … and {} more", ready.len() - 5);
    }

    if dry_run {
        return Ok(());
    }

    let mut failures = 0usize;
    for (index, item) in ready.iter().enumerate() {
        // One host, often a small one: take these one at a time.
        if index > 0 {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        eprint!("\r[{}/{}] chapter {}          ", index + 1, ready.len(), item.number);

        // Filtered into `ready` above, so this is always present.
        let chapter_source_id = item.source_id.as_deref().unwrap();
        match fetch_from_source(library, source.as_ref(), id, &item.number, chapter_source_id) {
            Ok(pages) => println!("\rchapter {:<6} {pages} pages", item.number),
            Err(e) => {
                failures += 1;
                println!("\rchapter {:<6} failed: {e:#}", item.number);
            }
        }
    }

    println!("\n{} of {} chapters downloaded", ready.len() - failures, ready.len());
    Ok(())
}

/// Fetch one chapter of a batch into the library, from a registered source's
/// own id rather than a scraped page.
fn fetch_from_source(
    library: &Library,
    source: &dyn leaf_extensions::Source,
    id: SeriesId,
    number: &str,
    chapter_source_id: &str,
) -> Result<usize> {
    let pages = source.page_list(chapter_source_id)?;
    if pages.is_empty() {
        bail!("no page images found");
    }

    let dest = library.chapter_dir(id, number)?;
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }

    let referer = &source.info().base_url;
    let written = leaf_fetch::download_pages(&pages, &dest, Some(referer), &mut |_, _| {})?;
    library.record_chapter(id, number, written.len() as u32, Some(referer))?;
    Ok(written.len())
}

/// Fetch one chapter of a batch into the library.
fn fetch_one(library: &Library, id: SeriesId, number: &str, url: &str) -> Result<usize> {
    let pages = leaf_fetch::chapter_pages(url, &mut |_, _| {})?;
    if pages.is_empty() {
        bail!("no page images found");
    }

    let dest = library.chapter_dir(id, number)?;
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }

    let written = leaf_fetch::download_pages(&pages, &dest, Some(url), &mut |_, _| {})?;
    library.record_chapter(id, number, written.len() as u32, Some(url))?;
    Ok(written.len())
}

fn build(library: &Library, id: SeriesId, volume_number: &str, out: &PathBuf) -> Result<()> {
    let volume = library.build_volume(id, volume_number)?;
    if volume.total_included() == 0 {
        bail!("volume {volume_number} has no pages");
    }

    match out.extension().and_then(|e| e.to_str()) {
        Some("cbz") => leaf_core::writers::cbz::write(&volume, out)?,
        _ => leaf_core::writers::epub::write(&volume, out)?,
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

fn download_covers(library: &Library, id: SeriesId) -> Result<()> {
    let mut fetched = 0;
    for (number, url) in library.volumes_missing_covers(id)? {
        match leaf_meta::download_image(&url).and_then(|bytes| library.set_volume_cover(id, &number, &bytes)) {
            Ok(_) => fetched += 1,
            Err(e) => println!("volume {number} failed: {e:#}"),
        }
    }
    println!("{fetched} cover(s) downloaded");
    Ok(())
}

/// A one-line progress counter on stderr, so piping stdout stays clean.
fn progress(label: &'static str) -> impl FnMut(usize, usize) {
    move |done, total| {
        eprint!("\r{label} {done}/{total}");
    }
}

fn parse_source(name: &str) -> Result<leaf_meta::Source> {
    match name {
        "mangadex" => Ok(leaf_meta::Source::MangaDex),
        "kitsu" => Ok(leaf_meta::Source::Kitsu),
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
