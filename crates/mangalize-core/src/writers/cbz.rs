//! CBZ output: a zip of pages plus a `ComicInfo.xml` for readers that use it
//! (Komga, Kavita, Tachiyomi, ComicRack).

use std::fs::File;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::{ensure_parent, esc, render_page, Progress};
use crate::project::{Direction, Volume};

/// Write `volume` to `out` as a CBZ.
pub fn write(volume: &Volume, out: &Path) -> Result<()> {
    write_with_progress(volume, out, &mut |_, _| {})
}

/// As [`write`], reporting `(pages_done, pages_total)` as each page is encoded.
pub fn write_with_progress(volume: &Volume, out: &Path, progress: &mut Progress) -> Result<()> {
    ensure_parent(out)?;
    let file = File::create(out).with_context(|| format!("creating {}", out.display()))?;
    let mut zip = ZipWriter::new(file);

    // JPEGs are already compressed; storing them avoids pointless CPU burn.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let direction = volume.metadata.direction;
    let mut page_no = 0usize;
    let total = volume.total_included();
    let mut done = 0usize;

    for (ci, chapter) in volume.chapters.iter().enumerate() {
        for page in chapter.included() {
            let rendered_pages = render_page(page, direction)?;
            done += 1;
            progress(done, total);
            for rendered in rendered_pages {
                page_no += 1;
                // Flat, zero-padded names so every reader sorts them identically.
                let name = format!("{:03}_{page_no:04}.{}", ci + 1, rendered.ext);
                zip.start_file(name, stored)?;
                zip.write_all(&rendered.bytes)?;
            }
        }
    }

    zip.start_file("ComicInfo.xml", deflated)?;
    zip.write_all(comic_info(volume, page_no).as_bytes())?;

    zip.finish()?;
    Ok(())
}

/// Minimal ComicInfo.xml. Unknown fields are omitted rather than left blank,
/// which readers handle better.
fn comic_info(volume: &Volume, page_count: usize) -> String {
    let m = &volume.metadata;
    let mut fields = vec![
        format!("  <Title>{}</Title>", esc(&m.display_title())),
        format!("  <Series>{}</Series>", esc(&m.series)),
        format!("  <PageCount>{page_count}</PageCount>"),
        format!("  <LanguageISO>{}</LanguageISO>", esc(&m.language)),
        format!(
            "  <Manga>{}</Manga>",
            match m.direction {
                Direction::RightToLeft => "YesAndRightToLeft",
                Direction::LeftToRight => "Yes",
            }
        ),
    ];
    if let Some(v) = m.volume {
        fields.push(format!("  <Volume>{v}</Volume>"));
    }
    if !m.author.is_empty() {
        fields.push(format!("  <Writer>{}</Writer>", esc(&m.author)));
    }
    if !m.description.is_empty() {
        fields.push(format!("  <Summary>{}</Summary>", esc(&m.description)));
    }

    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
         <ComicInfo xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\n\
         {}\n</ComicInfo>\n",
        fields.join("\n")
    )
}
