//! Command line front end. Exercises exactly the same core pipeline the desktop
//! app will, which makes it the fastest way to verify a scan against real data.

mod library;

use std::path::PathBuf;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand, ValueEnum};
use mangalize_core::page::{ExcludeReason, PageKind};
use mangalize_core::project::Direction;
use mangalize_core::{scan_volume, writers};

#[derive(Parser)]
#[command(name = "mangalize", about = "Turn folders of manga chapters into readable volumes")]
struct Cli {
    /// Library folder. Defaults to $MANGALIZE_LIBRARY, else ~/Mangalize.
    #[arg(long, global = true)]
    library: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show what the scanner found, without writing anything.
    Scan {
        folder: PathBuf,
        /// List every page, not just a summary.
        #[arg(short, long)]
        verbose: bool,
    },
    /// Manage the library: add series, fetch chapters, build volumes.
    Library {
        #[command(subcommand)]
        command: library::LibraryCommand,
    },
    /// Look up series metadata online.
    Lookup {
        /// Series name to search for.
        query: String,
        /// Also list volume covers and the published chapter layout.
        #[arg(short, long)]
        detail: bool,
    },
    /// Build a volume file.
    Build {
        folder: PathBuf,
        #[arg(short, long)]
        out: PathBuf,
        #[arg(short, long, value_enum, default_value_t = Format::Epub)]
        format: Format,
        /// Override the series title guessed from the folder name.
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        author: Option<String>,
        /// Read left-to-right instead of the right-to-left default.
        #[arg(long)]
        ltr: bool,
        /// Keep double-page spreads whole instead of cutting them in two.
        ///
        /// Splitting is the default: a Kindle zooms into part of a wide page
        /// rather than fitting it, so half the drawing goes unseen.
        #[arg(long)]
        keep_spreads: bool,
        /// How hard to shrink pages. Scraped pages are routinely far larger
        /// than any e-reader can display.
        #[arg(long, value_enum, default_value_t = Compress::Kindle)]
        compress: Compress,
    },
}

/// How hard to shrink pages on export.
#[derive(Copy, Clone, ValueEnum)]
enum Compress {
    /// Leave every page exactly as scanned.
    Original,
    /// 2400px, for a Kindle Scribe or a tablet.
    Large,
    /// 1600px, sized for a Paperwhite or Oasis. The default.
    Kindle,
    /// 1280px, when the volume has to fit an email attachment.
    Compact,
}

impl Compress {
    fn settings(self) -> mangalize_core::Compression {
        use mangalize_core::Compression;
        match self {
            Compress::Original => Compression::ORIGINAL,
            Compress::Large => Compression::LARGE,
            Compress::Kindle => Compression::KINDLE,
            Compress::Compact => Compression::COMPACT,
        }
    }
}

#[derive(Copy, Clone, ValueEnum)]
enum Format {
    /// Fixed-layout EPUB 3 with Kindle hints. Send this one to a Kindle.
    Epub,
    /// Comic archive for Komga, Kavita, Tachiyomi and desktop readers.
    Cbz,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Library { command } => library::run(cli.library, command),
        Command::Scan { folder, verbose } => scan(folder, verbose),
        Command::Lookup { query, detail } => lookup(&query, detail),
        Command::Build {
            folder,
            out,
            format,
            title,
            author,
            ltr,
            keep_spreads,
            compress,
        } => build(folder, out, format, title, author, ltr, keep_spreads, compress),
    }
}

fn scan(folder: PathBuf, verbose: bool) -> Result<()> {
    let volume = scan_volume(&folder)?;

    println!("series    {}", volume.metadata.series);
    if let Some(v) = volume.metadata.volume {
        println!("volume    {v}");
    }
    println!("chapters  {}", volume.chapters.len());
    println!("pages     {}", volume.total_included());
    println!();

    for chapter in &volume.chapters {
        let spreads = chapter
            .included()
            .filter(|p| p.kind == PageKind::Spread)
            .count();
        let mut line = format!(
            "{:<12} {:>3} pages",
            chapter.title,
            chapter.included_count()
        );
        if spreads > 0 {
            line += &format!(", {spreads} spread");
            if spreads > 1 {
                line.push('s');
            }
        }
        if chapter.excluded_count() > 0 {
            line += &format!(", {} excluded", chapter.excluded_count());
        }
        println!("{line}");

        for page in &chapter.pages {
            let show = verbose || page.excluded.is_some() || page.kind == PageKind::Spread;
            if !show {
                continue;
            }
            println!(
                "    {:<52} {:>5}x{:<5} {}",
                page.file_name(),
                page.width,
                page.height,
                describe(page.excluded.as_ref(), page.kind)
            );
        }
    }

    Ok(())
}

