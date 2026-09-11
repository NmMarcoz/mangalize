//! Fetching candidate images: measuring them first, then saving the chosen ones.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};

use crate::url;
use crate::{Progress, MAX_IMAGE_BYTES, TIMEOUT, USER_AGENT};

/// How many images to fetch at once.
///
/// Small on purpose. The images all come from one host, and hammering it is
/// both rude and the fastest way to get rate-limited mid-chapter.
const WORKERS: usize = 4;

/// Enough of a file to carry the header of every format we accept.
const PROBE_BYTES: usize = 64 * 1024;

/// What a probe learned about one candidate.
#[derive(Debug, Clone, Default)]
pub struct Probe {
    pub width: u32,
    pub height: u32,
    /// Full size in bytes when the server reported one, else 0.
    pub bytes: u64,
    /// Why the probe failed, when it did.
    pub error: Option<String>,
}

/// Read the dimensions of every candidate without downloading it whole.
///
/// Dimensions are what makes the picker useful: they let the same size sieve
/// the folder scanner uses preselect the real pages and flag the banners.
pub fn probe_all(urls: &[String], referer: Option<&str>, progress: &mut Progress) -> Vec<Probe> {
    parallel(urls, referer, progress, |agent_url, referer| {
        match probe_one(agent_url, referer) {
            Ok(probe) => probe,
            Err(e) => Probe {
                error: Some(format!("{e:#}")),
                ..Probe::default()
            },
        }
    })
}

fn probe_one(url: &str, referer: Option<&str>) -> Result<Probe> {
    // A range request keeps this to one round trip and a few KB even when the
    // page is a 4 MB PNG. Servers that ignore it just send more than we read.
    let response = request(url, referer)
        .set("Range", &format!("bytes=0-{}", PROBE_BYTES - 1))
        .call()?;

    let content_type = response.content_type().to_ascii_lowercase();
    let total = content_range_total(&response).or_else(|| {
        response
            .header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok())
    });

    let mut head = Vec::new();
    response
        .into_reader()
        .take(PROBE_BYTES as u64)
        .read_to_end(&mut head)?;

    // Content type is checked after reading because plenty of CDNs mislabel
    // images as `application/octet-stream`; the decoder is the real authority.
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(&head))
        .with_guessed_format()
        .context("reading image header")?
        .into_dimensions()
        .with_context(|| {
            if content_type.starts_with("text/") {
                format!("that URL served {content_type}, not an image")
            } else {
                "could not read the image header".to_string()
            }
        })?;

    Ok(Probe {
        width,
        height,
        bytes: total.unwrap_or(0),
        error: None,
    })
}

/// Download `urls` into `dest`, named in the order given.
///
/// Names are positional (`0001.jpg`), not derived from the URL: source names are
/// frequently hashes or all identical, and page order is the one thing that must
/// survive.
pub fn download_all(
    urls: &[String],
    dest: &Path,
    referer: Option<&str>,
    progress: &mut Progress,
) -> Result<Vec<PathBuf>> {
    std::fs::create_dir_all(dest)
        .with_context(|| format!("creating {}", dest.display()))?;

    let results = parallel(urls, referer, progress, |url, referer| {
        fetch_image(url, referer).map_err(|e| format!("{e:#}"))
    });

    let mut written = Vec::with_capacity(results.len());
    for (index, result) in results.into_iter().enumerate() {
        let (bytes, ext) = result.map_err(|e| anyhow::anyhow!("page {}: {e}", index + 1))?;
        let path = dest.join(format!("{:04}.{ext}", index + 1));
        std::fs::write(&path, &bytes)
            .with_context(|| format!("writing {}", path.display()))?;
        written.push(path);
    }
    Ok(written)
}

/// Fetch one image whole, refusing anything that is not one.
pub fn fetch_image(url: &str, referer: Option<&str>) -> Result<(Vec<u8>, &'static str)> {
    // One retry: a single failed page ruins a whole chapter, and the usual cause
    // is a transient 5xx from an overloaded image host.
    let response = match request(url, referer).call() {
        Ok(response) => response,
        Err(first) => request(url, referer).call().map_err(|_| first)?,
    };

    let declared = response.content_type().to_ascii_lowercase();
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;

    if bytes.len() > MAX_IMAGE_BYTES {
        bail!("image is over {} MB", MAX_IMAGE_BYTES / 1_048_576);
    }

    // Trust the bytes over the header: the format decides the extension, so a
    // WebP served as `image/jpeg` is still stored as `.webp`.
    let format = image::guess_format(&bytes).map_err(|_| {
        if declared.starts_with("text/") {
            anyhow::anyhow!("that URL served {declared}, not an image")
        } else {
            anyhow::anyhow!("could not recognise the image format")
        }
    })?;

    Ok((bytes, extension_for(format)))
}

fn extension_for(format: image::ImageFormat) -> &'static str {
    match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Avif => "avif",
        _ => "jpg",
    }
}

/// A GET carrying the headers image hosts expect.
fn request(target: &str, referer: Option<&str>) -> ureq::Request {
    let mut request = ureq::get(target)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "image/avif,image/webp,image/*,*/*;q=0.8")
        .timeout(TIMEOUT);

    // Many hosts 403 a request that does not look like it came from the page.
    if let Some(referer) = referer {
        request = request.set("Referer", referer);
        if let Some(origin) = url::origin_of(referer) {
            request = request.set("Origin", &origin);
        }
    }
    request
}

/// Total size from a `Content-Range: bytes 0-63/1048576` reply.
fn content_range_total(response: &ureq::Response) -> Option<u64> {
    response
        .header("Content-Range")?
        .rsplit('/')
        .next()?
        .trim()
        .parse()
        .ok()
}

/// Run `job` over every URL on a small pool, preserving input order.
///
/// Results are collected into a pre-sized slot list rather than a queue because
/// page order is positional and must not depend on which worker finished first.
fn parallel<T, F>(urls: &[String], referer: Option<&str>, progress: &mut Progress, job: F) -> Vec<T>
where
    T: Send,
    F: Fn(&str, Option<&str>) -> T + Sync,
{
    let total = urls.len();
    let slots: Mutex<Vec<Option<T>>> = Mutex::new((0..total).map(|_| None).collect());
    let next = AtomicUsize::new(0);
    let (tx, rx) = std::sync::mpsc::channel::<()>();

    std::thread::scope(|scope| {
        for _ in 0..WORKERS.min(total.max(1)) {
            let (slots, next, tx) = (&slots, &next, tx.clone());
            let job = &job;
            scope.spawn(move || loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(url) = urls.get(index) else { return };
                let value = job(url, referer);
                slots.lock().unwrap()[index] = Some(value);
                // A closed channel means the collector is gone; nothing to do
                // about it here, and the remaining work is still worth finishing.
                let _ = tx.send(());
            });
        }
        drop(tx);

        let mut done = 0usize;
        while rx.recv().is_ok() {
            done += 1;
            progress(done, total);
        }
    });

    // Every index is claimed exactly once, and a panicking worker re-panics out
    // of `thread::scope` before this runs, so no slot can still be empty.
    slots
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|slot| slot.expect("worker left a slot unfilled"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_follow_the_bytes_not_the_header() {
        assert_eq!(extension_for(image::ImageFormat::WebP), "webp");
        assert_eq!(extension_for(image::ImageFormat::Png), "png");
        // Anything else is stored as JPEG, which is what it almost always is.
        assert_eq!(extension_for(image::ImageFormat::Tiff), "jpg");
    }
}
