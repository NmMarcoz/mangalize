//! A persistent library of series, volumes and downloaded chapters.
//!
//! Modelled on the shape Calibre uses: a folder the user owns, holding the
//! actual files, with an index beside them. The index is SQLite; the files are
//! laid out so they remain meaningful without it.
//!
//! ```text
//! <library>/
//!   mangalize.db
//!   series/
//!     Ichi the Witch [1]/
//!       cover.jpg
//!       chapters/
//!         c0007/0001.jpg …
//! ```
//!
//! Like [`mangalize_core`], this crate never touches the network. It is handed
//! already-fetched metadata and already-downloaded bytes; deciding when to go
//! online is the caller's job.

pub mod model;
pub mod paths;
mod schema;
mod volume;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

pub use model::{
    ChapterStatus, NewSeries, PublishedChapter, PublishedVolume, Series, SeriesId, SyncReport,
    VolumeStatus,
};

/// The name of the index file inside the library folder.
const DB_FILE: &str = "mangalize.db";

/// An open library. Cheap to construct, so callers may open one per request
/// rather than holding a connection across the IPC boundary.
pub struct Library {
    root: PathBuf,
    db: Connection,
}

impl Library {
    /// Open, creating the folder structure and index if they do not exist.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        std::fs::create_dir_all(root.join("series"))
            .with_context(|| format!("creating library at {}", root.display()))?;

        let db = Connection::open(root.join(DB_FILE))
            .with_context(|| format!("opening {}", root.join(DB_FILE).display()))?;

        // Foreign keys are off by default in SQLite, and the cascade from series
        // to chapters is the whole reason the constraints are declared.
        db.pragma_update(None, "foreign_keys", "ON")?;
        // WAL survives a crash mid-write far better than the rollback journal,
        // and the app writes while the user is reading the same rows.
        db.pragma_update(None, "journal_mode", "WAL")?;

        schema::migrate(&db)?;
        Ok(Self { root, db })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /* ------------------------------------------------------------- series */

    /// Add a series, or return the one already stored for the same source id.
    ///
    /// Adding twice is something a user does by accident constantly — searching
    /// again for a series they already have — so it is idempotent rather than
    /// an error.
    pub fn add_series(&mut self, new: NewSeries) -> Result<Series> {
        if let (Some(source), Some(source_id)) = (&new.source, &new.source_id) {
            if let Some(existing) = self.find_by_source(source, source_id)? {
                return Ok(existing);
            }
        }

        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO series
               (slug, source, source_id, title, title_romaji, title_native,
                author, artist, description, year, status, language, direction,
                site_url, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'en', 'right-to-left', ?12, ?13)",
            params![
                "",
                new.source,
                new.source_id,
                new.title,
                new.title_romaji,
                new.title_native,
                new.author,
                new.artist,
                new.description,
                new.year,
                new.status,
                new.site_url,
                now(),
            ],
        )?;

        // The slug embeds the row id to guarantee uniqueness, so it can only be
        // written once the insert has assigned one.
        let id = tx.last_insert_rowid();
        let slug = paths::series_slug(&new.title, id);
        tx.execute("UPDATE series SET slug = ?1 WHERE id = ?2", params![slug, id])?;
        tx.commit()?;

        std::fs::create_dir_all(self.root.join("series").join(&slug).join("chapters"))
            .with_context(|| format!("creating series folder for {}", new.title))?;

