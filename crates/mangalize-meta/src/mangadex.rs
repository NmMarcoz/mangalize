//! MangaDex client.
//!
//! Responses are walked as untyped JSON rather than mapped to structs: the
//! shapes are deeply nested, heavily optional, and mostly discarded, so a full
//! typed mirror would be more code to maintain for no safety we actually use.

use anyhow::Result;
use serde_json::Value;

use crate::{get_json, volume_sort_key, SeriesMatch, Source, VolumeChapters, VolumeCover};

const API: &str = "https://api.mangadex.org";
const UPLOADS: &str = "https://uploads.mangadex.org/covers";

pub fn search(query: &str, limit: u32) -> Result<Vec<SeriesMatch>> {
    let limit = limit.clamp(1, 25).to_string();
    let body = get_json(
        &format!("{API}/manga"),
        &[
            ("title", query),
            ("limit", &limit),
            ("includes[]", "author"),
            ("includes[]", "artist"),
            ("includes[]", "cover_art"),
            ("order[relevance]", "desc"),
        ],
    )?;

    Ok(body["data"]
        .as_array()
        .map(|items| items.iter().filter_map(parse_series).collect())
        .unwrap_or_default())
}

fn parse_series(item: &Value) -> Option<SeriesMatch> {
    let id = item["id"].as_str()?.to_string();
    let attrs = &item["attributes"];

    let cover_file = relationship(item, "cover_art")
        .and_then(|r| r["attributes"]["fileName"].as_str())
        .map(String::from);

    Some(SeriesMatch {
        source: Source::MangaDex,
        thumbnail_url: cover_file
            .as_ref()
            .map(|f| format!("{UPLOADS}/{id}/{f}.256.jpg")),
        site_url: Some(format!("https://mangadex.org/title/{id}")),
        title_english: localized(attrs, "en"),
        title_romaji: localized(attrs, "ja-ro"),
        title_native: localized(attrs, "ja"),
        author: relationship(item, "author")
            .and_then(|r| r["attributes"]["name"].as_str())
            .map(|s| s.trim().to_string()),
        artist: relationship(item, "artist")
            .and_then(|r| r["attributes"]["name"].as_str())
            .map(|s| s.trim().to_string()),
        description: attrs["description"]["en"].as_str().map(String::from),
        year: attrs["year"].as_u64().map(|y| y as u32),
        status: attrs["status"].as_str().map(String::from),
        demographic: attrs["publicationDemographic"].as_str().map(String::from),
        id,
    })
}

/// Find a title in `language`, checking the canonical title first and then the
/// alternates.
///
/// MangaDex stores exactly one canonical title, in whichever language the
/// uploader chose, so the English name of a Japanese series is almost always in
/// `altTitles` rather than `title`.
fn localized(attrs: &Value, language: &str) -> Option<String> {
    if let Some(found) = attrs["title"][language].as_str() {
        return Some(found.to_string());
    }
    attrs["altTitles"]
        .as_array()?
        .iter()
        .find_map(|alt| alt[language].as_str())
        .map(String::from)
}

fn relationship<'a>(item: &'a Value, kind: &str) -> Option<&'a Value> {
    item["relationships"]
        .as_array()?
        .iter()
        .find(|r| r["type"].as_str() == Some(kind))
}