fn lookup(query: &str, detail: bool) -> Result<()> {
    let hits = mangalize_meta::search(query, 5)?;
    if hits.is_empty() {
        println!("no matches for {query:?}");
        return Ok(());
    }

    for hit in &hits {
        println!("{} [{:?}]", hit.display_title(), hit.source);
        for (label, value) in [
            ("english", &hit.title_english),
            ("romaji", &hit.title_romaji),
            ("native", &hit.title_native),
            ("author", &hit.author),
            ("artist", &hit.artist),
        ] {
            if let Some(v) = value {
                println!("    {label:<8} {v}");
            }
        }
        if let Some(y) = hit.year {
            println!("    {:<8} {y}", "year");
        }
        if let Some(d) = &hit.demographic {
            println!("    {:<8} {d}", "demo");
        }
        if let Some(u) = &hit.site_url {
            println!("    {:<8} {u}", "url");
        }

        if detail {
            let covers = mangalize_meta::volume_covers(hit.source, &hit.id)?;
            println!("    covers   {} volumes", covers.len());
            for cover in covers.iter().take(3) {
                println!(
                    "      vol {:<4} {}",
                    cover.volume.as_deref().unwrap_or("-"),
                    cover.url
                );
            }

            let volumes = mangalize_meta::volume_chapters(hit.source, &hit.id)?;
            for volume in volumes.iter().take(3) {
                println!(
                    "      volume {} = {} chapters ({})",
                    volume.volume,
                    volume.chapters.len(),
                    volume
                        .chapters
                        .iter()
                        .map(|c| c.number.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
        }
        println!();
    }
    Ok(())
}

fn describe(excluded: Option<&ExcludeReason>, kind: PageKind) -> String {
    match excluded {
        None if kind == PageKind::Spread => "spread".into(),
        None => String::new(),
        Some(ExcludeReason::NotAPage) => "excluded: not a page".into(),
        Some(ExcludeReason::Unreadable) => "excluded: unreadable".into(),
        Some(ExcludeReason::OffSize { .. }) => "excluded: off-size".into(),
        Some(ExcludeReason::Manual) => "excluded: manual".into(),
    }
}

#[allow(clippy::too_many_arguments)]
fn build(
    folder: PathBuf,
    out: PathBuf,
    format: Format,
    title: Option<String>,
    author: Option<String>,
    ltr: bool,
    keep_spreads: bool,
    compress: Compress,
) -> Result<()> {
    let mut volume = scan_volume(&folder)?;

    if let Some(t) = title {
        volume.metadata.series = t;
    }
    if let Some(a) = author {
        volume.metadata.author = a;
    }
    if ltr {
        volume.metadata.direction = Direction::LeftToRight;
    }
    if keep_spreads {
        for chapter in &mut volume.chapters {
            for page in &mut chapter.pages {
                if page.kind == PageKind::Spread {
                    page.split = false;
                }
            }
        }
    }

    if volume.total_included() == 0 {
        bail!("no pages found in {}", folder.display());
    }

    let compression = compress.settings();
    let mut progress = |_: usize, _: usize| {};
    match format {
        Format::Epub => {
            writers::epub::write_with_progress(&volume, &out, &compression, &mut progress)?
        }
        Format::Cbz => {
            writers::cbz::write_with_progress(&volume, &out, &compression, &mut progress)?
        }
    }

    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    println!(
        "wrote {} ({} chapters, {} pages, {:.1} MB)",
        out.display(),
        volume.chapters.len(),
        volume.total_included(),
        size as f64 / 1_048_576.0
    );
    Ok(())
}
