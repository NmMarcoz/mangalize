//! Just enough URL handling to turn what a page says into something fetchable.
//!
//! A full URL crate would be a heavier dependency than the problem deserves:
//! resolving `src` against a base and reading the file extension is all that is
//! needed here, and both are easy to get right and easy to test.

/// Resolve a possibly-relative reference against the page it was found on.
///
/// Returns `None` for references that cannot become an HTTP(S) request —
/// `data:`, `javascript:`, `about:blank` and friends.
pub fn resolve(base: &str, reference: &str) -> Option<String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return None;
    }

    if let Some(scheme_end) = scheme_of(reference) {
        return match &reference[..scheme_end].to_ascii_lowercase()[..] {
            "http" | "https" => Some(reference.to_string()),
            _ => None,
        };
    }

    let (scheme, rest) = base.split_once("://")?;
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let origin = format!("{scheme}://{}", &rest[..authority_end]);

    // Protocol-relative: `//cdn.example/x.jpg` inherits the page's scheme.
    if let Some(after) = reference.strip_prefix("//") {
        return Some(format!("{scheme}://{after}"));
    }
    if reference.starts_with('/') {
        return Some(format!("{origin}{reference}"));
    }
    if reference.starts_with('#') {
        return None;
    }

    // Relative to the page's directory. Query and fragment on the base are not
    // part of the directory.
    let path = &rest[authority_end..];
    let path = path.split(['?', '#']).next().unwrap_or("");
    let dir = match path.rfind('/') {
        Some(i) => &path[..=i],
        None => "/",
    };
    Some(format!("{origin}{dir}{reference}"))
}

/// Byte index just past the `:` of a scheme, if the string starts with one.
///
/// Only `a-z0-9+-.` may appear in a scheme, which is what keeps a Windows-style
/// `C:\x` or a relative `chapter:1` from being mistaken for one.
fn scheme_of(s: &str) -> Option<usize> {
    let colon = s.find(':')?;
    if colon == 0 {
        return None;
    }
    let scheme = &s[..colon];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        Some(colon)
    } else {
        None
    }
}

/// The path component of a URL, with query and fragment removed.
pub fn path_of(url: &str) -> &str {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let path = match after_scheme.find('/') {
        Some(i) => &after_scheme[i..],
        None => "/",
    };
    path.split(['?', '#']).next().unwrap_or(path)
}

/// The origin, for use as a `Referer` header.
///
/// Plenty of image hosts refuse requests that do not carry the page's origin,
/// which is the single most common reason a scraped image 403s.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority_end = rest.find('/').unwrap_or(rest.len());
    Some(format!("{scheme}://{}", &rest[..authority_end]))
}

/// Lowercase file extension of a URL's path, if it has one.
pub fn extension_of(url: &str) -> Option<String> {
    let path = path_of(url);
    let last = path.rsplit('/').next()?;
    let (_, ext) = last.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "https://example.test/manga/ichi/chapter-7?page=1";

    #[test]
    fn absolute_references_pass_through() {
        assert_eq!(
            resolve(PAGE, "https://cdn.test/a.jpg").as_deref(),
            Some("https://cdn.test/a.jpg")
        );
    }

    #[test]
    fn protocol_relative_references_inherit_the_scheme() {
        assert_eq!(
            resolve(PAGE, "//cdn.test/a.jpg").as_deref(),
            Some("https://cdn.test/a.jpg")
        );
    }

    #[test]
    fn root_relative_references_use_the_origin() {
        assert_eq!(
            resolve(PAGE, "/img/a.jpg").as_deref(),
            Some("https://example.test/img/a.jpg")
        );
    }

    #[test]
    fn document_relative_references_use_the_directory_not_the_query() {
        assert_eq!(
            resolve(PAGE, "01.jpg").as_deref(),
            Some("https://example.test/manga/ichi/01.jpg")
        );
    }

    #[test]
    fn unfetchable_schemes_are_refused() {
        assert_eq!(resolve(PAGE, "data:image/png;base64,AAA"), None);
        assert_eq!(resolve(PAGE, "javascript:void(0)"), None);
        assert_eq!(resolve(PAGE, "#top"), None);
    }

    #[test]
    fn a_relative_path_containing_a_colon_is_not_a_scheme() {
        assert_eq!(
            resolve(PAGE, "img/ch:7/01.jpg").as_deref(),
            Some("https://example.test/manga/ichi/img/ch:7/01.jpg")
        );
    }

    #[test]
    fn extensions_ignore_the_query_string() {
        assert_eq!(extension_of("https://a.test/1.jpg?w=800").as_deref(), Some("jpg"));
        assert_eq!(extension_of("https://a.test/1.JPEG").as_deref(), Some("jpeg"));
        assert_eq!(extension_of("https://a.test/page/7"), None);
    }

    #[test]
    fn origins_drop_the_path() {
        assert_eq!(origin_of(PAGE).as_deref(), Some("https://example.test"));
    }
}
