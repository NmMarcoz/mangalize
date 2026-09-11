//! UTC timestamp formatting for EPUB's `dcterms:modified`, which is mandatory
//! and must be `YYYY-MM-DDThh:mm:ssZ`. Implemented locally to avoid pulling a
//! date library in for one field.

use std::time::{SystemTime, UNIX_EPOCH};

/// Current time as an EPUB-legal UTC timestamp.
pub fn now_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_utc(secs)
}

/// Format Unix seconds as `YYYY-MM-DDThh:mm:ssZ`.
pub fn format_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Days since 1970-01-01 to a (year, month, day) civil date.
///
/// Howard Hinnant's `civil_from_days`, which is exact for the full proleptic
/// Gregorian range.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(1_000_000_000), "2001-09-09T01:46:40Z");
    }

    #[test]
    fn handles_leap_day() {
        // 2024-02-29T12:00:00Z
        assert_eq!(format_utc(1_709_208_000), "2024-02-29T12:00:00Z");
    }

    #[test]
    fn handles_dates_before_the_epoch() {
        assert_eq!(format_utc(-1), "1969-12-31T23:59:59Z");
    }
}
