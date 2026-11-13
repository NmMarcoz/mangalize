//! MangaDex as a [`Source`], delegating to the existing `leaf-meta` client.

use anyhow::Result;
use leaf_meta::{BrowseQuery, SeriesMatch, Sort};

use crate::types::{MangaDetails, MangaSummary, MangasPage, Source, SourceInfo};

/// The id `series.source` stores for a MangaDex-backed library entry.
pub const ID: &str = "leaf.mangadex";

pub struct MangaDexSource {
    info: SourceInfo,
}

impl Default for MangaDexSource {
    fn default() -> Self {
        Self {
            info: SourceInfo {
                id: ID.to_string(),
                name: "MangaDex".to_string(),
                // Crowd-translated rather than one fixed language; `volumes`
                // takes its own `language` argument per call instead.
                lang: "multi".to_string(),
                base_url: "https://mangadex.org".to_string(),
            },
        }
    }
}

impl Source for MangaDexSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn popular(&self, page: u32) -> Result<MangasPage> {
        browse(BrowseQuery {
            sort: Sort::Follows,
            ..paged(page)
        })
    }

    fn latest(&self, page: u32) -> Result<MangasPage> {
        browse(BrowseQuery {
            sort: Sort::LatestUpload,
            ..paged(page)
        })
    }

    fn search(&self, query: &str, page: u32) -> Result<MangasPage> {
        browse(BrowseQuery {
            title: Some(query.to_string()),
            sort: Sort::Relevance,
            ..paged(page)
        })
    }

    fn manga_details(&self, id: &str) -> Result<MangaDetails> {
        Ok(into_details(leaf_meta::mangadex::manga(id)?))
    }

    fn volumes(
        &self,
        id: &str,
        language: Option<&str>,
    ) -> Result<Vec<leaf_meta::VolumeChapters>> {
        leaf_meta::volume_chapters_in(leaf_meta::Source::MangaDex, id, language)
    }

    fn covers(&self, id: &str) -> Result<Vec<leaf_meta::VolumeCover>> {
        leaf_meta::volume_covers(leaf_meta::Source::MangaDex, id)
    }

    fn page_list(&self, chapter_id: &str) -> Result<Vec<String>> {
        leaf_meta::chapter_pages(leaf_meta::Source::MangaDex, chapter_id)
    }
}

/// A default [`BrowseQuery`] for page `page`, using MangaDex's own default
/// page size (32) as the step.
fn paged(page: u32) -> BrowseQuery {
    const PAGE_SIZE: u32 = 32;
    BrowseQuery {
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        ..BrowseQuery::default()
    }
}

fn browse(query: BrowseQuery) -> Result<MangasPage> {
    let page = leaf_meta::browse(&query)?;
    Ok(MangasPage {
        has_next_page: page.offset + (page.series.len() as u32) < page.total,
        manga: page.series.into_iter().map(into_summary).collect(),
    })
}

fn into_summary(m: SeriesMatch) -> MangaSummary {
    MangaSummary {
        title: m.display_title().to_string(),
        cover_url: m.thumbnail_url.clone(),
        id: m.id,
    }
}

fn into_details(m: SeriesMatch) -> MangaDetails {
    MangaDetails {
        title: m.display_title().to_string(),
        title_romaji: m.title_romaji,
        title_native: m.title_native,
        author: m.author,
        artist: m.artist,
        description: m.description,
        tags: m.tags.into_iter().map(|t| t.name).collect(),
        content_rating: m.content_rating,
        available_languages: m.available_languages,
        cover_url: m.thumbnail_url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_id_matches_the_public_constant() {
        assert_eq!(MangaDexSource::default().info().id, ID);
    }

    #[test]
    fn paged_steps_by_the_default_page_size() {
        assert_eq!(paged(0).offset, 0);
        assert_eq!(paged(2).offset, 64);
    }
}
