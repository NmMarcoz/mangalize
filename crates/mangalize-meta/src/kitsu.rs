//! Kitsu client, used when MangaDex cannot be reached.
//!
//! Kitsu exposes English titles directly, which MangaDex does not, but has only
//! a single series poster and no volume-level data.

use anyhow::Result;
use serde_json::Value;

use crate::{get_json, SeriesMatch, Source, VolumeCover};

const API: &str = "https://kitsu.io/api/edge";

pub fn search(query: &str, limit: u32) -> Result<Vec<SeriesMatch>> {
    let limit = limit.clamp(1, 20).to_string();
    let body = get_json(
        &format!("{API}/manga"),
        &[("filter[text]", query), ("page[limit]", &limit)],
    )?;

    Ok(body["data"]
        .as_array()
        .map(|items| items.iter().filter_map(parse_series).collect())
        .unwrap_or_default())
}

fn parse_series(item: &Value) -> Option<SeriesMatch> {
    let id = item["id"].as_str()?.to_string();
    let attrs = &item["attributes"];
    let titles = &attrs["titles"];

    Some(SeriesMatch {
        source: Source::Kitsu,
        title_english: titles["en"].as_str().map(String::from),
        title_romaji: titles["en_jp"].as_str().map(String::from),
        title_native: titles["ja_jp"].as_str().map(String::from),
        // Kitsu models staff as a separate relationship requiring another
        // round trip; not worth it for a fallback source.
        author: None,
        artist: None,
        description: attrs["synopsis"].as_str().map(String::from),
        year: attrs["startDate"]
            .as_str()
            .and_then(|d| d.get(..4))
            .and_then(|y| y.parse().ok()),
        status: attrs["status"].as_str().map(String::from),
        demographic: None,
        thumbnail_url: attrs["posterImage"]["small"]
            .as_str()
            .or_else(|| attrs["posterImage"]["original"].as_str())
            .map(String::from),
        site_url: attrs["slug"]
            .as_str()
            .map(|s| format!("https://kitsu.app/manga/{s}")),
        id,
    })
}

/// The series poster, presented as a single untagged cover.
pub fn poster(id: &str) -> Result<Option<VolumeCover>> {
    let body = get_json(&format!("{API}/manga/{id}"), &[])?;
    let poster = &body["data"]["attributes"]["posterImage"];

    let full = poster["original"].as_str().or_else(|| poster["large"].as_str());
    Ok(full.map(|url| VolumeCover {
        volume: None,
        url: url.to_string(),
        thumbnail_url: poster["small"].as_str().unwrap_or(url).to_string(),
    }))
}
