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
                    // As MangaDex returns them: an id per chapter, all hosted.
                    source_id: Some(format!("chapter-uuid-{}", v * 3 + c)),
                    unavailable: false,
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

/* ------------------------------------------------------------------ reading */

/// A series with three downloaded chapters, ready to be read.
fn readable() -> (TempDir, Library, mangalize_library::SeriesId) {
    let (dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();
    library.sync_layout(series.id, &layout()).unwrap();
    for chapter in ["1", "2", "3"] {
        write_chapter(&library.chapter_dir(series.id, chapter).unwrap(), 5);
        library.record_chapter(series.id, chapter, 5, None).unwrap();
    }
    (dir, library, series.id)
}

#[test]
fn progress_is_remembered_so_a_chapter_resumes_where_it_stopped() {
    let (_dir, library, id) = readable();

    library.save_progress(id, "2", 3, false).unwrap();

    let chapter = library.chapter(id, "2").unwrap();
    assert_eq!(chapter.last_page, 3);
    assert!(chapter.opened_at.is_some(), "opening is what history records");
    assert!(chapter.read_at.is_none(), "stopping midway is not finishing");
}

#[test]
fn finishing_is_recorded_separately_from_opening() {
    let (_dir, library, id) = readable();

    library.save_progress(id, "1", 4, true).unwrap();
    let finished = library.chapter(id, "1").unwrap();
    assert!(finished.read_at.is_some());

    // Re-reading must not rewrite when it was first completed.
    let first_time = finished.read_at;
    library.save_progress(id, "1", 1, true).unwrap();
    assert_eq!(library.chapter(id, "1").unwrap().read_at, first_time);
}

#[test]
fn history_is_most_recently_opened_first() {
    let (_dir, library, id) = readable();

    for chapter in ["1", "2", "3"] {
        library.save_progress(id, chapter, 1, false).unwrap();
        // The timestamp has one-second resolution, so order has to be forced.
        std::thread::sleep(std::time::Duration::from_millis(1100));
    }

    let history = library.history(10).unwrap();
    let order: Vec<&str> = history.iter().map(|h| h.chapter.as_str()).collect();
    assert_eq!(order, ["3", "2", "1"]);
    assert_eq!(history[0].series_title, "Ichi the Witch");
    assert_eq!(history[0].page_count, 5);
}

#[test]
fn history_keeps_a_deleted_chapter_the_source_can_still_serve() {
    let (_dir, library, id) = readable();
    library.save_progress(id, "1", 2, false).unwrap();
    library.save_progress(id, "2", 2, false).unwrap();

    library.delete_chapter(id, "1").unwrap();

    // Deleting the pages says "I do not want these files", not "I never read
    // this" — and the chapter is still reachable, because the source that
    // indexed it will serve it again.
    let history = library.history(10).unwrap();
    assert_eq!(history.len(), 2);
    let deleted = history.iter().find(|e| e.chapter == "1").unwrap();
    assert!(!deleted.downloaded);
    assert!(deleted.chapter_source_id.is_some());
}

#[test]
fn history_drops_a_deleted_chapter_that_can_no_longer_be_opened_at_all() {
    let (_dir, mut library) = open();
    let series = library.add_series(ichi()).unwrap();

    // A chapter scraped from a URL: no source id, so nothing to go back to
    // once the pages are gone.
    write_chapter(&library.chapter_dir(series.id, "1").unwrap(), 3);
    library
        .record_chapter(series.id, "1", 3, Some("https://reader.test/ch-1"))
        .unwrap();
    library.save_progress(series.id, "1", 1, false).unwrap();
    assert_eq!(library.history(10).unwrap().len(), 1);

    library.delete_chapter(series.id, "1").unwrap();

    assert!(
        library.history(10).unwrap().is_empty(),
        "an entry that cannot be reopened from anywhere is a dead end"
    );
}

#[test]
fn continue_reading_offers_the_chapter_that_was_left_unfinished() {
    let (_dir, library, id) = readable();

    library.save_progress(id, "1", 4, true).unwrap();
    library.save_progress(id, "2", 2, false).unwrap();

    let resume = library.resume_point(id).unwrap().expect("something to resume");
    assert_eq!(resume.number, "2");
    assert_eq!(resume.last_page, 2);
}

#[test]
fn with_nothing_unfinished_it_offers_the_next_unread_chapter() {
    let (_dir, library, id) = readable();

    // Finished chapter one cleanly; there is nothing half-read to go back to.
    library.save_progress(id, "1", 4, true).unwrap();

    let resume = library.resume_point(id).unwrap().expect("something to resume");
    assert_eq!(resume.number, "2", "should move on rather than repeat");
    assert_eq!(resume.last_page, 0);
}

#[test]
fn a_fully_read_series_has_nothing_to_resume() {
    let (_dir, library, id) = readable();
    // Every chapter the library knows of, not just the downloaded ones.
    for chapter in ["1", "2", "3", "4", "5", "6"] {
        library.save_progress(id, chapter, 4, true).unwrap();
    }
    assert!(library.resume_point(id).unwrap().is_none());
}

#[test]
fn finishing_what_is_downloaded_offers_the_next_chapter_from_the_source() {
    let (_dir, library, id) = readable();
    // Chapters 1-3 are on disk; 4-6 are known to exist and are hosted.
    for chapter in ["1", "2", "3"] {
        library.save_progress(id, chapter, 4, true).unwrap();
    }

    let next = library.resume_point(id).unwrap().expect("there is more to read");

    assert_eq!(next.number, "4");
    assert!(!next.downloaded(), "and it has not been downloaded yet");
    assert!(
        next.source_id.is_some(),
        "which is only offered because the source can serve it"
    );
}

#[test]
fn progress_can_be_cleared_without_touching_the_pages() {
    let (_dir, library, id) = readable();
    library.save_progress(id, "1", 4, true).unwrap();

    library.clear_progress(id, "1").unwrap();

    let chapter = library.chapter(id, "1").unwrap();
    assert_eq!(chapter.last_page, 0);
    assert!(chapter.read_at.is_none() && chapter.opened_at.is_none());
    assert!(chapter.downloaded(), "the pages must still be there");
}

/// The app opens the library per request, so the first launch has several
/// commands racing to create the same empty index. Before the migration took
/// the write lock up front, the loser failed with "table series already exists"
/// and left a half-built schema that every later open tripped over.
#[test]
fn several_commands_can_open_a_brand_new_library_at_once() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().to_path_buf();

    // A barrier rather than just spawning: the migration takes about a
    // millisecond, so without one the threads finish in turn and the race the
    // test exists for never happens.
    let start = std::sync::Arc::new(std::sync::Barrier::new(8));
    let opened: Vec<_> = (0..8)
        .map(|_| {
            let root = root.clone();
            let start = std::sync::Arc::clone(&start);
            std::thread::spawn(move || {
                start.wait();
                Library::open(&root).map(|_| ())
            })
        })
        .collect();

    for (index, handle) in opened.into_iter().enumerate() {
        handle
            .join()
            .unwrap()
            .unwrap_or_else(|e| panic!("opener {index} failed: {e:#}"));
    }

    // And the index that came out of it is usable, not just created.
    let library = Library::open(&root).unwrap();
    assert!(library.all_series().unwrap().is_empty());

    // One of those openers had to win the journal mode too. The loser ignores
    // its own failure to set it, so without this the mode could quietly stop
    // being applied at all and nothing else would notice.
    assert!(
        root.join("mangalize.db-wal").exists(),
        "the index should be in WAL mode"
    );
}

