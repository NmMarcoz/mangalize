//! Working out where a series' other chapters live, from one URL.
//!
//! Chapter URLs on a reader site are almost always the same string with one
//! number changed. That regularity is the whole basis of this module: find the
//! number in the URL you were given, and you can both recognise sibling chapter
//! links on the page and construct the URL of a chapter you have not seen.
//!
//! Nothing here is site-specific, and nothing here guesses at content. A
//! constructed URL is only ever a *candidate* — it is fetched and checked before
//! being offered, and the user confirms the list before anything downloads.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::url::path_bounds;
use crate::{extract, url};

/// Markers that introduce a chapter number in a path, longest first so `chapter`
/// is preferred over the `ch` inside it.
const MARKERS: &[&str] = &["chapter", "chap", "cap", "ch"];

/// A chapter URL with the number factored out.
///
/// `prefix` and `suffix` are the parts of the URL either side of the number, so
/// rebuilding it for another chapter is a concatenation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UrlTemplate {
    pub prefix: String,
    pub suffix: String,
    /// What separated a decimal chapter's parts, e.g. `-` in `chapter-7-5`.
    /// Reproduced verbatim so constructed URLs look like the site's own.
    pub decimal: char,
}

impl UrlTemplate {
    /// The URL this template gives for `number`, e.g. `"7"` or `"7.5"`.
    pub fn apply(&self, number: &str) -> String {
        let rendered = match number.split_once('.') {
            Some((whole, fraction)) => format!("{whole}{}{fraction}", self.decimal),
            None => number.to_string(),
        };
        format!("{}{rendered}{}", self.prefix, self.suffix)
    }

    /// A display form, for telling the user what pattern was recognised.
    pub fn pattern(&self) -> String {
        format!("{}{{n}}{}", self.prefix, self.suffix)
    }
}

/// A chapter we know how to reach.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterLink {
    /// Normalised chapter number, e.g. `"7"` or `"7.5"`.
    pub number: String,
    pub url: String,
}

/// Split a chapter URL into a template plus the number it currently holds.
///
/// Only the path is considered: a `?page=2` is not a chapter number, and
/// matching it would produce nonsense URLs for every other chapter.
pub fn split(url_str: &str) -> Option<(UrlTemplate, String)> {
    let (path_start, path_end) = path_bounds(url_str);
    let path = &url_str[path_start..path_end];
    let (offset, len, number, decimal) = locate_number(path)?;

    Some((
        UrlTemplate {
            prefix: url_str[..path_start + offset].to_string(),
            suffix: url_str[path_start + offset + len..].to_string(),
            decimal,
        },
        number,
    ))
}

/// Find the chapter number inside a path.
///
/// Returns its byte offset, byte length, normalised value, and the separator a
/// decimal used. A number introduced by a `chapter`-like marker wins; failing
/// that, the last run of digits in the path is taken, which is what an URL like
/// `/read/one-piece/1105` amounts to.
fn locate_number(path: &str) -> Option<(usize, usize, String, char)> {
    let lower = path.to_ascii_lowercase();

    for marker in MARKERS {
        let mut from = 0;
        while let Some(rel) = lower[from..].find(marker) {
            let at = from + rel;
            from = at + marker.len();

            // Must start a word, so `chapter` is not found inside `subchapter`.
            let starts_word = at == 0 || !lower.as_bytes()[at - 1].is_ascii_alphanumeric();
            if !starts_word {
                continue;
            }

            // Skip whatever separates the marker from its number.
            let mut i = from;
            while i < lower.len() && matches!(lower.as_bytes()[i], b'-' | b'_' | b'/' | b'.' | b' ')
            {
                i += 1;
            }
            if let Some(found) = read_number(&lower, i) {
                return Some(found);
            }
        }
    }

    // No marker: fall back to the last digit run in the path.
    let mut last = None;
    let mut i = 0;
    while i < lower.len() {
        if lower.as_bytes()[i].is_ascii_digit() {
            let found = read_number(&lower, i)?;
            i = found.0 + found.1;
            last = Some(found);
        } else {
            i += 1;
        }
    }
    last
}

