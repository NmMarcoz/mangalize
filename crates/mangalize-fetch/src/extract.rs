//! Finding the image URLs on a chapter page.
//!
//! This is the static half of extraction: fetch the HTML and read it. It is
//! fast, testable offline, and works on any page that ships its images in the
//! markup. Pages that build themselves in JavaScript return nothing useful here
//! and are handled by rendering them instead — see the harvest path in the app.
//!
//! The markup is scanned for attributes rather than parsed into a DOM. Reader
//! pages are frequently malformed in ways that upset a real parser, and every
//! question asked here ("what is this tag's `src`?") is answerable from the tag
//! text alone.

use std::collections::HashSet;

use crate::url;

/// Attributes that carry an image URL. `src` is last so that a lazy-loading
/// placeholder never wins over the real image it is standing in for.
const IMAGE_ATTRS: &[&str] = &[
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-lazy",
    "data-url",
    "data-image",
    "src",
];

/// Extensions that are images but never manga pages.
const NOT_A_PAGE: &[&str] = &["svg", "gif", "ico", "bmp"];

/// Image URLs found on `html`, in document order.
///
/// Document order is the page order on essentially every reader: the images are
/// laid out in the order they are meant to be read. Sorting by filename instead
/// would break the many sites that serve opaque or hashed image names.
pub fn image_urls(base: &str, html: &str) -> Vec<String> {
    let base = base_href(base, html);
    let mut found = Vec::new();
    let mut seen = HashSet::new();

    let mut push = |reference: &str| {
        if let Some(resolved) = url::resolve(&base, reference) {
            if is_page_candidate(&resolved) && seen.insert(resolved.clone()) {
                found.push(resolved);
            }
        }
    };

    for tag in tags(html) {
        match tag.name.as_str() {
            "img" | "source" => {
                for attr in IMAGE_ATTRS {
                    if let Some(value) = tag.attr(attr) {
                        push(value);
                        break;
                    }
                }
                // A `srcset` is a comma-separated list of "url descriptor" pairs.
                for candidate in [tag.attr("srcset"), tag.attr("data-srcset")]
                    .into_iter()
                    .flatten()
                {
                    for entry in candidate.split(',') {
                        if let Some(first) = entry.split_whitespace().next() {
                            push(first);
                        }
                    }
                }
            }
            // Thumbnail grids commonly link the full-size image.
            "a" => {
                if let Some(href) = tag.attr("href") {
                    if url::extension_of(href).is_some() {
                        push(href);
                    }
                }
            }
            _ => {}
        }
    }

    // Reader sites that hand the page list to a script still have to put the
    // URLs in the document somewhere. Scanning script bodies for quoted image
    // URLs catches those without needing to run anything.
    for script in script_bodies(html) {
        for reference in quoted_image_urls(script) {
            push(&reference);
        }
    }

    found
}

/// Whether a resolved URL is worth offering as a page.
fn is_page_candidate(url: &str) -> bool {
    match url::extension_of(url) {
        Some(ext) => !NOT_A_PAGE.contains(&ext.as_str()),
        // No extension at all is common for CDN-served pages, so it is not
        // disqualifying; the size probe decides.
        None => true,
    }
}

/// The effective base URL, honouring a `<base href>` when the page declares one.
fn base_href(page: &str, html: &str) -> String {
    tags(html)
        .find(|t| t.name == "base")
        .and_then(|t| t.attr("href").and_then(|h| url::resolve(page, h)))
        .unwrap_or_else(|| page.to_string())
}

/// A start tag and its raw attribute text.
pub(crate) struct Tag {
    pub(crate) name: String,
    body: String,
}

impl Tag {
    /// Attribute value by lowercase name. Quoted and unquoted forms both work.
    pub(crate) fn attr(&self, name: &str) -> Option<&str> {
        let body = self.body.as_str();
        let lower = body.to_ascii_lowercase();
        let mut from = 0;

        while let Some(rel) = lower[from..].find(name) {
            let at = from + rel;
            from = at + name.len();

            // Must start a word and be followed by `=`, so `src` does not match
            // inside `data-src`.
            let before_ok = at == 0
                || !matches!(lower.as_bytes()[at - 1], b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_');
            let rest = lower[from..].trim_start();
            if !before_ok || !rest.starts_with('=') {
                continue;
            }

            let eq = from + lower[from..].find('=')?;
            let value = body[eq + 1..].trim_start();
            return Some(match value.chars().next() {
                Some(q @ ('"' | '\'')) => {
                    let inner = &value[1..];
                    &inner[..inner.find(q).unwrap_or(inner.len())]
                }
                _ => value.split_whitespace().next().unwrap_or(""),
            });
        }
        None
    }
}

/// Walk the start tags of a document.
///
/// Quotes are tracked so a `>` inside an attribute value does not end the tag
/// early, which is how naive scanners truncate URLs containing one.
pub(crate) fn tags(html: &str) -> impl Iterator<Item = Tag> + '_ {
    let bytes = html.as_bytes();
    let mut i = 0;

