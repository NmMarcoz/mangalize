//! The SQLite schema, and the migration ladder that gets an old file to it.
//!
//! Every step is additive and idempotent. A library folder is something a user
//! accumulates over years, so a migration that could lose a row is not an
//! option; the files on disk are the backstop, but the index should never need
//! it.

use anyhow::{bail, Result};
use rusqlite::Connection;

/// Bump this and add a step whenever the schema changes.
const CURRENT: i64 = 1;

pub fn migrate(db: &Connection) -> Result<()> {
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
    fn a_newer_index_is_refused_rather_than_downgraded() {
        let db = Connection::open_in_memory().unwrap();
        migrate(&db).unwrap();
        db.execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'", [])
            .unwrap();
        assert!(migrate(&db).is_err());
    }
}