/* ------------------------------------------------- built volumes and the shelf */

#[test]
fn a_built_volume_is_remembered_so_it_can_be_offered_rather_than_rebuilt() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();
    let id = library.add_series(ichi()).unwrap().id;
    library.sync_layout(id, &layout()).unwrap();

    let built = dir.path().join("Ichi v01.epub");
    std::fs::write(&built, b"not really an epub").unwrap();
    library.record_built(id, "1", &built, 18).unwrap();

    let volume = library
        .volumes(id)
        .unwrap()
        .into_iter()
        .find(|v| v.number == "1")
        .unwrap();
    let record = volume.built.expect("the build should be remembered");
    assert_eq!(record.path, built);
    assert_eq!(record.bytes, 18);
}

#[test]
fn a_built_volume_whose_file_was_deleted_counts_as_not_built() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();
    let id = library.add_series(ichi()).unwrap().id;
    library.sync_layout(id, &layout()).unwrap();

    let built = dir.path().join("Ichi v01.epub");
    std::fs::write(&built, b"gone in a moment").unwrap();
    library.record_built(id, "1", &built, 16).unwrap();
    // The output folder belongs to the user, who may tidy it.
    std::fs::remove_file(&built).unwrap();

    let volume = library
        .volumes(id)
        .unwrap()
        .into_iter()
        .find(|v| v.number == "1")
        .unwrap();
    assert!(
        volume.built.is_none(),
        "offering to share a file that has gone is worse than offering to build it"
    );
}