        self.series(SeriesId(id))
    }

    pub fn series(&self, id: SeriesId) -> Result<Series> {
        self.query_series("WHERE s.id = ?1", params![id.0])?
            .pop()
            .ok_or_else(|| anyhow!("no series with id {}", id.0))
    }

    pub fn all_series(&self) -> Result<Vec<Series>> {
        self.query_series("ORDER BY s.title COLLATE NOCASE", params![])
    }

    fn find_by_source(&self, source: &str, source_id: &str) -> Result<Option<Series>> {
        Ok(self
            .query_series(
                "WHERE s.source = ?1 AND s.source_id = ?2",
                params![source, source_id],
            )?
            .pop())
    }

    /// Update the editable metadata fields. Identity and layout are not touched.
    pub fn update_series(
        &self,
        id: SeriesId,
        title: &str,
        author: &str,
        description: &str,
        language: &str,
        direction: &str,
    ) -> Result<Series> {
        self.db.execute(
            "UPDATE series SET title = ?1, author = ?2, description = ?3,
                               language = ?4, direction = ?5 WHERE id = ?6",
            params![title, author, description, language, direction, id.0],
        )?;
        self.series(id)
    }

    /// Remove a series from the index, optionally deleting its files.
    ///
    /// Deleting files is opt-in and never the default: the whole point of a
    /// library is that it holds things the user spent effort collecting.
    pub fn remove_series(&self, id: SeriesId, delete_files: bool) -> Result<()> {
        let folder = self.series(id)?.folder;
        self.db.execute("DELETE FROM series WHERE id = ?1", params![id.0])?;
        if delete_files && folder.starts_with(self.root.join("series")) {
            std::fs::remove_dir_all(&folder)
                .with_context(|| format!("deleting {}", folder.display()))?;
        }
        Ok(())
    }

    /// Record a downloaded series cover, already written inside the library.
    pub fn set_cover(&self, id: SeriesId, bytes: &[u8]) -> Result<PathBuf> {
        let folder = self.series(id)?.folder;
        let path = folder.join("cover.jpg");
        std::fs::write(&path, bytes).with_context(|| format!("writing {}", path.display()))?;
        self.db.execute(
            "UPDATE series SET cover_path = 'cover.jpg' WHERE id = ?1",
            params![id.0],
        )?;
        Ok(path)
    }

    /// Store a downloaded volume cover, and return where it landed.
    ///
    /// Kept inside the series folder rather than a cache, because unlike a
    /// search thumbnail this is part of the collection: it is what the shelf
    /// shows, and it should survive going offline.
    pub fn set_volume_cover(&self, id: SeriesId, number: &str, bytes: &[u8]) -> Result<PathBuf> {
        let folder = self.series(id)?.folder;
        let dir = folder.join("volumes");
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating {}", dir.display()))?;

        let relative = format!("volumes/{}.jpg", paths::volume_slug(number));
        let path = folder.join(&relative);
        std::fs::write(&path, bytes).with_context(|| format!("writing {}", path.display()))?;

        // The volume row may not exist when the cover arrives before a sync.
        self.db.execute(
            "INSERT INTO volumes (series_id, number, sort_key, cover_path)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(series_id, number) DO UPDATE SET cover_path = excluded.cover_path",
            params![id.0, number, paths::sort_key(number), relative],
        )?;
        Ok(path)
    }

    /// Volumes that have published cover art but no local copy of it yet.
    pub fn volumes_missing_covers(&self, id: SeriesId) -> Result<Vec<(String, String)>> {
        let folder = self.series(id)?.folder;
        let mut stmt = self.db.prepare(
            "SELECT number, cover_url, cover_path FROM volumes
              WHERE series_id = ?1 AND cover_url IS NOT NULL",
        )?;
        let rows: Vec<(String, String, Option<String>)> = stmt
            .query_map(params![id.0], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;

        Ok(rows
            .into_iter()
            // A recorded path whose file has since been deleted counts as missing,
            // so a half-cleaned library heals itself on the next refresh.
            .filter(|(_, _, path)| !path.as_ref().is_some_and(|p| folder.join(p).exists()))
            .map(|(number, url, _)| (number, url))
            .collect())
    }

    /* ------------------------------------------------------------- layout */

    /// Merge a published volume/chapter layout into what we already know.
    ///
    /// Chapters we hold on disk are never removed, even when the published
    /// layout stops listing them: crowd-sourced indexes get re-tagged and
    /// re-numbered all the time, and the user's files are the durable thing.
    pub fn sync_layout(&mut self, id: SeriesId, published: &[PublishedVolume]) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        let tx = self.db.transaction()?;

        // What we already knew, so "added" can mean newly-known chapters. An
        // upsert reports a row changed whether it inserted or updated, which
        // would otherwise make every re-sync look like a first one.
        let known: std::collections::HashSet<String> = {
            let mut stmt = tx.prepare("SELECT number FROM chapters WHERE series_id = ?1")?;
            let numbers = stmt
                .query_map(params![id.0], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            numbers
        };

        for volume in published {
            tx.execute(
                "INSERT INTO volumes (series_id, number, sort_key, cover_url)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(series_id, number) DO UPDATE SET
                   cover_url = COALESCE(excluded.cover_url, volumes.cover_url)",
                params![id.0, volume.number, paths::sort_key(&volume.number), volume.cover_url],
            )?;
            report.volumes += 1;

            for chapter in &volume.chapters {
                // A chapter already on disk keeps its folder and page count; only
                // its volume tag and title are refreshed.
                tx.execute(
                    "INSERT INTO chapters (series_id, number, sort_key, volume, title)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(series_id, number) DO UPDATE SET
                       volume = excluded.volume,
                       title  = COALESCE(excluded.title, chapters.title)",
                    params![
                        id.0,
                        chapter.number,
                        paths::sort_key(&chapter.number),
                        volume.number,
                        chapter.title,
                    ],
                )?;
                if !known.contains(&chapter.number) {
                    report.chapters_added += 1;
                }
            }
        }

        // Anything we hold that the published layout did not mention. Counting it
        // in Rust rather than SQL keeps the "never delete" rule obvious.
        let listed: std::collections::HashSet<&str> = published
            .iter()
            .flat_map(|v| v.chapters.iter().map(|c| c.number.as_str()))
            .collect();
        {
            let mut held = tx.prepare(
                "SELECT number FROM chapters WHERE series_id = ?1 AND folder IS NOT NULL",
            )?;
            report.orphaned = held
                .query_map(params![id.0], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .filter(|number| !listed.contains(number.as_str()))
                .count();
        }

        tx.execute(
            "UPDATE series SET synced_at = ?1 WHERE id = ?2",
            params![now(), id.0],
        )?;
        tx.commit()?;
        Ok(report)
    }

    /// Every volume of a series, with what we hold of each.
    ///
    /// Chapters with no published volume are gathered under an `"Unsorted"`
    /// entry that always sorts last, so a chapter is never simply invisible.
    pub fn volumes(&self, id: SeriesId) -> Result<Vec<VolumeStatus>> {
        let folder = self.series(id)?.folder;

        let mut covers = self.db.prepare(
            "SELECT number, cover_url, cover_path FROM volumes WHERE series_id = ?1",
        )?;
        let covers: Vec<(String, Option<String>, Option<String>)> = covers
            .query_map(params![id.0], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;

        let mut stmt = self.db.prepare(
            "SELECT volume, number, title, folder, page_count, source_url, downloaded_at
               FROM chapters WHERE series_id = ?1
              ORDER BY sort_key IS NULL, sort_key, number",
        )?;
        let rows: Vec<(Option<String>, ChapterStatus)> = stmt
            .query_map(params![id.0], |row| {
                let relative: Option<String> = row.get(3)?;
                Ok((
                    row.get(0)?,
                    ChapterStatus {
                        number: row.get(1)?,
                        title: row.get(2)?,
                        folder: relative.map(|r| folder.join(r)),
                        page_count: row.get::<_, i64>(4)? as u32,
                        source_url: row.get(5)?,
                        downloaded_at: row.get(6)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;

        let mut volumes: Vec<VolumeStatus> = Vec::new();
        for (volume, chapter) in rows {
            let label = volume.unwrap_or_else(|| UNSORTED.to_string());
            match volumes.iter_mut().find(|v| v.number == label) {
                Some(existing) => existing.chapters.push(chapter),
                None => volumes.push(VolumeStatus {
                    number: label,
                    cover_url: None,
                    cover_path: None,
                    chapters: vec![chapter],
                }),
            }
        }

        // A volume with published cover art but nothing known in it is still
        // worth showing: it is the clearest possible "you are missing all of v4".
        for (number, cover_url, _) in &covers {
            if !volumes.iter().any(|v| &v.number == number) {
                volumes.push(VolumeStatus {
                    number: number.clone(),
                    cover_url: cover_url.clone(),
                    cover_path: None,
                    chapters: Vec::new(),
                });
            }
        }

        for volume in &mut volumes {
            if let Some((_, url, path)) = covers.iter().find(|(n, _, _)| n == &volume.number) {
                volume.cover_url = url.clone();
                volume.cover_path = path.as_ref().map(|p| folder.join(p));
            }
        }

        volumes.sort_by(|a, b| {
            volume_order(&a.number)
                .partial_cmp(&volume_order(&b.number))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(volumes)
    }

    /* ------------------------------------------------------------ chapters */

    /// Where a chapter's images belong. Creating the folder is the caller's job,
    /// because a folder that exists but holds nothing looks like a failed rip.
    pub fn chapter_dir(&self, id: SeriesId, number: &str) -> Result<PathBuf> {
        Ok(self
            .series(id)?
            .folder
            .join("chapters")
            .join(paths::chapter_slug(number)))
    }

    /// Record that a chapter's pages are now on disk.
    ///
    /// Also inserts the chapter if the published layout never mentioned it, so
    /// grabbing a chapter the index does not know about still works.
    pub fn record_chapter(
        &self,
        id: SeriesId,
        number: &str,
        page_count: u32,
        source_url: Option<&str>,
    ) -> Result<ChapterStatus> {
        let relative = format!("chapters/{}", paths::chapter_slug(number));
        self.db.execute(
            "INSERT INTO chapters
               (series_id, number, sort_key, folder, page_count, source_url, downloaded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(series_id, number) DO UPDATE SET
               folder        = excluded.folder,
               page_count    = excluded.page_count,
               source_url    = COALESCE(excluded.source_url, chapters.source_url),
               downloaded_at = excluded.downloaded_at",
            params![
                id.0,
                number,
                paths::sort_key(number),
                relative,
                page_count as i64,
                source_url,
                now(),
            ],
        )?;
        self.chapter(id, number)
    }

    pub fn chapter(&self, id: SeriesId, number: &str) -> Result<ChapterStatus> {
        let folder = self.series(id)?.folder;
        self.db
            .query_row(
                "SELECT number, title, folder, page_count, source_url, downloaded_at
                   FROM chapters WHERE series_id = ?1 AND number = ?2",
                params![id.0, number],
                |row| {
                    let relative: Option<String> = row.get(2)?;
                    Ok(ChapterStatus {
                        number: row.get(0)?,
                        title: row.get(1)?,
                        folder: relative.map(|r| folder.join(r)),
                        page_count: row.get::<_, i64>(3)? as u32,
                        source_url: row.get(4)?,
                        downloaded_at: row.get(5)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!("series {} has no chapter {number}", id.0))
    }

    /// Forget a downloaded chapter and delete its images.
    ///
    /// The row survives when the published layout knows the chapter: it goes
    /// back to being a known-missing chapter rather than vanishing.
    pub fn delete_chapter(&self, id: SeriesId, number: &str) -> Result<()> {
        let chapter = self.chapter(id, number)?;
        if let Some(folder) = chapter.folder {
            if folder.starts_with(&self.root) {
                let _ = std::fs::remove_dir_all(&folder);
            }
        }
        self.db.execute(
            "UPDATE chapters SET folder = NULL, page_count = 0, downloaded_at = NULL
              WHERE series_id = ?1 AND number = ?2",
            params![id.0, number],
        )?;
        self.db.execute(
            "DELETE FROM chapters
              WHERE series_id = ?1 AND number = ?2 AND volume IS NULL",
            params![id.0, number],
        )?;
        Ok(())
    }

    /* ------------------------------------------------------------- helpers */

    fn query_series(&self, tail: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Series>> {
        let sql = format!(
            "SELECT s.id, s.slug, s.source, s.source_id, s.title, s.title_romaji,
                    s.title_native, s.author, s.artist, s.description, s.year,
                    s.status, s.language, s.direction, s.site_url, s.cover_path,
                    s.added_at, s.synced_at,
                    (SELECT COUNT(*) FROM chapters c
                      WHERE c.series_id = s.id AND c.folder IS NOT NULL),
                    (SELECT COUNT(*) FROM chapters c WHERE c.series_id = s.id)
               FROM series s {tail}"
        );

        let series_root = self.root.join("series");
        let mut stmt = self.db.prepare(&sql)?;
        let rows = stmt.query_map(args, |row| {
            let slug: String = row.get(1)?;
            let folder = series_root.join(&slug);
            let cover: Option<String> = row.get(15)?;
            Ok(Series {
                id: SeriesId(row.get(0)?),
                source: row.get(2)?,
                source_id: row.get(3)?,
                title: row.get(4)?,
                title_romaji: row.get(5)?,
                title_native: row.get(6)?,
                author: row.get(7)?,
                artist: row.get(8)?,
                description: row.get(9)?,
                year: row.get::<_, Option<i64>>(10)?.map(|y| y as u32),
                status: row.get(11)?,
                language: row.get(12)?,
                direction: row.get(13)?,
                site_url: row.get(14)?,
                cover_path: cover.map(|c| folder.join(c)),
                folder,
                added_at: row.get(16)?,
                synced_at: row.get(17)?,
                have_chapters: row.get::<_, i64>(18)? as u32,
                known_chapters: row.get::<_, i64>(19)? as u32,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

/// The bucket for chapters no published volume claims.
pub const UNSORTED: &str = "Unsorted";

/// Volume ordering: numeric where possible, `Unsorted` dead last.
fn volume_order(label: &str) -> (u8, f64) {
    match paths::sort_key(label) {
        Some(n) => (0, n),
        None if label == UNSORTED => (2, 0.0),
        None => (1, 0.0),
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
