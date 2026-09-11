//! End-to-end over a real library folder: add a series, learn its layout, take
//! delivery of some chapters, and hand the result to the existing pipeline.

use std::path::Path;

use mangalize_library::model::{NewSeries, PublishedChapter, PublishedVolume};
use mangalize_library::Library;
use tempfile::TempDir;

fn ichi() -> NewSeries {
    NewSeries {
        source: Some("mangadex".into()),
        source_id: Some("dea77c2d".into()),
        title: "Ichi the Witch".into(),
        author: "Nishi Osamu".into(),
        artist: "Usazaki Shiro".into(),
        description: "In this world, witches must hunt down their magic!".into(),
        year: Some(2024),
        ..NewSeries::default()
    }
}

/// The shape MangaDex returns: two volumes, three chapters each.
fn layout() -> Vec<PublishedVolume> {
    ["1", "2"]
        .iter()
        .enumerate()
        .map(|(v, number)| PublishedVolume {
            number: number.to_string(),
            cover_url: Some(format!("https://covers.test/{number}.jpg")),
            chapters: (1..=3)
                .map(|c| PublishedChapter {
                    number: (v * 3 + c).to_string(),
                    title: None,
                })
                .collect(),
        })
        .collect()
}

/// Write `count` pages of the same size, so the scanner has a norm to work from.
fn write_chapter(dir: &Path, count: usize) {
    std::fs::create_dir_all(dir).unwrap();
    for i in 1..=count {
        let page = image::RgbImage::new(800, 1168);
        page.save(dir.join(format!("{i:04}.jpg"))).unwrap();
    }
}

fn open() -> (TempDir, Library) {
    let dir = TempDir::new().unwrap();
    let library = Library::open(dir.path()).unwrap();
    (dir, library)
}

#[test]
fn adding_a_series_creates_its_folder_and_is_idempotent() {
    let (_dir, mut library) = open();

    let first = library.add_series(ichi()).unwrap();
    assert!(first.folder.join("chapters").is_dir());
    assert_eq!(first.title, "Ichi the Witch");

    // Searching again for a series you already have must not duplicate it.
    let second = library.add_series(ichi()).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(library.all_series().unwrap().len(), 1);
}

#[test]
fn a_published_layout_becomes_a_list_of_missing_chapters() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();

    let report = library.sync_layout(series.id, &layout()).unwrap();
    assert_eq!(report.volumes, 2);
    assert_eq!(report.chapters_added, 6);

    let volumes = library.volumes(series.id).unwrap();
    assert_eq!(volumes.len(), 2);
    assert_eq!(volumes[0].number, "1");
    assert_eq!(volumes[0].chapters.len(), 3);
    // Nothing downloaded yet: every chapter is a known gap.
    assert_eq!(volumes[0].have(), 0);
    assert!(!volumes[0].complete());
    assert!(volumes[0].chapters.iter().all(|c| !c.downloaded()));

    let stored = library.series(series.id).unwrap();
    assert_eq!((stored.have_chapters, stored.known_chapters), (0, 6));
}

#[test]
fn syncing_twice_adds_nothing_and_keeps_downloaded_chapters() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    library.sync_layout(series.id, &layout()).unwrap();

    write_chapter(&library.chapter_dir(series.id, "2").unwrap(), 4);
    library.record_chapter(series.id, "2", 4, Some("https://reader.test/2")).unwrap();

    let again = library.sync_layout(series.id, &layout()).unwrap();
    assert_eq!(again.chapters_added, 0);

    let chapter = library.chapter(series.id, "2").unwrap();
    assert!(chapter.downloaded());
    assert_eq!(chapter.page_count, 4);
    assert_eq!(chapter.source_url.as_deref(), Some("https://reader.test/2"));
}

#[test]
fn a_chapter_the_index_forgot_is_kept_and_counted_as_orphaned() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    library.sync_layout(series.id, &layout()).unwrap();

    write_chapter(&library.chapter_dir(series.id, "99").unwrap(), 2);
    library.record_chapter(series.id, "99", 2, None).unwrap();

    // A re-tagged upstream index must never take a file away from the user.
    let report = library.sync_layout(series.id, &layout()).unwrap();
    assert_eq!(report.orphaned, 1);
    assert!(library.chapter(series.id, "99").unwrap().downloaded());
}

#[test]
fn chapters_no_volume_claims_are_gathered_under_unsorted_and_sort_last() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    library.sync_layout(series.id, &layout()).unwrap();

    write_chapter(&library.chapter_dir(series.id, "99").unwrap(), 1);
    library.record_chapter(series.id, "99", 1, None).unwrap();

    let volumes = library.volumes(series.id).unwrap();
    let labels: Vec<&str> = volumes.iter().map(|v| v.number.as_str()).collect();
    assert_eq!(labels, ["1", "2", mangalize_library::UNSORTED]);
}

