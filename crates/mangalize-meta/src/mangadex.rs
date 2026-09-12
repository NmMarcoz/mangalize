//! MangaDex client.
//!
//! Responses are walked as untyped JSON rather than mapped to structs: the
//! shapes are deeply nested, heavily optional, and mostly discarded, so a full
//! typed mirror would be more code to maintain for no safety we actually use.

use anyhow::{bail, Context, Result};
use serde_json::Value;

use crate::{
    get_json, volume_sort_key, BrowsePage, BrowseQuery, ChapterRef, ContentRating, SeriesMatch,
    Sort, Source, Tag, VolumeChapters, VolumeCover,
};

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

/// Browse the catalogue.
///
/// The same `/manga` endpoint a search uses, with an ordering instead of (or as
/// well as) a title. That is what lets the panel open on something to look at
/// rather than an empty box.
pub fn browse(query: &BrowseQuery) -> Result<BrowsePage> {
    let mut params: Vec<(String, String)> = vec![
        ("limit".into(), query.limit.clamp(1, 100).to_string()),
        ("offset".into(), query.offset.to_string()),
        ("includes[]".into(), "author".into()),
        ("includes[]".into(), "artist".into()),
        ("includes[]".into(), "cover_art".into()),
    ];

    let title = query
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());

    // Relevance only means anything next to a search term; asking for it
    // without one returns the catalogue in no useful order at all.
    let sort = match (query.sort, title) {
        (Sort::Relevance, None) => Sort::Follows,
        (sort, _) => sort,
    };
    let direction = if query.descending { "desc" } else { "asc" };
    params.push((format!("order[{}]", sort.key()), direction.into()));

    if let Some(title) = title {
        params.push(("title".into(), title.to_string()));
    }

    // An empty selection means the user cleared every box, not that they want
    // whatever the API defaults to — which includes more than this app starts
    // with. Fall back to the conservative set instead.
    let ratings = if query.content_ratings.is_empty() {
        ContentRating::default_set()
    } else {
        query.content_ratings.clone()
    };
    for rating in ratings {
        params.push(("contentRating[]".into(), rating.key().into()));
    }

    for tag in &query.included_tags {
        params.push(("includedTags[]".into(), tag.clone()));
    }
    for tag in &query.excluded_tags {
        params.push(("excludedTags[]".into(), tag.clone()));
    }
    for status in &query.status {
        params.push(("status[]".into(), status.clone()));
    }
    for demographic in &query.demographic {
        params.push(("publicationDemographic[]".into(), demographic.clone()));
    }

    let borrowed: Vec<(&str, &str)> = params
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let body = get_json(&format!("{API}/manga"), &borrowed)?;

    Ok(BrowsePage {
        series: body["data"]
            .as_array()
            .map(|items| items.iter().filter_map(parse_series).collect())
            .unwrap_or_default(),
        total: body["total"].as_u64().unwrap_or(0) as u32,
        offset: body["offset"].as_u64().unwrap_or(0) as u32,
    })
}