    std::iter::from_fn(move || {
        while i < bytes.len() {
            if bytes[i] != b'<' {
                i += 1;
                continue;
            }
            let start = i + 1;
            if start >= bytes.len() || !bytes[start].is_ascii_alphabetic() {
                i += 1;
                continue;
            }

            let name_end = start
                + bytes[start..]
                    .iter()
                    .position(|b| !b.is_ascii_alphanumeric())
                    .unwrap_or(bytes.len() - start);

            let mut j = name_end;
            let mut quote: Option<u8> = None;
            while j < bytes.len() {
                match (quote, bytes[j]) {
                    (Some(q), b) if b == q => quote = None,
                    (Some(_), _) => {}
                    (None, b @ (b'"' | b'\'')) => quote = Some(b),
                    (None, b'>') => break,
                    (None, _) => {}
                }
                j += 1;
            }

            let name = html[start..name_end].to_ascii_lowercase();
            let body = html[name_end..j.min(html.len())].to_string();
            i = j + 1;
            return Some(Tag { name, body });
        }
        None
    })
}

/// The text inside every `<script>` element.
fn script_bodies(html: &str) -> Vec<&str> {
    let lower = html.to_ascii_lowercase();
    let mut bodies = Vec::new();
    let mut from = 0;

    while let Some(rel) = lower[from..].find("<script") {
        let open = from + rel;
        let Some(body_start) = lower[open..].find('>').map(|i| open + i + 1) else {
            break;
        };
        let end = lower[body_start..]
            .find("</script")
            .map(|i| body_start + i)
            .unwrap_or(lower.len());
        bodies.push(&html[body_start..end]);
        from = end + 1;
    }
    bodies
}

/// Absolute image URLs appearing inside quotes in a script body.
///
/// JSON embedded in HTML escapes its slashes (`https:\/\/…`), so those are
/// unescaped rather than skipped.
fn quoted_image_urls(script: &str) -> Vec<String> {
    let mut found = Vec::new();

    for chunk in script.split(['"', '\'']) {
        let candidate = chunk.replace("\\/", "/");
        if !candidate.starts_with("http://") && !candidate.starts_with("https://") {
            continue;
        }
        if candidate.contains(char::is_whitespace) {
            continue;
        }
        if matches!(
            url::extension_of(&candidate).as_deref(),
            Some("jpg" | "jpeg" | "png" | "webp" | "avif")
        ) {
            found.push(candidate);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "https://example.test/manga/ichi/ch-7";

    #[test]
    fn plain_img_tags_are_found_in_document_order() {
        let html = r#"<img src="02.jpg"><img src="01.jpg">"#;
        assert_eq!(
            image_urls(PAGE, html),
            [
                "https://example.test/manga/ichi/02.jpg",
                "https://example.test/manga/ichi/01.jpg",
            ]
        );
    }

    #[test]
    fn a_lazy_loading_placeholder_loses_to_the_real_image() {
        let html = r#"<img src="/spinner.png" data-src="/pages/01.jpg">"#;
        assert_eq!(image_urls(PAGE, html), ["https://example.test/pages/01.jpg"]);
    }

    #[test]
    fn srcset_entries_are_unpacked() {
        let html = r#"<img srcset="/a.jpg 1x, /b.jpg 2x">"#;
        assert_eq!(
            image_urls(PAGE, html),
            ["https://example.test/a.jpg", "https://example.test/b.jpg"]
        );
    }

    #[test]
    fn site_furniture_formats_are_dropped() {
        let html = r#"<img src="/close.svg"><img src="/pixel.gif"><img src="/01.jpg">"#;
        assert_eq!(image_urls(PAGE, html), ["https://example.test/01.jpg"]);
    }

    #[test]
    fn the_same_image_twice_is_offered_once() {
        let html = r#"<img src="/01.jpg"><img data-src="/01.jpg">"#;
        assert_eq!(image_urls(PAGE, html), ["https://example.test/01.jpg"]);
    }

    #[test]
    fn a_base_href_changes_what_relative_means() {
        let html = r#"<base href="https://cdn.test/x/"><img src="01.jpg">"#;
        assert_eq!(image_urls(PAGE, html), ["https://cdn.test/x/01.jpg"]);
    }

    #[test]
    fn page_lists_embedded_in_scripts_are_recovered() {
        let html = r#"<script>var pages = ["https:\/\/cdn.test\/1.jpg","https:\/\/cdn.test\/2.jpg"];</script>"#;
        assert_eq!(
            image_urls(PAGE, html),
            ["https://cdn.test/1.jpg", "https://cdn.test/2.jpg"]
        );
    }

    #[test]
    fn a_greater_than_inside_an_attribute_does_not_truncate_the_url() {
        let html = r#"<img alt="a > b" src="/01.jpg">"#;
        assert_eq!(image_urls(PAGE, html), ["https://example.test/01.jpg"]);
    }

    #[test]
    fn unquoted_attributes_still_parse() {
        let html = r#"<img src=/01.jpg width=800>"#;
        assert_eq!(image_urls(PAGE, html), ["https://example.test/01.jpg"]);
    }

    #[test]
    fn thumbnail_links_to_full_size_images_are_offered() {
        let html = r#"<a href="/full/01.jpg"><img src="/thumb/01.jpg"></a>"#;
        let found = image_urls(PAGE, html);
        assert!(found.contains(&"https://example.test/full/01.jpg".to_string()));
    }

    #[test]
    fn a_page_with_no_images_yields_nothing_rather_than_guessing() {
        assert!(image_urls(PAGE, "<html><body><p>Loading…</p></body></html>").is_empty());
    }
}