#[test]
fn a_series_recorded_by_reading_it_stays_off_the_shelf() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();

    let streamed = library
        .record_unshelved_series(NewSeries {
            source: Some("mangadex".into()),
            source_id: Some("streamed-one".into()),
            title: "Read Once".into(),
            ..NewSeries::default()
        })
        .unwrap();

    assert!(!streamed.shelved);
    assert!(
        library.all_series().unwrap().is_empty(),
        "the shelf is what the user put on it"
    );
    // But it is still reachable, which is what history needs.
    assert_eq!(library.series(streamed.id).unwrap().title, "Read Once");
}

#[test]
fn reading_a_series_already_on_the_shelf_does_not_take_it_off() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();
    let added = library.add_series(ichi()).unwrap();

    let again = library.record_unshelved_series(ichi()).unwrap();

    assert_eq!(again.id, added.id);
    assert!(again.shelved, "adding then reading must not demote it");
    assert_eq!(library.all_series().unwrap().len(), 1);
}

#[test]
fn shelving_a_streamed_series_puts_it_in_the_library() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();
    let streamed = library.record_unshelved_series(ichi()).unwrap();

    library.shelve(streamed.id).unwrap();

    assert_eq!(library.all_series().unwrap().len(), 1);
}

#[test]
fn tags_and_content_rating_survive_a_round_trip() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();
    let id = library
        .add_series(NewSeries {
            tags: vec!["Action".into(), "Magic".into()],
            content_rating: Some("safe".into()),
            ..ichi()
        })
        .unwrap()
        .id;

    let series = library.series(id).unwrap();
    assert_eq!(series.tags, ["Action", "Magic"]);
    assert_eq!(series.content_rating.as_deref(), Some("safe"));
}

#[test]
fn a_series_with_no_tags_reads_back_as_no_tags_rather_than_one_empty_one() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();
    let id = library.add_series(ichi()).unwrap().id;

    assert!(library.series(id).unwrap().tags.is_empty());
}

/* ---------------------------------------------------- history, whatever the source */

#[test]
fn a_chapter_read_from_its_source_reaches_history_without_being_downloaded() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();
    let series = library.record_unshelved_series(ichi()).unwrap();

    library
        .record_streamed_chapter(series.id, "7", Some("chapter-id-7"), 42)
        .unwrap();
    library.save_progress(series.id, "7", 3, false).unwrap();

    let history = library.history(20).unwrap();
    assert_eq!(history.len(), 1, "reading it is what puts it in history");

    let entry = &history[0];
    assert_eq!(entry.chapter, "7");
    assert_eq!(entry.last_page, 3);
    assert_eq!(entry.page_count, 42, "history should know how long it is");
    assert!(!entry.downloaded, "there are no pages on disk");
    assert_eq!(entry.chapter_source_id.as_deref(), Some("chapter-id-7"));
    assert_eq!(entry.series_source_id.as_deref(), ichi().source_id.as_deref());
}

#[test]
fn history_does_not_care_which_source_a_chapter_came_from() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();
    let id = library.add_series(ichi()).unwrap().id;
    library.sync_layout(id, &layout()).unwrap();

    // One held on disk, one only ever streamed.
    write_chapter(&library.chapter_dir(id, "1").unwrap(), 2);
    library.record_chapter(id, "1", 2, None).unwrap();
    library.save_progress(id, "1", 1, true).unwrap();
    library
        .record_streamed_chapter(id, "99", Some("chapter-id-99"), 20)
        .unwrap();
    library.save_progress(id, "99", 0, false).unwrap();

    let history = library.history(20).unwrap();
    let numbers: Vec<_> = history.iter().map(|e| e.chapter.as_str()).collect();
    assert!(numbers.contains(&"1") && numbers.contains(&"99"), "got {numbers:?}");

    let streamed = history.iter().find(|e| e.chapter == "99").unwrap();
    let held = history.iter().find(|e| e.chapter == "1").unwrap();
    assert!(!streamed.downloaded);
    assert!(held.downloaded);
}

