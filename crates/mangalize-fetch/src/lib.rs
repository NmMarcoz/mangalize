//! Pulling a chapter's images off a page the user pasted.
//!
//! Two halves, both driven by a URL the user supplies:
//!
//! - [`extract`] reads the page's markup and reports the image URLs in it.
//! - [`download`] measures those candidates and saves the chosen ones.
//!
//! Nothing here is site-specific. It is the same job an image-extractor page
//! does — look at a document, list its images, fetch them — done locally so the
//! result can go straight into a library instead of a browser download folder.
//!
//! Pages that assemble themselves in JavaScript are the one case static reading
//! cannot cover; for those the app renders the URL and hands the resulting list
//! of image URLs back to [`measure`], which is why measurement is a separate
//! step from extraction.

pub mod data_uri;
pub mod download;
pub mod extract;
pub mod series;
pub mod url;

use std::time::Duration;

use anyhow::{Context, Result};
use mangalize_core::sieve::{self, Verdict};
use serde::{Deserialize, Serialize};

/// Identify the app rather than impersonating a browser.
pub const USER_AGENT: &str = concat!("mangalize/", env!("CARGO_PKG_VERSION"));

const TIMEOUT: Duration = Duration::from_secs(30);

/// Refuse anything big enough to mean we followed the wrong link.
const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;

/// An HTML page is read whole, so it needs its own, much smaller, ceiling.
const MAX_PAGE_BYTES: u64 = 8 * 1024 * 1024;

/// Callback invoked as `(done, total)` while a batch of URLs is worked through.
pub type Progress<'a> = dyn FnMut(usize, usize) + 'a;

/// One image the picker can offer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub url: String,
    pub width: u32,
    pub height: u32,
    /// Full size when the server reported one, else 0.
    pub bytes: u64,
    /// What the size sieve made of it.
    pub verdict: Verdict,
    /// Whether the picker should start with this one ticked.
    pub selected: bool,
    /// Why it could not be measured, when it could not.
    pub error: Option<String>,
}

/// Everything found on one chapter page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extraction {
    /// The page the candidates came from; also the `Referer` for fetching them.
    pub page_url: String,
    pub candidates: Vec<Candidate>,
}

/// Fetch a page and list the images in its markup, measured and pre-judged.
///
/// An empty result is not an error: it is the signal that the page builds itself
/// in JavaScript and should be rendered instead.
pub fn extract_page(page_url: &str, progress: &mut Progress) -> Result<Extraction> {
    let html = fetch_html(page_url)?;
    let urls = extract::image_urls(page_url, &html);
    Ok(Extraction {
        page_url: page_url.to_string(),
        candidates: measure(&urls, Some(page_url), progress),
    })
}

/// Measure a list of image URLs and decide which ones look like pages.
///
/// Split out from extraction so that URLs gathered by rendering the page go
/// through exactly the same judgement as URLs read from its markup.
pub fn measure(urls: &[String], referer: Option<&str>, progress: &mut Progress) -> Vec<Candidate> {
    let probes = download::probe_all(urls, referer, progress);

    let sizes: Vec<(u32, u32)> = probes.iter().map(|p| (p.width, p.height)).collect();
    let verdicts = sieve::judge(&sizes);

    urls.iter()
        .zip(probes)
        .zip(verdicts)
        .map(|((url, probe), verdict)| Candidate {
            url: url.clone(),
            width: probe.width,
            height: probe.height,
            bytes: probe.bytes,
            verdict,
            // Anything that could not be measured starts unticked: it is more
            // likely a dead link than a page, and it is one click to change.
            selected: probe.error.is_none() && verdict != Verdict::OffSize,
            error: probe.error,
        })
        .collect()
}

/// Download the chosen candidates into `dest`, named `0001…` in the order given.
pub fn download_pages(
    urls: &[String],
    dest: &std::path::Path,
    referer: Option<&str>,
    progress: &mut Progress,
) -> Result<Vec<std::path::PathBuf>> {
    download::download_all(urls, dest, referer, progress)
}

/* ------------------------------------------------------------ batch planning */

