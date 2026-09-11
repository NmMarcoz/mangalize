//! Rendering a chapter page in a real browser window and collecting the images
//! it actually loaded.
//!
//! Reading the markup covers pages that ship their images in it. Plenty do not:
//! they build the page list in JavaScript, lazy-load on scroll, or sit behind a
//! "click to read". For those the only honest answer to "what images are on this
//! page" is to render it and look, which is what this does.
//!
//! The window is the user's: they can log in, dismiss a banner, page through a
//! gallery, and click Capture when the pages are actually on screen. Nothing is
//! collected without that click.
//!
//! ## On the capability this needs
//!
//! The injected script reports back through Tauri's event system, so the harvest
//! window is granted `core:event:allow-emit` for remote URLs — see
//! `capabilities/harvest.json`. That is a real, if narrow, surface: any script
//! on a page the user opens can emit events at the app. It is scoped to emit
//! alone, to that one window, and the only listener here treats what arrives as
//! a list of untrusted URLs to *offer* the user, never to act on. Nothing is
//! fetched until they pick it in the picker.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Label of the harvest window. Only ever one at a time.
const WINDOW: &str = "harvest";

/// The event the injected script emits on capture.
const EVENT: &str = "harvest:pages";

/// One image the rendered page had loaded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Harvested {
    pub url: String,
    pub width: u32,
    pub height: u32,
}

/// Open `url` in a window and return the images the user captured.
///
/// An empty list means they closed the window without capturing, which is a
/// perfectly ordinary outcome and not an error.
#[tauri::command]
pub async fn harvest_images(app: AppHandle, url: String) -> Result<Vec<Harvested>, String> {
    let target = url
        .parse::<tauri::Url>()
        .map_err(|_| format!("{url} is not a URL"))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("only http and https pages can be opened".into());
    }

    // A second harvest replaces the first; two of these windows would both be
    // emitting at the same listener.
    if let Some(existing) = app.get_webview_window(WINDOW) {
        let _ = existing.close();
    }

    let (tx, mut rx) = tauri::async_runtime::channel::<Vec<Harvested>>(1);

    let captured = tx.clone();
    let listener = app.listen(EVENT, move |event| {
        let images = serde_json::from_str::<Vec<Harvested>>(event.payload()).unwrap_or_default();
        let tx = captured.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(images).await;
        });
    });

    let window = WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::External(target))
        .title("Load the chapter, then click Capture")
        .inner_size(1180.0, 900.0)
        .initialization_script(COLLECTOR)
        .build()
        .map_err(|e| e.to_string())?;

    // Closing the window is how the user cancels, so it has to wake the wait.
    let closed = tx.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let tx = closed.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tx.send(Vec::new()).await;
            });
        }
    });

    let images = rx.recv().await.unwrap_or_default();

    app.unlisten(listener);
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
    Ok(images)
}

/// Runs in the harvest window before the page's own scripts.
///
/// Deliberately does nothing until the user clicks: it scrolls the page once so
/// anything lazy-loaded has been asked for, keeps a live count in a floating
/// bar, and reports only when asked. Images smaller than a page are ignored so
/// the count reflects pages rather than icons and avatars.
const COLLECTOR: &str = r#"
(function () {
  // Ad frames would each add their own bar and report their own images.
  if (window.top !== window.self) return;

  var MIN_EDGE = 200;
  var EVENT = 'harvest:pages';

  function collect() {
    var seen = Object.create(null);
    var found = [];
    var images = document.querySelectorAll('img');
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var url = img.currentSrc || img.src || '';
      if (!/^https?:/.test(url)) continue;
      if (img.naturalWidth < MIN_EDGE || img.naturalHeight < MIN_EDGE) continue;
      if (seen[url]) continue;
      seen[url] = true;
      // DOM order is reading order on essentially every reader.
      found.push({ url: url, width: img.naturalWidth, height: img.naturalHeight });
    }
    return found;
  }

  function report() {
    window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: EVENT,
      payload: collect()
    });
  }

  // Walk the page once so anything that loads on scroll has been asked for.
  function prime(done) {
    var y = 0;
    var step = Math.max(400, Math.round(window.innerHeight * 0.9));
    var timer = setInterval(function () {
      y += step;
      window.scrollTo(0, y);
      if (y >= document.body.scrollHeight) {
        clearInterval(timer);
        window.scrollTo(0, 0);
        setTimeout(done, 400);
      }
    }, 120);
  }

  function bar() {
    var host = document.createElement('div');
    host.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
      'font:13px -apple-system,Segoe UI,sans-serif;';
    // A shadow root keeps the page's own CSS from restyling the bar.
    var root = host.attachShadow({ mode: 'closed' });
    root.innerHTML =
      '<div style="display:flex;gap:12px;align-items:center;justify-content:center;' +
      'padding:10px 14px;background:#111;color:#eee;box-shadow:0 -2px 12px rgba(0,0,0,.5)">' +
      '<span id="count">looking...</span>' +
      '<button id="rescan" style="padding:6px 12px;border-radius:6px;border:1px solid #555;' +
      'background:#222;color:#eee;cursor:pointer">Rescan</button>' +
      '<button id="go" style="padding:6px 14px;border-radius:6px;border:0;' +
      'background:#6366f1;color:#fff;font-weight:600;cursor:pointer">Capture</button>' +
      '</div>';

    var label = root.getElementById('count');
    function refresh() {
      var n = collect().length;
      label.textContent = n === 1 ? '1 image on this page' : n + ' images on this page';
    }

    root.getElementById('go').addEventListener('click', report);
    root.getElementById('rescan').addEventListener('click', function () {
      prime(refresh);
    });

    document.documentElement.appendChild(host);
    prime(refresh);
    setInterval(refresh, 1500);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    bar();
  } else {
    window.addEventListener('DOMContentLoaded', bar);
  }
})();
"#;