#[test]
fn a_downloaded_volume_becomes_a_volume_the_writers_understand() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    library.sync_layout(series.id, &layout()).unwrap();

    for (chapter, pages) in [("1", 3), ("2", 4), ("3", 3)] {
        write_chapter(&library.chapter_dir(series.id, chapter).unwrap(), pages);
        library.record_chapter(series.id, chapter, pages as u32, None).unwrap();
    }

    let volume = library.build_volume(series.id, "1").unwrap();
    assert_eq!(volume.chapters.len(), 3);
    assert_eq!(volume.total_included(), 10);
    assert_eq!(volume.metadata.series, "Ichi the Witch");
    assert_eq!(volume.metadata.volume, Some(1));
    assert_eq!(volume.metadata.author, "Nishi Osamu, Usazaki Shiro");
    // Chapter titles come from the library's real numbers, not the folder names.
    assert_eq!(volume.chapters[0].title, "Chapter 1");
    assert_eq!(volume.chapters[2].title, "Chapter 3");

    // And it survives the trip through the existing writer.
    let out = library.root().join("v1.epub");
    mangalize_core::writers::epub::write(&volume, &out).unwrap();
    assert!(std::fs::metadata(&out).unwrap().len() > 0);
}

#[test]
fn a_volume_only_half_downloaded_still_builds_from_what_is_there() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    library.sync_layout(series.id, &layout()).unwrap();

    write_chapter(&library.chapter_dir(series.id, "2").unwrap(), 3);
    library.record_chapter(series.id, "2", 3, None).unwrap();

    let volumes = library.volumes(series.id).unwrap();
    assert_eq!(volumes[0].have(), 1);
    assert!(!volumes[0].complete());

    let volume = library.build_volume(series.id, "1").unwrap();
    assert_eq!(volume.chapters.len(), 1);
    assert_eq!(volume.total_included(), 3);
}

#[test]
fn building_a_volume_with_nothing_downloaded_says_so() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    library.sync_layout(series.id, &layout()).unwrap();

    let error = library.build_volume(series.id, "1").unwrap_err().to_string();
    assert!(error.contains("downloaded"), "unhelpful message: {error}");
}

#[test]
fn deleting_a_chapter_removes_its_files_but_leaves_the_gap_visible() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    library.sync_layout(series.id, &layout()).unwrap();

    let dir = library.chapter_dir(series.id, "2").unwrap();
    write_chapter(&dir, 3);
    library.record_chapter(series.id, "2", 3, None).unwrap();

    library.delete_chapter(series.id, "2").unwrap();
    assert!(!dir.exists());

    // Still a known chapter of volume 1, just one we no longer hold.
    let volumes = library.volumes(series.id).unwrap();
    assert_eq!(volumes[0].chapters.len(), 3);
    assert!(!library.chapter(series.id, "2").unwrap().downloaded());
}

#[test]
fn removing_a_series_leaves_its_files_alone_unless_asked() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    let folder = series.folder.clone();

    library.remove_series(series.id, false).unwrap();
    assert!(library.all_series().unwrap().is_empty());
    assert!(folder.is_dir(), "files must outlive the index entry");
}

#[test]
fn removing_a_series_with_its_files_takes_the_folder_too() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    library.sync_layout(series.id, &layout()).unwrap();

    let chapter = library.chapter_dir(series.id, "1").unwrap();
    write_chapter(&chapter, 3);
    library.record_chapter(series.id, "1", 3, None).unwrap();

    library.remove_series(series.id, true).unwrap();

    assert!(!series.folder.exists());
    assert!(library.all_series().unwrap().is_empty());
    // The chapter rows go with the series, by foreign key cascade.
    assert!(library.chapter(series.id, "1").is_err());
}

#[test]
fn removing_a_series_never_reaches_outside_the_library() {
    let (dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();

    // A folder that merely sits near the library must survive regardless.
    let bystander = dir.path().parent().unwrap().join("mangalize-bystander");
    std::fs::create_dir_all(&bystander).unwrap();

    library.remove_series(series.id, true).unwrap();
    assert!(bystander.is_dir());
    std::fs::remove_dir_all(&bystander).unwrap();
}

#[test]
fn reopening_the_library_finds_everything_again() {
    let dir = TempDir::new().unwrap();
    let id = {
        let mut library = Library::open(dir.path()).unwrap();
        let series = library.add_series(ichi()).unwrap();
        library.sync_layout(series.id, &layout()).unwrap();
        write_chapter(&library.chapter_dir(series.id, "1").unwrap(), 2);
        library.record_chapter(series.id, "1", 2, None).unwrap();
        series.id
    };

    let library = Library::open(dir.path()).unwrap();
    let series = library.series(id).unwrap();
    assert_eq!(series.title, "Ichi the Witch");
    assert_eq!((series.have_chapters, series.known_chapters), (1, 6));
}
