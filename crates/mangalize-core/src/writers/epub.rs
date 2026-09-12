//! EPUB 3 fixed-layout output, tuned for Kindle.
//!
//! Amazon's Send to Kindle accepts EPUB and converts it to KFX on device. To get
//! comic behaviour rather than a reflowable text book, the package needs three
//! things: `rendition:layout` set to `pre-paginated`, a per-page viewport that
//! matches the image exactly, and Amazon's own `book-type`/`fixed-layout` hints.
//! The last group uses EPUB 2 style `name`/`content` meta elements, which is what
//! Kindle reads even in an EPUB 3 package.

use std::fs::File;
use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::timestamp::now_utc;
use super::{ensure_parent, esc, media_type, render_page, Progress, Target};
use crate::compress::Compression;
use crate::page::PageKind;
use crate::project::{Direction, Volume};

/// One image plus the page document that displays it.
struct Slot {
    /// Stem shared by the image and its page document, e.g. `p0001`.
    stem: String,
    ext: &'static str,
    width: u32,
    height: u32,
    spread: bool,
    bytes: Vec<u8>,
}

impl Slot {
    fn image_href(&self) -> String {
        format!("images/{}.{}", self.stem, self.ext)
    }
    fn page_href(&self) -> String {
        format!("text/{}.xhtml", self.stem)
    }
}

/// Where a chapter begins in the flattened slot list, for the tables of contents.
struct ChapterStart {
    title: String,
    slot: usize,
}

/// A volume flattened into the page slots the package will contain.
struct Layout {
    slots: Vec<Slot>,
    chapters: Vec<ChapterStart>,
}

/// Write `volume` to `out` as a fixed-layout EPUB 3.
pub fn write(volume: &Volume, out: &Path) -> Result<()> {
    write_with_progress(volume, out, &Compression::ORIGINAL, &mut |_, _| {})
}

/// As [`write`], reporting `(pages_done, pages_total)` as each page is encoded.
/// Encoding dominates export time, so this is where a UI wants its progress.
pub fn write_with_progress(
    volume: &Volume,
    out: &Path,
    compression: &Compression,
    progress: &mut Progress,
) -> Result<()> {
    let Layout { slots, chapters } = build_slots(volume, compression, progress)?;
    if slots.is_empty() {
        bail!("volume has no pages to write");
    }

    // One canvas for the whole book. Everything downstream — every page's
    // viewport and the `original-resolution` Kindle reads — is this one number,
    // so they cannot disagree and cause a crop.
    let canvas = canvas_size(&slots);

    ensure_parent(out)?;
    let file = File::create(out).with_context(|| format!("creating {}", out.display()))?;
    let mut zip = ZipWriter::new(file);

    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // The mimetype entry must come first and be stored uncompressed; readers
    // sniff it at a fixed offset.
    zip.start_file("mimetype", stored)?;
    zip.write_all(b"application/epub+zip")?;

    zip.start_file("META-INF/container.xml", deflated)?;
    zip.write_all(CONTAINER_XML.as_bytes())?;

    zip.start_file("OEBPS/style.css", deflated)?;
    zip.write_all(STYLE_CSS.as_bytes())?;

    for slot in &slots {
        // Already-compressed image formats gain nothing from deflate.
        zip.start_file(format!("OEBPS/{}", slot.image_href()), stored)?;
        zip.write_all(&slot.bytes)?;

        zip.start_file(format!("OEBPS/{}", slot.page_href()), deflated)?;
        zip.write_all(page_xhtml(slot, canvas).as_bytes())?;
    }

    zip.start_file("OEBPS/nav.xhtml", deflated)?;
    zip.write_all(nav_xhtml(volume, &slots, &chapters).as_bytes())?;

    zip.start_file("OEBPS/toc.ncx", deflated)?;
    zip.write_all(toc_ncx(volume, &slots, &chapters).as_bytes())?;

    zip.start_file("OEBPS/content.opf", deflated)?;
    zip.write_all(content_opf(volume, &slots, canvas).as_bytes())?;

    zip.finish()?;
    Ok(())
}