/* ------------------------------------------------------------ erasing history */

#[test]
fn clearing_history_forgets_what_was_read_and_keeps_the_files() {
    let (_dir, library, id) = readable();
    for chapter in ["1", "2"] {
        library.save_progress(id, chapter, 3, true).unwrap();
    }
    assert_eq!(library.history(20).unwrap().len(), 2);

    library.clear_history().unwrap();

    assert!(library.history(20).unwrap().is_empty());
    assert!(
        library.chapter(id, "1").unwrap().downloaded(),
        "clearing history is not deleting anything"
    );
    let chapter = library.chapter(id, "1").unwrap();
    assert_eq!(chapter.last_page, 0);
    assert!(chapter.read_at.is_none() && chapter.opened_at.is_none());
}

#[test]
fn clearing_one_series_leaves_the_others_alone() {
    let (dir, mut library) = open();
    let ichi = library.add_series(ichi()).unwrap().id;
    let other = library
        .add_series(NewSeries {
            source_id: Some("another".into()),
            title: "Something Else".into(),
            ..NewSeries::default()
        })
        .unwrap()
        .id;
    for id in [ichi, other] {
        write_chapter(&library.chapter_dir(id, "1").unwrap(), 2);
        library.record_chapter(id, "1", 2, None).unwrap();
        library.save_progress(id, "1", 1, true).unwrap();
    }
    drop(dir);

    library.clear_series_history(ichi).unwrap();

    let left: Vec<_> = library
        .history(20)
        .unwrap()
        .into_iter()
        .map(|e| e.series_id)
        .collect();
    assert_eq!(left, [other], "only the series asked for is forgotten");
}

#[test]
fn a_series_history_holds_only_that_series() {
    let (dir, mut library) = open();
    let ichi = library.add_series(ichi()).unwrap().id;
    let other = library
        .add_series(NewSeries {
            source_id: Some("another".into()),
            title: "Something Else".into(),
            ..NewSeries::default()
        })
        .unwrap()
        .id;
    for id in [ichi, other] {
        for chapter in ["1", "2"] {
            write_chapter(&library.chapter_dir(id, chapter).unwrap(), 2);
            library.record_chapter(id, chapter, 2, None).unwrap();
            library.save_progress(id, chapter, 1, false).unwrap();
        }
    }
    drop(dir);

    let history = library.series_history(ichi, 20).unwrap();

    assert_eq!(history.len(), 2);
    assert!(history.iter().all(|e| e.series_id == ichi));
    assert_eq!(library.history(20).unwrap().len(), 4, "the whole log is longer");
}

/// `opened_at` is unix seconds, so this is the coarsest ordering the store can
/// promise. Two chapters opened a second apart order; two opened within the
/// same second only order *stably*, which is what the rowid break is for.
#[test]
fn history_puts_the_more_recently_opened_chapter_first() {
    let (_dir, library, id) = readable();
    library.save_progress(id, "1", 4, true).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    library.save_progress(id, "3", 2, false).unwrap();

    let order: Vec<_> = library
        .series_history(id, 20)
        .unwrap()
        .into_iter()
        .map(|e| e.chapter)
        .collect();

    assert_eq!(order, ["3", "1"]);
}

#[test]
fn adding_a_series_you_only_streamed_puts_it_on_the_shelf() {
    let dir = TempDir::new().unwrap();
    let mut library = Library::open(dir.path()).unwrap();

    // Read from Explore first, which records it without shelving.
    let streamed = library.record_unshelved_series(ichi()).unwrap();
    assert!(library.all_series().unwrap().is_empty());

    // Then decide to keep it.
    let added = library.add_series(ichi()).unwrap();

    assert_eq!(added.id, streamed.id, "the same series, not a second row");
    assert!(added.shelved, "and it is on the shelf now");
    assert_eq!(library.all_series().unwrap().len(), 1);
}
