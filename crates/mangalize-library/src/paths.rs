//! Turning titles and chapter labels into folder names that survive every OS.

/// Characters that are illegal in a filename on at least one target platform,
/// plus the ones that merely make a path miserable to type.
const ILLEGAL: &str = "/\\:*?\"<>|";

/// A folder name for a series title.
///
/// Trailing dots and spaces are stripped because Windows silently drops them,
/// which would make the stored path and the real one disagree.
pub fn series_slug(title: &str, id: i64) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if ILLEGAL.contains(c) || c.is_control() { '-' } else { c })
        .collect();

    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();

    // Two series can legitimately share a title across sources, and a title can
    // be empty or entirely illegal characters, so the row id is always appended.
    let base = if trimmed.is_empty() { "Untitled" } else { trimmed };

    // Long names hit the 255-byte component limit on ext4 and APFS. Cut on a
    // char boundary, not a byte one.
    let base: String = base.chars().take(120).collect();
    format!("{base} [{id}]")
}

/// A folder name for a chapter label, zero-padded so the folders sort the way
/// the chapters read even in a plain file browser.
///
/// Decimal chapters are real and common (`7.5` for an interlude), so the
/// fractional part is preserved rather than rounded away.
pub fn chapter_slug(number: &str) -> String {
    let trimmed = number.trim();
    match trimmed.parse::<f64>() {
        Ok(n) if n.is_finite() && n >= 0.0 => {
            let whole = n.trunc() as u64;
            let fraction = trimmed.split_once('.').map(|(_, f)| f.trim_end_matches('0'));
            match fraction {
                Some(f) if !f.is_empty() => format!("c{whole:04}.{f}"),
                _ => format!("c{whole:04}"),
            }
        }
        // Labels like "Oneshot" or "Extra" keep their name, sanitised.
        _ => {
            let safe: String = trimmed
                .chars()
                .map(|c| if ILLEGAL.contains(c) || c.is_control() { '-' } else { c })
                .take(64)
                .collect();
            let safe = safe.trim().to_string();
            if safe.is_empty() { "c-unnamed".into() } else { format!("c-{safe}") }
        }
    }
}

/// A file stem for a volume's cover art, e.g. `v1` or `v7.5`.
pub fn volume_slug(number: &str) -> String {
    let safe: String = number
        .trim()
        .chars()
        .map(|c| if ILLEGAL.contains(c) || c.is_control() { '-' } else { c })
        .take(32)
        .collect();
    let safe = safe.trim().to_string();
    if safe.is_empty() { "v-unnamed".into() } else { format!("v{safe}") }
}

/// Numeric ordering for a volume or chapter label.
///
/// Returns `None` for labels that are not numbers at all, which callers sort
/// last: "Extra" belongs after chapter 200, not between 1 and 2.
pub fn sort_key(label: &str) -> Option<f64> {
    label.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

/// Zero-padded page filename, so every reader and every `ls` agrees on order.
pub fn page_name(index: usize, ext: &str) -> String {
    format!("{:04}.{ext}", index + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_slugs_lose_path_separators() {
        assert_eq!(series_slug("Fullmetal / Alchemist", 3), "Fullmetal - Alchemist [3]");
    }

    #[test]
    fn series_slugs_survive_an_empty_title() {
        assert_eq!(series_slug("   ", 9), "Untitled [9]");
    }

    #[test]
    fn windows_would_eat_a_trailing_dot() {
        assert_eq!(series_slug("Vol.", 1), "Vol [1]");
    }

    #[test]
    fn chapter_folders_sort_numerically_as_plain_text() {
        let mut names = vec![chapter_slug("10"), chapter_slug("2"), chapter_slug("1")];
        names.sort();
        assert_eq!(names, ["c0001", "c0002", "c0010"]);
    }

    #[test]
    fn decimal_chapters_keep_their_fraction() {
        assert_eq!(chapter_slug("7.5"), "c0007.5");
        assert_eq!(chapter_slug("7.50"), "c0007.5");
    }

    #[test]
    fn named_chapters_keep_their_name() {
        assert_eq!(chapter_slug("Oneshot"), "c-Oneshot");
    }

    #[test]
    fn volume_covers_are_named_after_their_volume() {
        assert_eq!(volume_slug("1"), "v1");
        assert_eq!(volume_slug("7.5"), "v7.5");
        assert_eq!(volume_slug("a/b"), "va-b");
    }

    #[test]
    fn unparseable_labels_sort_last() {
        assert_eq!(sort_key("12.5"), Some(12.5));
        assert_eq!(sort_key("Extra"), None);
    }
}