/// Flatten the volume into page slots, recording where each chapter begins.
///
/// When the user picked a cover that is not already the first page, it is
/// prepended as its own slot. Otherwise the first page doubles as the cover, so
/// the image is stored once and simply marked `cover-image` in the manifest.
fn build_slots(
    volume: &Volume,
    compression: &Compression,
    progress: &mut Progress,
) -> Result<Layout> {
    let mut slots: Vec<Slot> = Vec::new();
    let mut chapters: Vec<ChapterStart> = Vec::new();
    let direction = volume.metadata.direction;
    let total = volume.total_included();
    let mut done = 0usize;

    let first_page = volume.included_pages().next().map(|p| p.path.clone());
    if let Some(cover) = volume.cover.clone() {
        if first_page.as_ref() != Some(&cover) {
            let bytes = std::fs::read(&cover)
                .with_context(|| format!("reading cover {}", cover.display()))?;
            let (width, height) = crate::page::probe_dimensions(&cover)
                .with_context(|| format!("cover {} is not a readable image", cover.display()))?;
            let ext = match cover.extension().and_then(|e| e.to_str()) {
                Some(e) if e.eq_ignore_ascii_case("png") => "png",
                Some(e) if e.eq_ignore_ascii_case("webp") => "webp",
                _ => "jpg",
            };
            slots.push(Slot {
                stem: "cover".into(),
                ext,
                width,
                height,
                spread: false,
                bytes,
            });
        }
    }

    for chapter in &volume.chapters {
        if chapter.included_count() == 0 {
            continue;
        }
        chapters.push(ChapterStart {
            title: chapter.title.clone(),
            slot: slots.len(),
        });

        for page in chapter.included() {
            let rendered_pages = render_page(page, direction, compression, Target::Epub)?;
            done += 1;
            progress(done, total);
            for rendered in rendered_pages {
                slots.push(Slot {
                    stem: format!("p{:04}", slots.len() + 1),
                    ext: rendered.ext,
                    width: rendered.width,
                    height: rendered.height,
                    // A spread that was split is now two ordinary pages.
                    spread: page.kind == PageKind::Spread && !page.split,
                    bytes: rendered.bytes,
                });
            }
        }
    }

    Ok(Layout { slots, chapters })
}

fn content_opf(volume: &Volume, slots: &[Slot], canvas: (u32, u32)) -> String {
    let m = &volume.metadata;
    let identifier = if m.identifier.is_empty() {
        format!("urn:mangalize:{}", m.display_title())
    } else {
        m.identifier.clone()
    };

    let mut meta = vec![
        format!("    <dc:identifier id=\"bookid\">{}</dc:identifier>", esc(&identifier)),
        format!("    <dc:title>{}</dc:title>", esc(&m.display_title())),
        format!("    <dc:language>{}</dc:language>", esc(&m.language)),
        format!("    <meta property=\"dcterms:modified\">{}</meta>", now_utc()),
    ];
    if !m.author.is_empty() {
        meta.push(format!("    <dc:creator id=\"author\">{}</dc:creator>", esc(&m.author)));
        meta.push("    <meta refines=\"#author\" property=\"role\" scheme=\"marc:relators\">aut</meta>".into());
    }
    if !m.description.is_empty() {
        meta.push(format!("    <dc:description>{}</dc:description>", esc(&m.description)));
    }
    if !m.series.is_empty() {
        meta.push(format!("    <meta property=\"belongs-to-collection\" id=\"series\">{}</meta>", esc(&m.series)));
        meta.push("    <meta refines=\"#series\" property=\"collection-type\">series</meta>".into());
        if let Some(v) = m.volume {
            meta.push(format!("    <meta refines=\"#series\" property=\"group-position\">{v}</meta>"));
        }
    }

    // EPUB 3 fixed-layout declarations.
    meta.push("    <meta property=\"rendition:layout\">pre-paginated</meta>".into());
    meta.push("    <meta property=\"rendition:orientation\">auto</meta>".into());
    meta.push("    <meta property=\"rendition:spread\">landscape</meta>".into());

    // Kindle-specific hints. These are EPUB 2 style on purpose; Amazon's
    // converter reads them and ignores the EPUB 3 equivalents above.
    let (norm_w, norm_h) = canvas;
    meta.push("    <meta name=\"cover\" content=\"img-1\"/>".into());
    meta.push("    <meta name=\"book-type\" content=\"comic\"/>".into());
    meta.push("    <meta name=\"fixed-layout\" content=\"true\"/>".into());
    meta.push("    <meta name=\"zero-gutter\" content=\"true\"/>".into());
    meta.push("    <meta name=\"zero-margin\" content=\"true\"/>".into());
    meta.push("    <meta name=\"RegionMagnification\" content=\"false\"/>".into());
    meta.push(format!("    <meta name=\"original-resolution\" content=\"{norm_w}x{norm_h}\"/>"));
    meta.push(format!(
        "    <meta name=\"primary-writing-mode\" content=\"{}\"/>",
        match m.direction {
            Direction::RightToLeft => "horizontal-rl",
            Direction::LeftToRight => "horizontal-lr",
        }
    ));

    let mut manifest = vec![
        "    <item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>".to_string(),
        "    <item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>".to_string(),
        "    <item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>".to_string(),
    ];
    let mut spine = Vec::with_capacity(slots.len());

    for (i, slot) in slots.iter().enumerate() {
        let n = i + 1;
        // The first image is the cover, whether it is a dedicated cover file or
        // simply page one.
        let props = if i == 0 { " properties=\"cover-image\"" } else { "" };
        manifest.push(format!(
            "    <item id=\"img-{n}\" href=\"{}\" media-type=\"{}\"{props}/>",
            slot.image_href(),
            media_type(slot.ext)
        ));
        manifest.push(format!(
            "    <item id=\"page-{n}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>",
            slot.page_href()
        ));

        // Deliberately no `rendition:page-spread-center`. That asks a reader to
        // lay the page out across both halves of a two-page display, which on a
        // single-page Kindle is part of what got spreads cut. The image is
        // already one wide page; it just needs to be shown whole.
        spine.push(format!("    <itemref idref=\"page-{n}\"/>"));
    }

    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"
         prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
{meta}
  </metadata>
  <manifest>
{manifest}
  </manifest>
  <spine toc="ncx" page-progression-direction="{ppd}">
{spine}
  </spine>
  <guide>
    <reference type="cover" href="{cover_href}" title="Cover"/>
  </guide>
</package>
"#,
        meta = meta.join("\n"),
        manifest = manifest.join("\n"),
        spine = spine.join("\n"),
        ppd = m.direction.epub_ppd(),
        cover_href = slots[0].page_href(),
    )
}

