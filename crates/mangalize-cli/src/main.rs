//! Command line front end. Exercises exactly the same core pipeline the desktop
//! app will, which makes it the fastest way to verify a scan against real data.

use std::path::PathBuf;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand, ValueEnum};
use mangalize_core::page::{ExcludeReason, PageKind};
use mangalize_core::project::Direction;
use mangalize_core::{scan_volume, writers};

#[derive(Parser)]
#[command(name = "mangalize", about = "Turn folders of manga chapters into readable volumes")]
struct Cli {
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
        /// Cut every detected double-page spread into two pages.
        #[arg(long)]
        split_spreads: bool,
    },
}

#[derive(Copy, Clone, ValueEnum)]
enum Format {
    /// Fixed-layout EPUB 3 with Kindle hints. Send this one to a Kindle.
    Epub,
    /// Comic archive for Komga, Kavita, Tachiyomi and desktop readers.
    Cbz,
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Scan { folder, verbose } => scan(folder, verbose),
        Command::Build {
            folder,
            out,
            format,
            title,
            author,
            ltr,
            split_spreads,
        } => build(folder, out, format, title, author, ltr, split_spreads),
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
    split_spreads: bool,
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
    if split_spreads {
        for chapter in &mut volume.chapters {
            for page in &mut chapter.pages {
                if page.kind == PageKind::Spread {
                    page.split = true;
                }
            }
        }
    }

    if volume.total_included() == 0 {
        bail!("no pages found in {}", folder.display());
    }

    match format {
        Format::Epub => writers::epub::write(&volume, &out)?,
        Format::Cbz => writers::cbz::write(&volume, &out)?,
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
