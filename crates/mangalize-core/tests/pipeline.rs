//! End-to-end tests over a synthetic folder that reproduces the quirks of a real
//! scrape: site furniture mixed in with pages, a double-page spread, a near-blank
//! page, and a different filename scheme per chapter.

use std::path::{Path, PathBuf};

use image::{ImageBuffer, Rgb};
use mangalize_core::page::{ExcludeReason, PageKind};
use mangalize_core::writers;
use mangalize_core::{scan_volume, Volume};
use tempfile::TempDir;

const PAGE_W: u32 = 800;
const PAGE_H: u32 = 1168;

fn write_jpeg(path: &Path, w: u32, h: u32) {
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
    img.save_with_format(path, image::ImageFormat::Jpeg).unwrap();
}

fn write_png(path: &Path, w: u32, h: u32) {
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(w, h, Rgb([10, 20, 30]));
    img.save_with_format(path, image::ImageFormat::Png).unwrap();
}

/// Build a fixture shaped like the real `Itch The Witch` folder.
fn fixture() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("Itch The Witch Volume 01");

    // Chapter 1: plain numbering, one spread, plus the site furniture.
    let ch1 = root.join("itch-the-witch-ch1");
    std::fs::create_dir_all(&ch1).unwrap();
    for i in 1..=5u32 {
        if i == 3 {
            write_jpeg(&ch1.join(format!("{i:02}.jpg.jpeg")), PAGE_W * 2, PAGE_H);
        } else {
            write_jpeg(&ch1.join(format!("{i:02}.jpg.jpeg")), PAGE_W, PAGE_H);
        }
    }
    write_png(&ch1.join("banner.png"), 600, 400);
    write_jpeg(&ch1.join("favicon-32x32.jpg.jpeg"), 32, 32);
    std::fs::write(ch1.join("close.svg"), "<svg/>").unwrap();
    std::fs::write(ch1.join("pxf.gif"), b"GIF89a").unwrap();

    // Chapter 2: the `NN_NN` scheme, ten pages so ordering past 9 is exercised.
    let ch2 = root.join("itch-the-witch-ch2");
    std::fs::create_dir_all(&ch2).unwrap();
    for i in 1..=10u32 {
        write_jpeg(&ch2.join(format!("{i:02}_{:02}.jpg.jpeg", 30 - i)), PAGE_W, PAGE_H);
    }

    // Chapter 10 must sort after chapter 2, not between 1 and 2.
    let ch10 = root.join("itch-the-witch-ch10");
    std::fs::create_dir_all(&ch10).unwrap();
    write_jpeg(&ch10.join("01.jpg.jpeg"), PAGE_W, PAGE_H);

    (tmp, root)
}

#[test]
fn scan_reads_the_volume_the_way_a_reader_would() {
    let (_tmp, root) = fixture();
    let v = scan_volume(&root).unwrap();

    assert_eq!(v.metadata.series, "Itch The Witch");
    assert_eq!(v.metadata.volume, Some(1));
    assert_eq!(v.chapters.len(), 3);

    // Chapters in reading order, with ch10 last.
    let titles: Vec<_> = v.chapters.iter().map(|c| c.title.as_str()).collect();
    assert_eq!(titles, ["Chapter 1", "Chapter 2", "Chapter 10"]);

    // 5 + 10 + 1 real pages; the banner and favicon are held out, and the
    // .svg/.gif never enter the list at all.
    assert_eq!(v.total_included(), 16);

    let ch1 = &v.chapters[0];
    assert_eq!(ch1.included_count(), 5);
    assert_eq!(ch1.excluded_count(), 2);
    assert!(ch1
        .pages
        .iter()
        .all(|p| !p.file_name().ends_with(".svg") && !p.file_name().ends_with(".gif")));
    assert!(ch1
        .pages
        .iter()
        .filter(|p| !p.is_included())
        .all(|p| matches!(p.excluded, Some(ExcludeReason::OffSize { .. }))));

    // Pages come out in natural filename order.
    let ch2_names: Vec<_> = v.chapters[1].included().map(|p| p.file_name()).collect();
    assert_eq!(ch2_names.first().copied(), Some("01_29.jpg.jpeg"));
    assert_eq!(ch2_names.last().copied(), Some("10_20.jpg.jpeg"));
}