/// Where a chapter URL came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Found {
    /// The page linked it, so it certainly exists.
    Linked,
    /// Constructed from the URL pattern and then confirmed to load.
    Guessed,
}

/// One chapter a batch would fetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchItem {
    pub number: String,
    pub url: String,
    pub found: Found,
}

/// What a batch download would do, for the user to confirm.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPlan {
    /// The URL shape that was recognised, for display, e.g. `…/x-chapter-{n}/`.
    pub pattern: Option<String>,
    pub items: Vec<BatchItem>,
    /// Wanted chapters no URL could be found for.
    pub unresolved: Vec<String>,
}

/// Work out how to reach each of `wanted` from one URL the user supplied.
///
/// The page is read for links first, because a link the site published is
/// evidence and a constructed URL is only a guess. Guesses fill the gaps and are
/// each fetched once to confirm they load, so the user is never shown a plan
/// that is mostly 404s.
///
/// `wanted` is normally the library's list of missing chapters, which is what
/// makes this bounded: there is no blind crawling outward, only a check for the
/// specific chapters that are known to exist and known to be absent.
pub fn plan_batch(
    page_url: &str,
    wanted: &[String],
    progress: &mut Progress,
) -> Result<BatchPlan> {
    let html = fetch_html(page_url)?;
    let links = series::chapter_links(page_url, &html);

    // A template from the URL the user pasted describes the site better than one
    // inferred from a link, because it is the page they know works.
    let template = series::split(page_url)
        .map(|(t, _)| t)
        .or_else(|| links.first().and_then(|l| series::split(&l.url).map(|(t, _)| t)));

    let by_number: std::collections::HashMap<&str, &series::ChapterLink> =
        links.iter().map(|l| (l.number.as_str(), l)).collect();

    let mut items = Vec::new();
    let mut unresolved = Vec::new();
    let mut guesses = Vec::new();

    for number in wanted {
        let key = series::normalise(number);
        if let Some(link) = by_number.get(key.as_str()) {
            items.push(BatchItem {
                number: number.clone(),
                url: link.url.clone(),
                found: Found::Linked,
            });
        } else if let Some(template) = &template {
            guesses.push((number.clone(), template.apply(&key)));
        } else {
            unresolved.push(number.clone());
        }
    }

    // Confirm the guesses concurrently; this is the slow part of planning.
    let urls: Vec<String> = guesses.iter().map(|(_, url)| url.clone()).collect();
    let alive = download::reachable(&urls, Some(page_url), progress);

    for ((number, url), ok) in guesses.into_iter().zip(alive) {
        if ok {
            items.push(BatchItem { number, url, found: Found::Guessed });
        } else {
            unresolved.push(number);
        }
    }

    items.sort_by(|a, b| {
        let ka = a.number.parse::<f64>().unwrap_or(f64::MAX);
        let kb = b.number.parse::<f64>().unwrap_or(f64::MAX);
        ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(BatchPlan {
        pattern: template.map(|t| t.pattern()),
        items,
        unresolved,
    })
}

/// The pages one chapter offers, already sieved down to what looks like a page.
///
/// Used by the batch path, where there is no picker: the size sieve is doing the
/// job the user would otherwise do by eye.
pub fn chapter_pages(page_url: &str, progress: &mut Progress) -> Result<Vec<String>> {
    let found = extract_page(page_url, progress)?;
    Ok(found
        .candidates
        .into_iter()
        .filter(|c| c.selected)
        .map(|c| c.url)
        .collect())
}

/// Fetch a page's markup.
fn fetch_html(page_url: &str) -> Result<String> {
    let response = ureq::get(page_url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "text/html,application/xhtml+xml")
        .timeout(TIMEOUT)
        .call()
        .with_context(|| format!("fetching {page_url}"))?;

    let mut body = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(response.into_reader(), MAX_PAGE_BYTES),
        &mut body,
    )?;

    // Reader sites are not reliably valid UTF-8; a lossy read still finds every
    // URL, which is all this is for.
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measuring_nothing_is_not_an_error() {
        assert!(measure(&[], None, &mut |_, _| {}).is_empty());
    }
}