/// Read a number run at `start`, including a decimal part when one follows.
///
/// `chapter-7-5` means chapter 7.5 on a great many sites, so a second group
/// joined by `-` or `.` is treated as the fraction.
fn read_number(s: &str, start: usize) -> Option<(usize, usize, String, char)> {
    let bytes = s.as_bytes();
    if start >= bytes.len() || !bytes[start].is_ascii_digit() {
        return None;
    }

    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    let whole = &s[start..end];

    // A fraction only counts when digits actually follow the separator.
    if end < bytes.len() && matches!(bytes[end], b'-' | b'.') {
        let sep = bytes[end] as char;
        let mut fraction_end = end + 1;
        while fraction_end < bytes.len() && bytes[fraction_end].is_ascii_digit() {
            fraction_end += 1;
        }
        if fraction_end > end + 1 {
            let fraction = &s[end + 1..fraction_end];
            // Guard against reading a date or an id as a chapter fraction.
            if fraction.len() <= 2 {
                return Some((
                    start,
                    fraction_end - start,
                    normalise(&format!("{whole}.{fraction}")),
                    sep,
                ));
            }
        }
    }

    Some((start, end - start, normalise(whole), '.'))
}

/// Canonical form of a chapter number, so `"07"`, `"7"` and `"7.0"` all match.
pub fn normalise(number: &str) -> String {
    match number.trim().parse::<f64>() {
        Ok(n) if n.is_finite() && n >= 0.0 => {
            if n.fract() == 0.0 {
                format!("{}", n as u64)
            } else {
                // Chapter fractions are one or two places in practice.
                format!("{n}")
            }
        }
        _ => number.trim().to_string(),
    }
}

/// The chapter links a page offers, in numeric order.
///
/// A chapter page usually links its neighbours, and a series index page links
/// everything; both are read the same way. Links are kept only when they share
/// the *dominant* URL shape on the page, which is what separates the chapter
/// list from navigation, related-series boxes and adverts.
pub fn chapter_links(page_url: &str, html: &str) -> Vec<ChapterLink> {
    let host = url::origin_of(page_url);

    let mut by_shape: HashMap<String, Vec<ChapterLink>> = HashMap::new();

    for tag in extract::tags(html) {
        if tag.name != "a" {
            continue;
        }
        let Some(href) = tag.attr("href") else { continue };
        let Some(resolved) = url::resolve(page_url, href) else { continue };

        // Another site's chapter list is not this series'.
        if url::origin_of(&resolved) != host {
            continue;
        }
        let Some((template, number)) = split(&resolved) else { continue };

        by_shape
            .entry(template.pattern())
            .or_default()
            .push(ChapterLink { number, url: resolved });
    }

    // The shape with the most links is the chapter list. Ties break on the
    // larger set, then arbitrarily but deterministically.
    let mut shapes: Vec<(String, Vec<ChapterLink>)> = by_shape.into_iter().collect();
    shapes.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));

    let Some((_, links)) = shapes.into_iter().next() else {
        return Vec::new();
    };
    dedupe_and_sort(links)
}

