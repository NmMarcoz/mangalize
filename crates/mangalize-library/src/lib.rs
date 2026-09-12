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
    BuiltVolume, ChapterStatus, HistoryEntry, NewSeries, PublishedChapter, PublishedVolume, Series,
    SeriesId, SyncReport, VolumeStatus,
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

        // Before the pragmas, not after: changing the journal mode also wants
        // the lock, so a second command arriving mid-open should wait rather
        // than fail.
        db.busy_timeout(schema::BUSY_TIMEOUT)?;

        // Foreign keys are off by default in SQLite, and the cascade from series
        // to chapters is the whole reason the constraints are declared.
        db.pragma_update(None, "foreign_keys", "ON")?;
        // WAL survives a crash mid-write far better than the rollback journal,
        // and the app writes while the user is reading the same rows.
        //
        // Changing the mode needs exclusive access to the file and fails
        // immediately rather than waiting, so two commands opening the library
        // at the same moment cannot both set it. The mode belongs to the file
        // and not the connection, though: whoever wins sets it for everyone,
        // which is why the loser carrying on is right rather than merely
        // tolerable. Only ask when it is not already what we want, so the
        // common case takes no lock at all.
        let mode: String = db.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            let _ = db.pragma_update(None, "journal_mode", "WAL");
        }

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
    /// Add a series to the shelf, or return the one already there.
    pub fn add_series(&mut self, new: NewSeries) -> Result<Series> {
        self.insert_series(new, true)
    }

    /// Record a series without putting it on the shelf.
    ///
    /// For something read straight from the source: history and resuming need a
    /// row to hang off, but the user did not ask for it to be in their library.
    /// A series already on the shelf stays there — this never demotes one.
    pub fn record_unshelved_series(&mut self, new: NewSeries) -> Result<Series> {
        self.insert_series(new, false)
    }

    /// Put a series that was only recorded onto the shelf.
    pub fn shelve(&self, id: SeriesId) -> Result<()> {
        self.db
            .execute("UPDATE series SET shelved = 1 WHERE id = ?1", params![id.0])?;
        Ok(())
    }

    fn insert_series(&mut self, new: NewSeries, shelved: bool) -> Result<Series> {
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
                site_url, added_at, tags, content_rating, shelved)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'en', 'right-to-left',
                     ?12, ?13, ?14, ?15, ?16)",
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
                new.tags.join("\n"),
                new.content_rating,
                shelved as i64,
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

    /// Everything on the shelf. Series recorded only by reading are excluded;
    /// they reach the UI through `history` instead.
    pub fn all_series(&self) -> Result<Vec<Series>> {
        self.query_series("WHERE s.shelved = 1 ORDER BY s.title COLLATE NOCASE", params![])
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
                    "INSERT INTO chapters
                       (series_id, number, sort_key, volume, title, source_id, unavailable)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(series_id, number) DO UPDATE SET
                       volume      = excluded.volume,
                       title       = COALESCE(excluded.title, chapters.title),
                       source_id   = COALESCE(excluded.source_id, chapters.source_id),
                       unavailable = excluded.unavailable",
                    params![
                        id.0,
                        chapter.number,
                        paths::sort_key(&chapter.number),
                        volume.number,
                        chapter.title,
                        chapter.source_id,
                        chapter.unavailable,
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
            "SELECT number, cover_url, cover_path, built_path, built_at, built_bytes
               FROM volumes WHERE series_id = ?1",
        )?;
        type VolumeRow = (String, Option<String>, Option<String>, Option<BuiltVolume>);
        let covers: Vec<VolumeRow> = covers
            .query_map(params![id.0], |row| {
                // A recorded build whose file has gone counts as not built, so a
                // half-cleaned output folder heals itself rather than offering to
                // share something that is not there.
                let built = match (
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ) {
                    (Some(path), Some(built_at), Some(bytes)) => {
                        let path = PathBuf::from(path);
                        path.is_file().then_some(BuiltVolume {
                            path,
                            built_at,
                            bytes: bytes.max(0) as u64,
                        })
                    }
                    _ => None,
                };
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, built))
            })?
            .collect::<rusqlite::Result<_>>()?;

        let mut stmt = self.db.prepare(
            "SELECT volume, number, title, folder, page_count, source_url, downloaded_at,
                    source_id, unavailable, last_page, read_at, opened_at
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
                        source_id: row.get(7)?,
                        unavailable: row.get(8)?,
                        last_page: row.get::<_, i64>(9)? as u32,
                        read_at: row.get(10)?,
                        opened_at: row.get(11)?,
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
                    built: None,
                }),
            }
        }

        // A volume with published cover art but nothing known in it is still
        // worth showing: it is the clearest possible "you are missing all of v4".
        for (number, cover_url, _, _) in &covers {
            if !volumes.iter().any(|v| &v.number == number) {
                volumes.push(VolumeStatus {
                    number: number.clone(),
                    cover_url: cover_url.clone(),
                    cover_path: None,
                    chapters: Vec::new(),
                    built: None,
                });
            }
        }

        for volume in &mut volumes {
            if let Some((_, url, path, built)) = covers.iter().find(|(n, ..)| n == &volume.number) {
                volume.cover_url = url.clone();
                volume.cover_path = path.as_ref().map(|p| folder.join(p));
                volume.built = built.clone();
            }
        }

        volumes.sort_by(|a, b| {
            volume_order(&a.number)
                .partial_cmp(&volume_order(&b.number))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(volumes)
    }

    /// Remember where a volume was written.
    ///
    /// Recorded against the volume rather than worked out from the output folder
    /// on demand, because the folder is the user's and the naming rules can
    /// change: what was written is a fact, where it would be written now is a
    /// guess. `volumes` checks the file still exists before reporting it.
    pub fn record_built(&self, id: SeriesId, number: &str, path: &Path, bytes: u64) -> Result<()> {
        // A volume built out of loose chapters may have no published row yet.
        self.db.execute(
            "INSERT INTO volumes (series_id, number) VALUES (?1, ?2)
             ON CONFLICT(series_id, number) DO NOTHING",
            params![id.0, number],
        )?;
        self.db.execute(
            "UPDATE volumes SET built_path = ?1, built_at = ?2, built_bytes = ?3
              WHERE series_id = ?4 AND number = ?5",
            params![path.to_string_lossy(), now(), bytes as i64, id.0, number],
        )?;
        Ok(())
    }

    /// Forget a recorded build, without touching the file.
    pub fn clear_built(&self, id: SeriesId, number: &str) -> Result<()> {
        self.db.execute(
            "UPDATE volumes SET built_path = NULL, built_at = NULL, built_bytes = NULL
              WHERE series_id = ?1 AND number = ?2",
            params![id.0, number],
        )?;
        Ok(())
    }

    /// Note that a chapter exists and was opened, for a series being read from
    /// its source rather than from disk.
    ///
    /// The chapter row carries no `folder`, which is the same shape as a chapter
    /// the library knows about but does not hold — so history, resuming and the
    /// missing-chapter filter all work on it without learning a new case.
    pub fn record_streamed_chapter(
        &self,
        id: SeriesId,
        number: &str,
        source_id: Option<&str>,
    ) -> Result<()> {
        self.db.execute(
            "INSERT INTO chapters (series_id, number, sort_key, source_id)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(series_id, number) DO UPDATE SET
               source_id = COALESCE(excluded.source_id, chapters.source_id)",
            params![id.0, number, paths::sort_key(number), source_id],
        )?;
        Ok(())
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
                "SELECT number, title, folder, page_count, source_url, downloaded_at,
                        source_id, unavailable, last_page, read_at, opened_at
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
                        source_id: row.get(6)?,
                        unavailable: row.get(7)?,
                        last_page: row.get::<_, i64>(8)? as u32,
                        read_at: row.get(9)?,
                        opened_at: row.get(10)?,
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

    /* ------------------------------------------------------------- reading */

    /// Every downloaded chapter number, in reading order.
    ///
    /// What the reader steps through: chapters it does not hold are not gaps to
    /// stop at, they are simply not there.
    pub fn downloaded_chapter_numbers(&self, id: SeriesId) -> Result<Vec<String>> {
        let mut stmt = self.db.prepare(
            "SELECT number FROM chapters
              WHERE series_id = ?1 AND folder IS NOT NULL
              ORDER BY sort_key IS NULL, sort_key, number",
        )?;
        let numbers = stmt
            .query_map(params![id.0], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(numbers)
    }

    /// The page files of a downloaded chapter, in reading order.
    ///
    /// Sorted naturally rather than lexicographically. Pages this app wrote are
    /// zero-padded and would sort correctly either way, but a chapter imported
    /// from a folder the user already had need not be.
    pub fn chapter_page_files(&self, id: SeriesId, number: &str) -> Result<Vec<PathBuf>> {
        let chapter = self.chapter(id, number)?;
        let folder = chapter
            .folder
            .ok_or_else(|| anyhow!("chapter {number} has not been downloaded"))?;

        let mut files: Vec<PathBuf> = std::fs::read_dir(&folder)
            .with_context(|| format!("reading {}", folder.display()))?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|entry| entry.path())
            .filter(|path| mangalize_core::page::extension_verdict(path).is_none())
            .collect();

        files.sort_by(|a, b| {
            let name = |p: &PathBuf| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string()
            };
            mangalize_core::natsort::natural_cmp(&name(a), &name(b))
        });
        Ok(files)
    }

    /// Record where the reader is in a chapter.
    ///
    /// `finished` is passed rather than inferred from the page number: a reader
    /// that stops on the last page has not necessarily finished it, and one
    /// that skips to the end has. Only the caller watching the reader knows.
    ///
    /// `read_at` is set once and then left alone, so re-reading does not erase
    /// when a chapter was first completed.
    pub fn save_progress(
        &self,
        id: SeriesId,
        number: &str,
        page: u32,
        finished: bool,
    ) -> Result<()> {
        let now = now();
        self.db.execute(
            "UPDATE chapters
                SET last_page = ?3,
                    opened_at = ?4,
                    read_at = CASE WHEN ?5 THEN COALESCE(read_at, ?4) ELSE read_at END
              WHERE series_id = ?1 AND number = ?2",
            params![id.0, number, page as i64, now, finished],
        )?;
        Ok(())
    }

    /// Forget that a chapter was read, without touching its files.
    pub fn clear_progress(&self, id: SeriesId, number: &str) -> Result<()> {
        self.db.execute(
            "UPDATE chapters SET last_page = 0, read_at = NULL, opened_at = NULL
              WHERE series_id = ?1 AND number = ?2",
            params![id.0, number],
        )?;
        Ok(())
    }

    /// Recently opened chapters, newest first.
    ///
    /// Only chapters still on disk: an entry pointing at pages that have been
    /// deleted is a dead end rather than history.
    pub fn history(&self, limit: u32) -> Result<Vec<HistoryEntry>> {
        let series_root = self.root.join("series");
        let mut stmt = self.db.prepare(
            "SELECT s.id, s.slug, s.title, s.cover_path,
                    c.number, c.last_page, c.page_count, c.opened_at, c.read_at
               FROM chapters c
               JOIN series s ON s.id = c.series_id
              WHERE c.opened_at IS NOT NULL AND c.folder IS NOT NULL
              ORDER BY c.opened_at DESC
              LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            let slug: String = row.get(1)?;
            let folder = series_root.join(&slug);
            let cover: Option<String> = row.get(3)?;
            Ok(HistoryEntry {
                series_id: SeriesId(row.get(0)?),
                series_title: row.get(2)?,
                cover_path: cover.map(|c| folder.join(c)),
                chapter: row.get(4)?,
                last_page: row.get::<_, i64>(5)? as u32,
                page_count: row.get::<_, i64>(6)? as u32,
                opened_at: row.get(7)?,
                finished: row.get::<_, Option<i64>>(8)?.is_some(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The chapter to offer as "continue reading" for a series.
    ///
    /// The most recently opened unfinished chapter, or failing that the first
    /// downloaded chapter that has never been opened. Someone who finished
    /// everything they started wants the next one, not the last one again.
    pub fn resume_point(&self, id: SeriesId) -> Result<Option<ChapterStatus>> {
        let unfinished: Option<String> = self
            .db
            .query_row(
                "SELECT number FROM chapters
                  WHERE series_id = ?1 AND folder IS NOT NULL
                    AND opened_at IS NOT NULL AND read_at IS NULL
                  ORDER BY opened_at DESC LIMIT 1",
                params![id.0],
                |row| row.get(0),
            )
            .optional()?;

        let number = match unfinished {
            Some(number) => Some(number),
            None => self
                .db
                .query_row(
                    "SELECT number FROM chapters
                      WHERE series_id = ?1 AND folder IS NOT NULL AND read_at IS NULL
                      ORDER BY sort_key IS NULL, sort_key, number LIMIT 1",
                    params![id.0],
                    |row| row.get(0),
                )
                .optional()?,
        };

        match number {
            Some(number) => Ok(Some(self.chapter(id, &number)?)),
            None => Ok(None),
        }
    }

    /* ------------------------------------------------------------- helpers */

    fn query_series(&self, tail: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Series>> {
        let sql = format!(
            "SELECT s.id, s.slug, s.source, s.source_id, s.title, s.title_romaji,
                    s.title_native, s.author, s.artist, s.description, s.year,
                    s.status, s.language, s.direction, s.site_url, s.cover_path,
                    s.added_at, s.synced_at, s.tags, s.content_rating, s.shelved,
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
                tags: {
                    let raw: String = row.get(18)?;
                    raw.lines().filter(|t| !t.is_empty()).map(str::to_owned).collect()
                },
                content_rating: row.get(19)?,
                shelved: row.get::<_, i64>(20)? != 0,
                have_chapters: row.get::<_, i64>(21)? as u32,
                known_chapters: row.get::<_, i64>(22)? as u32,
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
