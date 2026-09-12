//! The SQLite schema, and the migration ladder that gets an old file to it.
//!
//! Every step is additive and idempotent. A library folder is something a user
//! accumulates over years, so a migration that could lose a row is not an
//! option; the files on disk are the backstop, but the index should never need
//! it.

use std::time::Duration;

use anyhow::{bail, Result};
use rusqlite::Connection;

/// How long a connection waits for another one to finish writing.
///
/// The app opens the library once per request rather than holding it open, so
/// several commands can be inside the index at the same time. Without this any
/// overlap at all is an immediate "database is locked" instead of a short wait.
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(10);

/// Bump this and add a step whenever the schema changes.
const CURRENT: i64 = 3;

pub fn migrate(db: &Connection) -> Result<()> {
    // IMMEDIATE rather than SQLite's deferred default. Two commands opening a
    // *new* library at once would otherwise both read version 0, both run V1,
    // and the loser would fail with "table series already exists" — leaving a
    // half-built index that every later open trips over in the same way.
    // Taking the write lock up front makes the second one wait and then find
    // the work already done.
    //
    // Android is what surfaced this: its storage is slow enough to lose the
    // race on the first launch every time, where a desktop usually wins it.
    db.execute_batch("BEGIN IMMEDIATE")?;
    match steps(db) {
        Ok(()) => {
            db.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            // The schema is DDL, which SQLite rolls back like anything else, so
            // a failed migration leaves no trace rather than half a schema.
            let _ = db.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn steps(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         )",
    )?;

    let version: i64 = db
        .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    if version > CURRENT {
        bail!(
            "this library was written by a newer version of Mangalize \
             (index version {version}, this build understands {CURRENT})"
        );
    }

    if version < 1 {
        db.execute_batch(V1)?;
    }
    if version < 2 {
        db.execute_batch(V2)?;
    }
    if version < 3 {
        db.execute_batch(V3)?;
    }

    db.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [CURRENT.to_string()],
    )?;
    Ok(())
}

/// Initial schema.
///
/// `chapters` holds both what is published and what is downloaded: a row with a
/// null `folder` is a chapter we know exists but do not have, which is exactly
/// the question the UI asks. Keeping them in one table means "missing chapters"
/// is a filter rather than a join against a second source of truth.
const V1: &str = r#"
CREATE TABLE series (
    id            INTEGER PRIMARY KEY,
    slug          TEXT    NOT NULL DEFAULT '',
    source        TEXT,
    source_id     TEXT,
    title         TEXT    NOT NULL,
    title_romaji  TEXT,
    title_native  TEXT,
    author        TEXT    NOT NULL DEFAULT '',
    artist        TEXT    NOT NULL DEFAULT '',
    description   TEXT    NOT NULL DEFAULT '',
    year          INTEGER,
    status        TEXT,
    language      TEXT    NOT NULL DEFAULT 'en',
    direction     TEXT    NOT NULL DEFAULT 'right-to-left',
    site_url      TEXT,
    cover_path    TEXT,
    added_at      INTEGER NOT NULL,
    synced_at     INTEGER
);

-- Partial index: hand-entered series have no source id and must not collide.
CREATE UNIQUE INDEX series_by_source ON series (source, source_id)
    WHERE source_id IS NOT NULL;

CREATE TABLE volumes (
    series_id  INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    number     TEXT    NOT NULL,
    sort_key   REAL,
    cover_url  TEXT,
    cover_path TEXT,
    PRIMARY KEY (series_id, number)
);

CREATE TABLE chapters (
    id            INTEGER PRIMARY KEY,
    series_id     INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    number        TEXT    NOT NULL,
    sort_key      REAL,
    volume        TEXT,
    title         TEXT,
    folder        TEXT,
    page_count    INTEGER NOT NULL DEFAULT 0,
    source_url    TEXT,
    downloaded_at INTEGER,
    UNIQUE (series_id, number)
);

CREATE INDEX chapters_by_volume ON chapters (series_id, volume);
"#;

/// Carry the metadata source's own chapter id.
///
/// Without it a chapter can only be fetched by pasting a URL. With it, a source
/// that serves images (MangaDex does, for everything it is allowed to) can be
/// asked for the pages directly.
///
/// Added rather than backfilled: the ids arrive on the next sync, and a library
/// that never syncs again is no worse off than before.
const V2: &str = r#"
ALTER TABLE chapters ADD COLUMN source_id TEXT;
ALTER TABLE chapters ADD COLUMN unavailable INTEGER NOT NULL DEFAULT 0;
"#;

/// Where the reader left off.
///
/// Three columns rather than a separate progress table: a chapter has exactly
/// one reading position, and joining a table to find it would buy nothing.
///
/// `opened_at` is what history is built from, and is deliberately separate from
/// `read_at`. Opening a chapter and abandoning it on page three is the case
/// "continue reading" exists for, and a single timestamp could not tell that
/// apart from having finished it.
const V3: &str = r#"
ALTER TABLE chapters ADD COLUMN last_page INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chapters ADD COLUMN read_at INTEGER;
ALTER TABLE chapters ADD COLUMN opened_at INTEGER;

CREATE INDEX chapters_by_opened ON chapters (opened_at DESC);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrating_twice_is_a_no_op() {
        let db = Connection::open_in_memory().unwrap();
        migrate(&db).unwrap();
        migrate(&db).unwrap();
    }

    #[test]
    fn migrations_run_in_order_from_any_starting_version() {
        for start in 0..=CURRENT {
            let db = Connection::open_in_memory().unwrap();
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            )
            .unwrap();
            if start >= 1 {
                db.execute_batch(V1).unwrap();
            }
            if start >= 2 {
                db.execute_batch(V2).unwrap();
            }
            if start >= 3 {
                db.execute_batch(V3).unwrap();
            }
            db.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)",
                [start.to_string()],
            )
            .unwrap();

            migrate(&db).expect("migrating from v{start} should work");

            // Every column the current code reads must exist afterwards.
            db.query_row(
                "SELECT number, source_id, unavailable, last_page, read_at, opened_at
                   FROM chapters LIMIT 1",
                [],
                |_| Ok(()),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(()),
                other => Err(other),
            })
            .unwrap_or_else(|e| panic!("v{start} -> current left a column missing: {e}"));
        }
    }

    #[test]
    fn an_existing_library_gains_the_new_columns() {
        let db = Connection::open_in_memory().unwrap();
        // Start at v1, as a library created before this change would be.
        db.execute_batch(V1).unwrap();
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )
        .unwrap();
        db.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', '1')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO series (slug, title, added_at) VALUES ('x', 'X', 0)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO chapters (series_id, number) VALUES (1, '7')",
            [],
        )
        .unwrap();

        migrate(&db).unwrap();

        // The row survives, and the new columns are queryable.
        let (number, source_id): (String, Option<String>) = db
            .query_row(
                "SELECT number, source_id FROM chapters WHERE series_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(number, "7");
        assert_eq!(source_id, None);
    }

    #[test]
    fn a_newer_index_is_refused_rather_than_downgraded() {
        let db = Connection::open_in_memory().unwrap();
        migrate(&db).unwrap();
        db.execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'", [])
            .unwrap();
        assert!(migrate(&db).is_err());
    }
}