fn dedupe_and_sort(links: Vec<ChapterLink>) -> Vec<ChapterLink> {
    let mut seen = std::collections::HashSet::new();
    let mut unique: Vec<ChapterLink> = links
        .into_iter()
        .filter(|link| seen.insert(link.number.clone()))
        .collect();

    unique.sort_by(|a, b| {
        let ka = a.number.parse::<f64>().ok();
        let kb = b.number.parse::<f64>().ok();
        match (ka, kb) {
            (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
            // Unparseable labels sort last, as everywhere else.
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.number.cmp(&b.number),
        }
    });
    unique
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chapter_url_splits_into_a_template_and_a_number() {
        let (template, number) =
            split("https://example.test/manga/ichi-the-witch-chapter-1/").unwrap();
        assert_eq!(number, "1");
        assert_eq!(
            template.apply("42"),
            "https://example.test/manga/ichi-the-witch-chapter-42/"
        );
    }

    #[test]
    fn digits_in_the_series_name_do_not_win_over_the_marker() {
        let (template, number) = split("https://example.test/manga/86-chapter-3/").unwrap();
        assert_eq!(number, "3");
        assert_eq!(template.apply("4"), "https://example.test/manga/86-chapter-4/");
    }

    #[test]
    fn a_bare_numeric_url_falls_back_to_the_last_digit_run() {
        let (template, number) = split("https://example.test/read/one-piece/1105").unwrap();
        assert_eq!(number, "1105");
        assert_eq!(template.apply("1106"), "https://example.test/read/one-piece/1106");
    }

    #[test]
    fn decimal_chapters_keep_the_sites_own_separator() {
        let (template, number) = split("https://example.test/m/x-chapter-7-5/").unwrap();
        assert_eq!(number, "7.5");
        assert_eq!(template.apply("8.5"), "https://example.test/m/x-chapter-8-5/");
        assert_eq!(template.apply("9"), "https://example.test/m/x-chapter-9/");
    }

    #[test]
    fn a_query_string_is_never_mistaken_for_the_chapter() {
        let (template, number) =
            split("https://example.test/manga/x-chapter-3/?page=2").unwrap();
        assert_eq!(number, "3");
        assert_eq!(template.apply("4"), "https://example.test/manga/x-chapter-4/?page=2");
    }

    #[test]
    fn a_url_with_no_number_has_no_template() {
        assert!(split("https://example.test/manga/ichi-the-witch/").is_none());
    }

    #[test]
    fn numbers_normalise_so_padding_and_trailing_zeros_match() {
        assert_eq!(normalise("07"), "7");
        assert_eq!(normalise("7.0"), "7");
        assert_eq!(normalise("7.50"), "7.5");
        assert_eq!(normalise("Oneshot"), "Oneshot");
    }

    #[test]
    fn an_index_page_yields_every_chapter_it_lists() {
        let html = r#"
            <a href="/manga/x-chapter-1/">Chapter 1</a>
            <a href="/manga/x-chapter-2/">Chapter 2</a>
            <a href="/manga/x-chapter-10/">Chapter 10</a>
        "#;
        let links = chapter_links("https://example.test/manga/x/", html);
        let numbers: Vec<&str> = links.iter().map(|l| l.number.as_str()).collect();
        // Numeric order, not the lexicographic order of the markup.
        assert_eq!(numbers, ["1", "2", "10"]);
    }

    #[test]
    fn navigation_and_adverts_lose_to_the_dominant_chapter_shape() {
        let html = r#"
            <a href="/manga/x-chapter-1/">1</a>
            <a href="/manga/x-chapter-2/">2</a>
            <a href="/manga/x-chapter-3/">3</a>
            <a href="/other/promo-2024/">A promo</a>
            <a href="https://elsewhere.test/manga/y-chapter-9/">Another site</a>
        "#;
        let links = chapter_links("https://example.test/manga/x/", html);
        assert_eq!(links.len(), 3);
        assert!(links.iter().all(|l| l.url.contains("/manga/x-chapter-")));
    }

    #[test]
    fn the_same_chapter_linked_twice_is_listed_once() {
        let html = r#"
            <a href="/manga/x-chapter-1/">Read</a>
            <a href="/manga/x-chapter-1/">Chapter 1</a>
            <a href="/manga/x-chapter-2/">Next</a>
        "#;
        assert_eq!(chapter_links("https://example.test/manga/x/", html).len(), 2);
    }

    #[test]
    fn a_page_with_no_chapter_links_yields_nothing() {
        assert!(chapter_links("https://example.test/", "<p>Hello</p>").is_empty());
    }
}