/// Every cover the series has, one per volume where tagged.
pub fn volume_covers(manga_id: &str) -> Result<Vec<VolumeCover>> {
    let body = get_json(
        &format!("{API}/cover"),
        &[
            ("manga[]", manga_id),
            ("limit", "100"),
            ("order[volume]", "asc"),
        ],
    )?;

    let mut covers: Vec<VolumeCover> = body["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let file = item["attributes"]["fileName"].as_str()?;
                    Some(VolumeCover {
                        volume: item["attributes"]["volume"].as_str().map(String::from),
                        url: format!("{UPLOADS}/{manga_id}/{file}"),
                        thumbnail_url: format!("{UPLOADS}/{manga_id}/{file}.512.jpg"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    covers.sort_by(|a, b| {
        let ka = a.volume.as_deref().map(volume_sort_key).unwrap_or((2, 0.0));
        let kb = b.volume.as_deref().map(volume_sort_key).unwrap_or((2, 0.0));
        ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(covers)
}

/// Which chapters belong to which published volume.
///
/// Deliberately queried without a `translatedLanguage` filter. Volume tagging is
/// per-translation and crowd-sourced, so filtering to one language returns a
/// sparse and misleading map, while the unfiltered view reflects the actual
/// tankoubon structure.
pub fn volume_chapters(manga_id: &str) -> Result<Vec<VolumeChapters>> {
    let body = get_json(&format!("{API}/manga/{manga_id}/aggregate"), &[])?;

    let mut volumes: Vec<VolumeChapters> = body["volumes"]
        .as_object()
        .map(|map| {
            map.iter()
                .filter(|(name, _)| name.as_str() != "none")
                .map(|(name, value)| {
                    let mut chapters: Vec<String> = value["chapters"]
                        .as_object()
                        .map(|c| c.keys().cloned().collect())
                        .unwrap_or_default();
                    chapters.sort_by(|a, b| {
                        volume_sort_key(a)
                            .partial_cmp(&volume_sort_key(b))
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
                    VolumeChapters {
                        volume: name.clone(),
                        chapters,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    volumes.sort_by(|a, b| {
        volume_sort_key(&a.volume)
            .partial_cmp(&volume_sort_key(&b.volume))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(volumes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The shape MangaDex actually returns for a Japanese series: the canonical
    /// title is romanised Japanese and the English name lives in `altTitles`.
    fn ichi() -> Value {
        json!({
            "id": "dea77c2d-dbaa-434a-b0af-0c116642434c",
            "attributes": {
                "title": { "ja-ro": "Madan no Ichi" },
                "altTitles": [
                    { "ja": "魔男のイチ" },
                    { "en": "Ichi the Witch" },
                    { "hu": "Ichi, a boszorkány" }
                ],
                "description": { "en": "In this world, witches must hunt down their magic!" },
                "year": 2024,
                "status": "ongoing",
                "publicationDemographic": "shounen"
            },
            "relationships": [
                { "type": "author", "attributes": { "name": "Nishi Osamu " } },
                { "type": "artist", "attributes": { "name": "Usazaki Shiro" } },
                { "type": "cover_art", "attributes": { "fileName": "abc.jpg", "volume": "9" } }
            ]
        })
    }

    #[test]
    fn english_title_is_found_in_alt_titles() {
        let parsed = parse_series(&ichi()).unwrap();
        assert_eq!(parsed.title_english.as_deref(), Some("Ichi the Witch"));
        assert_eq!(parsed.title_romaji.as_deref(), Some("Madan no Ichi"));
        assert_eq!(parsed.title_native.as_deref(), Some("魔男のイチ"));
    }

    #[test]
    fn author_and_artist_come_from_relationships() {
        let parsed = parse_series(&ichi()).unwrap();
        assert_eq!(parsed.author.as_deref(), Some("Nishi Osamu"));
        assert_eq!(parsed.artist.as_deref(), Some("Usazaki Shiro"));
    }

    #[test]
    fn display_title_prefers_english() {
        assert_eq!(parse_series(&ichi()).unwrap().display_title(), "Ichi the Witch");
    }

    #[test]
    fn missing_languages_are_absent_rather_than_guessed() {
        let bare = json!({
            "id": "x",
            "attributes": { "title": { "en": "Solo Work" }, "altTitles": [] },
            "relationships": []
        });
        let parsed = parse_series(&bare).unwrap();
        assert_eq!(parsed.title_english.as_deref(), Some("Solo Work"));
        assert!(parsed.title_romaji.is_none());
        assert!(parsed.author.is_none());
    }

    #[test]
    fn entries_without_an_id_are_skipped() {
        assert!(parse_series(&json!({ "attributes": {} })).is_none());
    }
}
