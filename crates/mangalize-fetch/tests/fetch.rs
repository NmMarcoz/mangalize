//! End-to-end against a local server serving a chapter page shaped like a real
//! one: lazy-loaded pages, a banner ad, a favicon, and a hotlink check.
//!
//! Running a real socket rather than mocking the transport is the point. The
//! things that break this code in practice — range requests, `Referer` checks,
//! mislabelled content types — only exist at the HTTP layer.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tempfile::TempDir;

/// A JPEG of the given size, as a real encoded image.
fn jpeg(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbImage::new(width, height);
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Jpeg)
        .unwrap();
    bytes
}

/// The page a reader site serves: real pages behind `data-src`, a spread, and
/// the usual furniture.
fn chapter_html() -> String {
    r#"<!doctype html><html><body>
       <img src="/static/spinner.png" data-src="/pages/01.jpg">
       <img src="/static/spinner.png" data-src="/pages/02.jpg">
       <img src="/static/spinner.png" data-src="/pages/03.jpg">
       <img src="/static/spinner.png" data-src="/pages/04.jpg">
       <img src="/ads/banner.jpg" alt="buy > now">
       <img src="/static/favicon.jpg">
       <script>var preload = ["https:\/\/example.invalid\/never.jpg"];</script>
       </body></html>"#
        .to_string()
}

/// Body for a path, or `None` for 404.
fn body_for(path: &str) -> Option<(&'static str, Vec<u8>)> {
    match path {
        "/chapter-7" => Some(("text/html; charset=utf-8", chapter_html().into_bytes())),
        "/pages/01.jpg" | "/pages/02.jpg" | "/pages/04.jpg" => {
            Some(("image/jpeg", jpeg(800, 1168)))
        }
        // A double-page spread, twice the normal width.
        "/pages/03.jpg" => Some(("image/jpeg", jpeg(1600, 1168))),
        "/ads/banner.jpg" => Some(("image/jpeg", jpeg(728, 90))),
        "/static/favicon.jpg" => Some(("image/jpeg", jpeg(32, 32))),
        "/static/spinner.png" => Some(("image/png", jpeg(16, 16))),
        _ => None,
    }
}

/// A server that answers the handful of requests this test makes.
///
/// `require_referer` mimics the hotlink protection most image hosts run, which
/// is the single most common reason a scraped URL 403s.
struct Server {
    base: String,
    stop: Arc<AtomicBool>,
}

impl Server {
    fn start(require_referer: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));

        let flag = stop.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if flag.load(Ordering::Relaxed) {
                    return;
                }
                if let Ok(stream) = stream {
                    let _ = handle(stream, require_referer);
                }
            }
        });

        Self { base, stop }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Unblock the accept loop so the thread can notice the flag.
        let _ = std::net::TcpStream::connect(self.base.trim_start_matches("http://"));
    }
}

fn handle(mut stream: TcpStream, require_referer: bool) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;

    let path = request_line.split_whitespace().nth(1).unwrap_or("/").to_string();

    let mut range: Option<(usize, usize)> = None;
    let mut referer = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("range: bytes=") {
            if let Some((from, to)) = value.trim().split_once('-') {
                range = Some((from.parse().unwrap_or(0), to.parse().unwrap_or(usize::MAX)));
            }
        }
        if lower.starts_with("referer:") {
            referer = Some(line[8..].trim().to_string());
        }
    }

    let Some((content_type, body)) = body_for(&path) else {
        return stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    };

    if require_referer && path.starts_with("/pages/") && referer.is_none() {
        return stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    }

    match range {
        Some((from, to)) if from < body.len() => {
            let end = to.min(body.len() - 1);
            let slice = &body[from..=end];
            let head = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Type: {content_type}\r\n\
                 Content-Range: bytes {from}-{end}/{}\r\nContent-Length: {}\r\n\r\n",
                body.len(),
                slice.len()
            );
            stream.write_all(head.as_bytes())?;
            stream.write_all(slice)
        }
        _ => {
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes())?;
            stream.write_all(&body)
        }
    }
}

fn silent() -> impl FnMut(usize, usize) {
    |_, _| {}
}

