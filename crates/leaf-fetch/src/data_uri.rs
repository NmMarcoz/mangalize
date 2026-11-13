//! Pages that are embedded in the page rather than linked from it.
//!
//! Some readers put the image bytes straight into the markup as a `data:` URI,
//! and others build one in JavaScript. Both look the same from outside: there is
//! no address you can open in a new tab, because there is no file anywhere — the
//! image *is* the string.
//!
//! These were previously discarded along with `javascript:` and `blob:` under
//! the heading "cannot become an HTTP request". True of those two, wrong about
//! this one: a data URI needs no request at all, only decoding.

use anyhow::{bail, Context, Result};
use base64::Engine;

/// Whether a reference carries its own bytes.
pub fn is_data_uri(reference: &str) -> bool {
    reference.len() > 5 && reference[..5].eq_ignore_ascii_case("data:")
}

/// Whether it carries bytes that claim to be an image.
///
/// A bare `data:` with no media type defaults to `text/plain` per the spec, so
/// an unlabelled one is not assumed to be a page.
pub fn is_data_image(reference: &str) -> bool {
    is_data_uri(reference) && media_type(reference).starts_with("image/")
}

/// The declared media type, or the spec's default when none is given.
pub fn media_type(uri: &str) -> String {
    let Some(header) = uri.get(5..).and_then(|rest| rest.split(',').next()) else {
        return "text/plain".into();
    };
    let declared = header.split(';').next().unwrap_or("").trim();
    if declared.is_empty() {
        "text/plain".into()
    } else {
        declared.to_ascii_lowercase()
    }
}

/// The bytes a data URI carries.
pub fn decode(uri: &str) -> Result<Vec<u8>> {
    let rest = uri.get(5..).context("not a data URI")?;
    let (header, payload) = rest
        .split_once(',')
        .context("data URI has no comma separating its payload")?;

    if header
        .split(';')
        .any(|part| part.trim().eq_ignore_ascii_case("base64"))
    {
        // Whitespace is not legal inside the payload but turns up anyway when a
        // URI has been pretty-printed into the markup across several lines.
        let cleaned: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
        return base64::engine::general_purpose::STANDARD
            .decode(cleaned.as_bytes())
            .context("data URI payload is not valid base64");
    }

    // The other form is percent-encoded text. Rare for images, but cheap to
    // support and otherwise a confusing failure.
    percent_decode(payload)
}

fn percent_decode(input: &str) -> Result<Vec<u8>> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = input.get(i + 1..i + 3).context("truncated percent escape")?;
            let byte = u8::from_str_radix(hex, 16).context("bad percent escape")?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Ok(out)
}

/// A short, readable stand-in for a data URI.
///
/// The real string is the whole image and can run to megabytes; putting one in
/// a tooltip or an error message would be unusable.
pub fn describe(uri: &str) -> String {
    let approx = decoded_len(uri);
    format!("embedded {} ({:.0} KB)", media_type(uri), approx as f64 / 1024.0)
}

/// Roughly how many bytes a data URI decodes to, without decoding it.
fn decoded_len(uri: &str) -> usize {
    let payload = uri.split_once(',').map(|(_, p)| p).unwrap_or("");
    if uri.contains(";base64") {
        payload.len() / 4 * 3
    } else {
        payload.len()
    }
}

/// Refuse an embedded page large enough to mean something has gone wrong.
pub fn check_size(uri: &str, max: usize) -> Result<()> {
    if decoded_len(uri) > max {
        bail!(
            "an embedded image of about {:.0} MB is larger than anything a page should be",
            decoded_len(uri) as f64 / 1_048_576.0
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // "hi" as base64 is "aGk=".
    const TINY: &str = "data:image/png;base64,aGk=";

    #[test]
    fn a_data_image_is_recognised() {
        assert!(is_data_uri(TINY));
        assert!(is_data_image(TINY));
        assert!(!is_data_image("https://a.test/x.jpg"));
    }

    #[test]
    fn an_unlabelled_data_uri_is_not_assumed_to_be_a_page() {
        // Defaults to text/plain per the spec, so it is not an image.
        assert!(!is_data_image("data:,hello"));
        assert!(!is_data_image("data:text/html;base64,PGI+"));
    }

    #[test]
    fn base64_payloads_decode() {
        assert_eq!(decode(TINY).unwrap(), b"hi");
    }

    #[test]
    fn the_scheme_is_matched_case_insensitively() {
        // Markup in the wild is not tidy about this.
        assert!(is_data_image("DATA:image/jpeg;base64,aGk="));
        assert_eq!(decode("DATA:image/jpeg;BASE64,aGk=").unwrap(), b"hi");
    }

    #[test]
    fn whitespace_inside_a_payload_is_tolerated() {
        // A URI broken across lines in the markup is still the same image.
        assert_eq!(decode("data:image/png;base64,aG\n  k=").unwrap(), b"hi");
    }

    #[test]
    fn percent_encoded_payloads_decode_too() {
        assert_eq!(decode("data:image/svg+xml,a%20b").unwrap(), b"a b");
    }

    #[test]
    fn media_types_are_read_past_the_charset() {
        assert_eq!(media_type("data:image/webp;charset=utf-8;base64,aGk="), "image/webp");
        assert_eq!(media_type("data:,hello"), "text/plain");
    }

    #[test]
    fn a_description_never_contains_the_payload() {
        let described = describe(TINY);
        assert!(described.contains("image/png"));
        assert!(!described.contains("aGk"), "{described}");
    }

    #[test]
    fn an_absurdly_large_embedded_image_is_refused() {
        // Base64 carries three bytes in every four, so the payload has to be a
        // third longer than the cap to breach it. Checked against a small cap
        // rather than allocating a real one.
        let over = format!("data:image/png;base64,{}", "A".repeat(4096));
        assert_eq!(decoded_len(&over), 3072);
        assert!(check_size(&over, 1024).is_err());
        assert!(check_size(&over, 4096).is_ok());
        assert!(check_size(TINY, 64 * 1024 * 1024).is_ok());
    }

    #[test]
    fn malformed_uris_fail_rather_than_panic() {
        assert!(decode("data:image/png;base64").is_err());
        assert!(decode("data:image/png;base64,!!!!").is_err());
        assert!(decode("data:image/svg+xml,a%2").is_err());
    }
}