/// Per-page document, laid out on the book's single canvas.
///
/// Every page declares the *same* viewport, which is the size reported to
/// Kindle as `original-resolution`. Giving a double-page spread a viewport twice
/// as wide as that canvas is what makes Kindle crop it: the converter treats
/// `original-resolution` as the page size for the whole book and cuts anything
/// that overflows it.
///
/// So the spread keeps its full pixel dimensions as an image, and CSS fits it
/// inside the shared canvas. It is shown whole, letterboxed above and below,
/// and because the stored image is still full resolution, zooming in on a
/// reader reveals every bit of it.
fn page_xhtml(slot: &Slot, canvas: (u32, u32)) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="utf-8"/>
  <title>{stem}</title>
  <meta name="viewport" content="width={cw}, height={ch}"/>
  <link href="../style.css" rel="stylesheet" type="text/css"/>
</head>
<body>
  <div class="page"><img src="../{img}" alt="" width="{w}" height="{h}"/></div>
</body>
</html>
"#,
        stem = slot.stem,
        cw = canvas.0,
        ch = canvas.1,
        w = slot.width,
        h = slot.height,
        img = slot.image_href(),
    )
}

fn nav_xhtml(volume: &Volume, slots: &[Slot], starts: &[ChapterStart]) -> String {
    let items = starts
        .iter()
        .map(|c| {
            format!(
                "      <li><a href=\"{}\">{}</a></li>",
                slots[c.slot].page_href(),
                esc(&c.title)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="utf-8"/>
  <title>{title}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>{title}</h1>
    <ol>
{items}
    </ol>
  </nav>
  <nav epub:type="landmarks" hidden="hidden">
    <ol>
      <li><a epub:type="cover" href="{cover}">Cover</a></li>
    </ol>
  </nav>
</body>
</html>
"#,
        title = esc(&volume.metadata.display_title()),
        items = items,
        cover = slots[0].page_href(),
    )
}

/// NCX table of contents. Superseded by `nav.xhtml` in EPUB 3, but older Kindle
/// firmware still reads it and it costs a few hundred bytes.
fn toc_ncx(volume: &Volume, slots: &[Slot], starts: &[ChapterStart]) -> String {
    let points = starts
        .iter()
        .enumerate()
        .map(|(n, c)| {
            format!(
                "    <navPoint id=\"np-{n}\" playOrder=\"{order}\">\n      \
                 <navLabel><text>{label}</text></navLabel>\n      \
                 <content src=\"{src}\"/>\n    </navPoint>",
                n = n + 1,
                order = n + 1,
                label = esc(&c.title),
                src = slots[c.slot].page_href(),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="{uid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>{title}</text></docTitle>
  <navMap>
{points}
  </navMap>
</ncx>
"#,
        uid = esc(&volume.metadata.identifier),
        title = esc(&volume.metadata.display_title()),
        points = points,
    )
}

/// The page size the whole book is laid out on.
///
/// Measured across ordinary pages only. A spread is twice the width of a page by
/// definition, so letting spreads vote would stretch the canvas and letterbox
/// every single page in the book to accommodate a handful of wide ones.
fn canvas_size(slots: &[Slot]) -> (u32, u32) {
    let singles = || slots.iter().filter(|s| !s.spread);

    let mut counts: std::collections::HashMap<(u32, u32), usize> =
        std::collections::HashMap::new();
    for slot in singles() {
        if slot.width > 0 && slot.height > 0 {
            *counts.entry((slot.width, slot.height)).or_insert(0) += 1;
        }
    }

    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)))
        .map(|(size, _)| size)
        // A book of nothing but spreads still needs a canvas; the first page
        // is a better guess than zero.
        .or_else(|| slots.first().map(|s| (s.width, s.height)))
        .unwrap_or((0, 0))
}

const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;

const STYLE_CSS: &str = r#"@page { margin: 0; padding: 0; }

html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background-color: #ffffff;
}

div.page {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  text-align: center;
  /* Centres a page that does not fill the canvas, which is what a double-page
     spread does once it has been scaled to fit. Readers that ignore flex fall
     back to the image sitting at the top, still whole. */
  display: flex;
  align-items: center;
  justify-content: center;
}

div.page img {
  margin: 0;
  padding: 0;
  /* The pair below is what guarantees a spread is never cut: it is scaled down
     until it fits the canvas, rather than overflowing and being clipped. The
     stored image keeps its full resolution, so zooming shows all of it. */
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
"#;
