//! Natural ordering for scraped filenames.
//!
//! Chapter folders in the wild are inconsistent: `01.jpg.jpeg` in one chapter,
//! `01_14.jpg.jpeg` in the next. Plain lexicographic sort puts `10` before `2`,
//! so we compare runs of digits numerically and everything else bytewise.

use std::cmp::Ordering;

/// Compare two strings treating embedded digit runs as numbers.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.char_indices().peekable();
    let mut bi = b.char_indices().peekable();

    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some((apos, ac)), Some((bpos, bc))) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    let (anum, arest) = take_number(a, apos);
                    let (bnum, brest) = take_number(b, bpos);
                    match anum.cmp(&bnum) {
                        Ordering::Equal => {
                            // Advance both iterators past the consumed digits.
                            while ai.peek().is_some_and(|&(i, _)| i < arest) {
                                ai.next();
                            }
                            while bi.peek().is_some_and(|&(i, _)| i < brest) {
                                bi.next();
                            }
                        }
                        other => return other,
                    }
                } else {
                    match ac.to_ascii_lowercase().cmp(&bc.to_ascii_lowercase()) {
                        Ordering::Equal => {
                            ai.next();
                            bi.next();
                        }
                        other => return other,
                    }
                }
            }
        }
    }
}

/// Read the digit run starting at `start`, returning its value and the byte
/// index just past it. Oversized runs saturate rather than panic.
fn take_number(s: &str, start: usize) -> (u128, usize) {
    let bytes = s.as_bytes();
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    let value = s[start..end].parse::<u128>().unwrap_or(u128::MAX);
    (value, end)
}

/// Extract the first digit run in a string, used to order chapter folders like
/// `itch-the-witch-ch7`.
pub fn leading_number(s: &str) -> Option<u128> {
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|b| b.is_ascii_digit())?;
    Some(take_number(s, start).0)
}

/// Extract the *last* digit run in a string. Chapter folders put the chapter
/// number at the end (`itch-the-witch-ch7`), and any leading digits are usually
/// part of the series name or a date.
pub fn trailing_number(s: &str) -> Option<u128> {
    let bytes = s.as_bytes();
    let end = bytes.iter().rposition(|b| b.is_ascii_digit())? + 1;
    let mut start = end;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    s[start..end].parse::<u128>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digits_compare_numerically() {
        assert_eq!(natural_cmp("2.jpg", "10.jpg"), Ordering::Less);
        assert_eq!(natural_cmp("01.jpg.jpeg", "02.jpg.jpeg"), Ordering::Less);
    }

    #[test]
    fn secondary_numbers_break_ties_after_primary() {
        // The real ch2 naming: leading index drives order, the suffix is noise.
        assert_eq!(natural_cmp("01_14.jpg.jpeg", "02_19.jpg.jpeg"), Ordering::Less);
        assert_eq!(natural_cmp("09_01.jpg.jpeg", "10_99.jpg.jpeg"), Ordering::Less);
    }

    #[test]
    fn chapter_folders_order_past_nine() {
        let mut v = vec!["itch-the-witch-ch10", "itch-the-witch-ch2", "itch-the-witch-ch1"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["itch-the-witch-ch1", "itch-the-witch-ch2", "itch-the-witch-ch10"]);
    }

    #[test]
    fn leading_number_finds_first_run() {
        assert_eq!(leading_number("itch-the-witch-ch7"), Some(7));
        assert_eq!(leading_number("cover"), None);
    }

    #[test]
    fn trailing_number_skips_numbers_in_the_series_name() {
        assert_eq!(trailing_number("itch-the-witch-ch7"), Some(7));
        assert_eq!(trailing_number("2024-ch3"), Some(3));
        assert_eq!(trailing_number("extras"), None);
    }
}