/// Every tag a series can carry.
///
/// Small and effectively static, so the caller is expected to ask once and keep
/// the answer for the session rather than per keystroke.
pub fn tags() -> Result<Vec<Tag>> {
    let body = get_json(&format!("{API}/manga/tag"), &[])?;

    let mut tags: Vec<Tag> = body["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(Tag {
                        id: item["id"].as_str()?.to_string(),
                        // Tag names are localised; English is the only one the
                        // API reliably carries for all of them.
                        name: item["attributes"]["name"]["en"].as_str()?.to_string(),
                        group: item["attributes"]["group"]
                            .as_str()
                            .unwrap_or("other")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    tags.sort_by(|a, b| a.group.cmp(&b.group).then_with(|| a.name.cmp(&b.name)));
    Ok(tags)
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
                    // The id is the useful part and was previously thrown away:
                    // it is what `/at-home/server` needs to hand back real page
                    // URLs, which beats reading the site's markup outright.
                    let mut chapters: Vec<ChapterRef> = value["chapters"]
                        .as_object()
                        .map(|entries| {
                            entries
                                .iter()
                                .map(|(number, entry)| ChapterRef {
                                    number: number.clone(),
                                    id: entry["id"].as_str().map(String::from),
                                    unavailable: entry["isUnavailable"]
                                        .as_bool()
                                        .unwrap_or(false),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    chapters.sort_by(|a, b| {
                        volume_sort_key(&a.number)
                            .partial_cmp(&volume_sort_key(&b.number))
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

/// Page image URLs for a chapter, via the MangaDex@Home network.
///
/// The server handing out images is chosen per request and its address is only
/// valid for a short while, so this must be called immediately before
/// downloading rather than cached.
pub fn chapter_pages(chapter_id: &str) -> Result<Vec<String>> {
    let body = get_json(&format!("{API}/at-home/server/{chapter_id}"), &[])
        .with_context(|| format!("asking MangaDex for chapter {chapter_id}"))?;

    let base = body["baseUrl"]
        .as_str()
        .context("MangaDex did not return an image server")?;
    let hash = body["chapter"]["hash"].as_str().unwrap_or_default();
    let files: Vec<&str> = body["chapter"]["data"]
        .as_array()
        .map(|items| items.iter().filter_map(|f| f.as_str()).collect())
        .unwrap_or_default();

    // A chapter MangaDex indexes but does not host answers with an empty list
    // rather than an error, so the useful message has to be built here.
    if hash.is_empty() || files.is_empty() {
        bail!("{}", unhosted_reason(chapter_id));
    }

    Ok(files
        .into_iter()
        .map(|file| format!("{base}/data/{hash}/{file}"))
        .collect())
}

/// Whether a URL is served by the MangaDex@Home network.
///
/// Only those get reported. Cover art comes from `uploads.mangadex.org`, which
/// is MangaDex's own infrastructure and not part of the volunteer network.
pub fn is_at_home(url: &str) -> bool {
    url.contains(".mangadex.network")
}

/// Tell MangaDex how a page fetch from their network went.
///
/// The image servers are run by volunteers and MangaDex uses these reports to
/// find ones that are failing or serving corrupt data. Asking a free service to
/// stream every page of a chapter and declining to tell it whether the bytes
/// arrived is not a reasonable trade.
///
/// Deliberately silent and best-effort: this is a courtesy to them, and a failed
/// report must never interfere with the reading it describes.
pub fn report_at_home(url: &str, success: bool, cached: bool, bytes: usize, millis: u64) {
    if !is_at_home(url) {
        return;
    }

    let body = serde_json::json!({
        "url": url,
        "success": success,
        "cached": cached,
        "bytes": bytes,
        "duration": millis,
    });

    let _ = ureq::post(&format!("{API}/at-home/report"))
        .set("User-Agent", crate::USER_AGENT)
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(5))
        .send_json(body);
}

/// Explain an empty chapter by asking what the chapter itself says.
///
/// Worth the extra request: "no images" is baffling, whereas "MangaDex does not
/// host this one, the publisher does, here is where" is actionable.
fn unhosted_reason(chapter_id: &str) -> String {
    let external = get_json(&format!("{API}/chapter/{chapter_id}"), &[])
        .ok()
        .and_then(|body| {
            body["data"]["attributes"]["externalUrl"]
                .as_str()
                .map(String::from)
        });

    match external {
        Some(url) => format!(
            "MangaDex indexes this chapter but does not host its images — it is \
             officially licensed and published at {url}. Paste that page's URL \
             into the chapter's Get dialog instead."
        ),
        None => "MangaDex has no images for this chapter yet.".to_string(),
    }
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
    fn relevance_without_a_search_term_falls_back_to_something_ordered() {
        // Asking the API to order by relevance with nothing to be relevant to
        // returns the catalogue arbitrarily, which looks broken.
        let query = BrowseQuery {
            title: None,
            sort: Sort::Relevance,
            ..BrowseQuery::default()
        };
        let effective = match (query.sort, query.title.as_deref()) {
            (Sort::Relevance, None) => Sort::Follows,
            (sort, _) => sort,
        };
        assert_eq!(effective, Sort::Follows);
    }

    #[test]
    fn a_fresh_browse_does_not_open_on_explicit_material() {
        let defaults = BrowseQuery::default();
        assert_eq!(
            defaults.content_ratings,
            vec![ContentRating::Safe, ContentRating::Suggestive]
        );
        assert!(!defaults.content_ratings.contains(&ContentRating::Pornographic));
    }

    #[test]
    fn every_ordering_has_an_api_name() {
        for sort in [
            Sort::LatestUpload,
            Sort::Follows,
            Sort::Rating,
            Sort::RecentlyAdded,
            Sort::Title,
            Sort::Relevance,
        ] {
            assert!(!sort.key().is_empty());
        }
        assert_eq!(Sort::Follows.key(), "followedCount");
        assert_eq!(Sort::LatestUpload.key(), "latestUploadedChapter");
    }

    #[test]
    fn entries_without_an_id_are_skipped() {
        assert!(parse_series(&json!({ "attributes": {} })).is_none());
    }
}