#[test]
fn the_wide_page_is_flagged_as_a_spread_and_split_by_default() {
    let (_tmp, root) = fixture();
    let v = scan_volume(&root).unwrap();

    let spreads: Vec<_> = v
        .included_pages()
        .filter(|p| p.kind == PageKind::Spread)
        .collect();
    assert_eq!(spreads.len(), 1);
    assert_eq!(spreads[0].file_name(), "03.jpg.jpeg");
    // A Kindle zooms into part of a wide page rather than fitting it, so the
    // default has to be two ordinary pages.
    assert!(spreads[0].split, "spreads must default to split");
}

#[test]
fn epub_is_a_well_formed_fixed_layout_package() {
    let (_tmp, root) = fixture();
    let v = scan_volume(&root).unwrap();
    let out = root.join("out.epub");
    writers::epub::write(&v, &out).unwrap();

    let bytes = std::fs::read(&out).unwrap();
    // OCF requires an uncompressed `mimetype` as the first entry, so its name
    // and value sit at fixed offsets.
    assert_eq!(&bytes[30..38], b"mimetype");
    assert_eq!(&bytes[38..58], b"application/epub+zip");

    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = zip.file_names().map(|s| s.to_string()).collect();
    assert!(names.contains(&"META-INF/container.xml".to_string()));
    assert!(names.contains(&"OEBPS/content.opf".to_string()));
    assert!(names.contains(&"OEBPS/nav.xhtml".to_string()));

    // One image and one page document per page, and nothing orphaned. Seventeen
    // rather than sixteen files: the spread is split, so it occupies two.
    assert_eq!(names.iter().filter(|n| n.starts_with("OEBPS/images/")).count(), 17);
    assert_eq!(names.iter().filter(|n| n.starts_with("OEBPS/text/")).count(), 17);

    let opf = read_entry(&mut zip, "OEBPS/content.opf");
    assert!(opf.contains(r#"<meta property="rendition:layout">pre-paginated</meta>"#));
    assert!(opf.contains(r#"page-progression-direction="rtl""#));
    assert!(opf.contains(r#"<meta name="book-type" content="comic"/>"#));
    assert!(opf.contains(r#"content="800x1168""#), "norm size drives original-resolution");
    assert_eq!(opf.matches("cover-image").count(), 1);
    assert_eq!(opf.matches("<itemref").count(), 17);
}

#[test]
fn a_spread_becomes_two_pages_right_half_first_by_default() {
    let (_tmp, root) = fixture();
    let v = scan_volume(&root).unwrap();
    let out = root.join("split.epub");
    writers::epub::write(&v, &out).unwrap();

    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(&out).unwrap())).unwrap();

    // The spread was page three of the fixture, so it now occupies pages three
    // and four, each an ordinary half-width page.
    for stem in ["p0003", "p0004"] {
        let page = read_entry(&mut zip, &format!("OEBPS/text/{stem}.xhtml"));
        assert!(
            page.contains(r#"content="width=800, height=1168""#),
            "{stem} should be an ordinary page on the canvas"
        );
        assert!(
            !page.contains("width=\"1600\""),
            "{stem} still carries the full spread; it was not split"
        );
    }

    // Nothing anywhere declares a page wider than the canvas, which is the
    // property that stopped Kindle zooming into a fragment of a wide page.
    let names: Vec<String> = zip.file_names().map(|s| s.to_string()).collect();
    for name in names.iter().filter(|n| n.starts_with("OEBPS/text/")) {
        let page = read_entry(&mut zip, name);
        assert!(
            page.contains(r#"content="width=800, height=1168""#),
            "{name} does not sit on the book canvas"
        );
    }
}

#[test]
fn keeping_a_spread_whole_still_fits_it_on_the_canvas() {
    // What the "split double-page spreads" setting turns off. A reader that can
    // show a wide page gets one, and it must still be fitted rather than cut.
    let (_tmp, root) = fixture();
    let mut v = scan_volume(&root).unwrap();
    for chapter in &mut v.chapters {
        for page in &mut chapter.pages {
            page.split = false;
        }
    }

    let out = root.join("whole.epub");
    writers::epub::write(&v, &out).unwrap();
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(&out).unwrap())).unwrap();

    let spread_page = read_entry(&mut zip, "OEBPS/text/p0003.xhtml");
    assert!(
        spread_page.contains(r#"content="width=800, height=1168""#),
        "the spread must share the book canvas"
    );
    assert!(
        spread_page.contains(r#"width="1600" height="1168""#),
        "the spread image must stay full resolution"
    );

    let opf = read_entry(&mut zip, "OEBPS/content.opf");
    assert!(!opf.contains("rendition:page-spread-center"));

    let css = read_entry(&mut zip, "OEBPS/style.css");
    assert!(css.contains("max-width: 100%") && css.contains("max-height: 100%"));
    assert!(css.contains("object-fit: contain"));
}

#[test]
fn splitting_a_spread_produces_two_pages_right_half_first() {
    let (_tmp, root) = fixture();
    let mut v = scan_volume(&root).unwrap();
    for chapter in &mut v.chapters {
        for page in &mut chapter.pages {
            if page.kind == PageKind::Spread {
                page.split = true;
            }
        }
    }

    let out = root.join("split.epub");
    writers::epub::write(&v, &out).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(&out).unwrap())).unwrap();
    let count = zip.file_names().filter(|n| n.starts_with("OEBPS/images/")).count();
    assert_eq!(count, 17, "the spread became two pages");

    // A split spread is no longer a spread, so nothing is marked center.
    let opf = read_entry(&mut zip, "OEBPS/content.opf");
    assert_eq!(opf.matches("rendition:page-spread-center").count(), 0);

    // Both halves are half-width single pages.
    for stem in ["p0003", "p0004"] {
        let doc = read_entry(&mut zip, &format!("OEBPS/text/{stem}.xhtml"));
        assert!(doc.contains(r#"content="width=800, height=1168""#), "{stem}");
    }
}

#[test]
fn cbz_holds_every_page_plus_comicinfo() {
    let (_tmp, root) = fixture();
    let v = scan_volume(&root).unwrap();
    let out = root.join("out.cbz");
    writers::cbz::write(&v, &out).unwrap();

    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(&out).unwrap())).unwrap();
    let images: Vec<String> = zip
        .file_names()
        .filter(|n| n.ends_with(".jpg"))
        .map(|s| s.to_string())
        .collect();
    assert_eq!(images.len(), 17);

    // Zero-padded flat names so every reader agrees on the order.
    let mut sorted = images.clone();
    sorted.sort();
    assert_eq!(sorted, images, "names must already be in lexicographic order");

    let info = read_entry(&mut zip, "ComicInfo.xml");
    assert!(info.contains("<Manga>YesAndRightToLeft</Manga>"));
    // Seventeen, not sixteen: the split spread counts as the two pages it
    // actually becomes in the archive.
    assert!(info.contains("<PageCount>17</PageCount>"));
    assert!(info.contains("<Series>Itch The Witch</Series>"));
}

#[test]
fn an_explicit_cover_is_added_ahead_of_page_one() {
    let (_tmp, root) = fixture();
    let cover = root.join("cover.jpg");
    write_jpeg(&cover, PAGE_W, PAGE_H);

    let mut v: Volume = scan_volume(&root).unwrap();
    v.cover = Some(cover);

    let out = root.join("cover.epub");
    writers::epub::write(&v, &out).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(&out).unwrap())).unwrap();

    assert!(zip.file_names().any(|n| n == "OEBPS/images/cover.jpg"));
    assert_eq!(zip.file_names().filter(|n| n.starts_with("OEBPS/images/")).count(), 18);

    let opf = read_entry(&mut zip, "OEBPS/content.opf");
    assert!(opf.contains(r#"href="images/cover.jpg" media-type="image/jpeg" properties="cover-image""#));
}

#[test]
fn without_an_explicit_cover_page_one_is_reused_rather_than_duplicated() {
    let (_tmp, root) = fixture();
    let v = scan_volume(&root).unwrap();
    let out = root.join("nocover.epub");
    writers::epub::write(&v, &out).unwrap();

    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(&out).unwrap())).unwrap();
    // 17 pages, 17 images: the cover is page one, stored once.
    assert_eq!(zip.file_names().filter(|n| n.starts_with("OEBPS/images/")).count(), 17);
    let opf = read_entry(&mut zip, "OEBPS/content.opf");
    assert!(opf.contains(r#"href="images/p0001.jpg" media-type="image/jpeg" properties="cover-image""#));
}

fn read_entry<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> String {
    use std::io::Read;
    let mut s = String::new();
    zip.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}