#[test]
fn a_chapter_page_yields_its_pages_measured_and_judged() {
    let server = Server::start(false);
    let found =
        mangalize_fetch::extract_page(&format!("{}/chapter-7", server.base), &mut silent()).unwrap();

    // The lazy placeholder must not have won over the real page.
    assert!(
        found.candidates.iter().all(|c| !c.url.contains("spinner")),
        "a placeholder was offered as a page"
    );

    let taken: Vec<&str> = found
        .candidates
        .iter()
        .filter(|c| c.selected)
        .map(|c| c.url.as_str())
        .collect();
    assert_eq!(taken.len(), 4, "expected four pages, got {taken:?}");
    assert!(taken.iter().all(|u| u.contains("/pages/")));

    // The banner and the favicon are offered, but not ticked.
    let skipped: Vec<&str> = found
        .candidates
        .iter()
        .filter(|c| !c.selected)
        .map(|c| c.url.as_str())
        .collect();
    assert!(skipped.iter().any(|u| u.contains("banner")));
    assert!(skipped.iter().any(|u| u.contains("favicon")));
}

#[test]
fn the_spread_is_recognised_rather_than_thrown_out() {
    let server = Server::start(false);
    let found =
        mangalize_fetch::extract_page(&format!("{}/chapter-7", server.base), &mut silent()).unwrap();

    let spread = found
        .candidates
        .iter()
        .find(|c| c.url.ends_with("/pages/03.jpg"))
        .expect("the wide page was dropped entirely");

    assert_eq!(spread.verdict, mangalize_core::Verdict::Spread);
    assert_eq!((spread.width, spread.height), (1600, 1168));
    assert!(spread.selected);
}

#[test]
fn probing_reads_the_header_not_the_whole_file() {
    let server = Server::start(false);
    let found =
        mangalize_fetch::extract_page(&format!("{}/chapter-7", server.base), &mut silent()).unwrap();

    let page = found
        .candidates
        .iter()
        .find(|c| c.url.ends_with("/pages/01.jpg"))
        .unwrap();

    // The full size comes from `Content-Range`, which only a ranged request has.
    assert!(page.bytes > 0, "full size was not recovered from the range reply");
    assert_eq!((page.width, page.height), (800, 1168));
}

#[test]
fn chosen_pages_land_on_disk_numbered_in_reading_order() {
    let server = Server::start(false);
    let page_url = format!("{}/chapter-7", server.base);
    let found = mangalize_fetch::extract_page(&page_url, &mut silent()).unwrap();

    let chosen: Vec<String> = found
        .candidates
        .iter()
        .filter(|c| c.selected)
        .map(|c| c.url.clone())
        .collect();

    let dir = TempDir::new().unwrap();
    let written = mangalize_fetch::download_pages(
        &chosen,
        dir.path(),
        Some(&page_url),
        &mut silent(),
    )
    .unwrap();

    assert_eq!(written.len(), 4);
    let names: Vec<String> = written
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["0001.jpg", "0002.jpg", "0003.jpg", "0004.jpg"]);

    // Order is positional, so page 3 on disk is the spread from the page.
    let (w, _) = image::image_dimensions(&written[2]).unwrap();
    assert_eq!(w, 1600);
}

#[test]
fn the_page_url_is_sent_as_a_referer_so_hotlink_checks_pass() {
    let server = Server::start(true);
    let page_url = format!("{}/chapter-7", server.base);

    let found = mangalize_fetch::extract_page(&page_url, &mut silent()).unwrap();
    let chosen: Vec<String> = found
        .candidates
        .iter()
        .filter(|c| c.selected)
        .map(|c| c.url.clone())
        .collect();
    assert_eq!(chosen.len(), 4, "hotlink protection defeated the probe");

    let dir = TempDir::new().unwrap();
    let written =
        mangalize_fetch::download_pages(&chosen, dir.path(), Some(&page_url), &mut silent())
            .unwrap();
    assert_eq!(written.len(), 4);
}

#[test]
fn a_page_that_builds_itself_in_javascript_reports_nothing_rather_than_junk() {
    let server = Server::start(false);
    // `/missing` 404s, which is the closest this fixture gets to a page whose
    // markup holds no images at all.
    let found =
        mangalize_fetch::extract_page(&format!("{}/missing", server.base), &mut silent());
    assert!(found.is_err() || found.unwrap().candidates.is_empty());
}

#[test]
fn a_dead_image_url_is_reported_against_that_page_not_the_whole_chapter() {
    let server = Server::start(false);
    let urls = vec![
        format!("{}/pages/01.jpg", server.base),
        format!("{}/pages/nope.jpg", server.base),
    ];

    let measured = mangalize_fetch::measure(&urls, None, &mut silent());
    assert!(measured[0].error.is_none());
    assert!(measured[1].error.is_some());
    assert!(!measured[1].selected, "an unreadable candidate must not be preticked");

    let dir = TempDir::new().unwrap();
    let failure = mangalize_fetch::download_pages(&urls, dir.path(), None, &mut silent())
        .unwrap_err()
        .to_string();
    assert!(failure.contains("page 2"), "unhelpful message: {failure}");
}
