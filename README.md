# Leaf

<p align="center">
  <strong>Turn folders of manga pages into volumes your e-reader understands.</strong>
</p>

Leaf transforms your downloaded manga chapters into properly formatted EPUB and CBZ volumes, ready for Kindle, Kobo, or any e-reader. Built for readers who want their manga library organized, not locked behind paywalls.

## Features

- **Smart volume detection** — Automatically scans folders, filters junk, and orders pages correctly
- **Fixed-layout EPUB** — Perfect for manga: per-page viewports, right-to-left reading, Kindle-optimized
- **CBZ export** — For Komga, Kavita, Tachiyomi, and other comic readers
- **Double-page spread handling** — Detects and splits spreads for proper e-reader display
- **Metadata lookup** — Pull series info, covers, and volume layouts from MangaDex and Kitsu
- **Library management** — Track your collection, see missing chapters, batch download
- **Desktop app** — Native Tauri application with a clean, modern UI
- **CLI tool** — For automation and scripting

## Installation

### Desktop App

Download the latest release for your platform:

- **macOS**: `.dmg` installer (Intel and Apple Silicon)
- **Windows**: `.exe` (NSIS) or `.msi` installer
- **Android**: `.apk` for sideloading

First launch may show a security warning since the app isn't code-signed yet. On macOS, right-click and choose "Open"; on Windows, click "More info" then "Run anyway".

### CLI

Build from source:

```sh
cargo build --release
./target/release/leaf --help
```

Requires Rust 1.88 or newer.

## Quick Start

### Desktop App

1. **Open Leaf** and choose your library folder (defaults to `~/Leaf`)
2. **Add a series** — search MangaDex, pull metadata and covers
3. **See what's missing** — volume covers show completion at a glance
4. **Download chapters** — paste a URL or batch download all missing ones
5. **Build volumes** — exclude pages, split spreads, export as EPUB or CBZ

You can also skip the library entirely: drop a folder of chapters onto the window and export directly.

### CLI

```sh
# Add a series to your library
leaf library add "One Piece"

# See what chapters you're missing
leaf library status 1

# Preview what a page offers (without downloading)
leaf library peek "https://example.com/chapter-7"

# Download a chapter
leaf library get 1 7 "https://example.com/chapter-7"

# Batch download all missing chapters
leaf library batch 1 "https://example.com/chapter-1"

# Build a volume
leaf library build 1 1 -o one-piece-v01.epub

# Or scan and export a folder directly
leaf build ~/Downloads/"One Piece Vol 01" -o one-piece-v01.epub
```

## Why Fixed-Layout EPUB?

For manga on e-readers, the format matters:

- **PDF** — Fixed page size, no panel zoom, sluggish page turns, poor metadata
- **CBR/CBZ** — Comic archives; Kindle can't open them natively
- **EPUB 3 fixed-layout** — The sweet spot. Send to Kindle accepts EPUB and converts to KFX on device. With `rendition:layout: pre-paginated`, per-page viewports, and right-to-left reading order, you get proper page turns, full control over layout, and a real cover.

Leaf's EPUB output is tuned for Kindle: Amazon's `book-type: comic` hints, uncompressed images for speed, and viewport metadata that matches each page's actual dimensions.

## The Library

```
~/Leaf/
  leaf.db
  series/
    One Piece [1]/
      cover.jpg
      chapters/
        c0007/0001.jpg …
      volumes/
        v01.jpg
```

A plain folder you own, with a SQLite index beside the files. You can back it up, move it, or explore it without the app. The CLI and desktop app use the same location by default.

## Batch Download

Paste any chapter URL — or the series index — and Leaf extracts the chapter number into a pattern, then checks which chapters your library says are missing. It shows you the plan: how many chapters were found, which came from links and which from the pattern, and which couldn't be reached. Nothing downloads until you confirm.

Chapters are fetched one at a time with a pause between them (to be polite to the source host). A failed chapter is reported and the run continues. Each chapter lands in the volume the published layout puts it in.

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `X` | Exclude or restore selected pages |
| `S` | Split or rejoin selected spreads |
| `C` | Use selected page as cover |
| `Ctrl`/`Cmd` + `A` | Select all visible pages |
| `Esc` | Clear selection |

Click selects, `Ctrl`/`Cmd`-click toggles, `Shift`-click extends a range.

## Development

```sh
# Install dependencies
bun install

# Run the desktop app in dev mode
bun run tauri dev

# Build a release installer
bun run tauri build

# Run tests
cargo test

# Lint
cargo clippy --all-targets
```

Requires Rust 1.88+, Bun, and platform-specific build tools (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).

## Architecture

```
crates/
  leaf-core/         Pipeline; no UI, no network
  leaf-meta/         MangaDex and Kitsu clients
  leaf-library/      SQLite index + files on disk
  leaf-fetch/        Page URL → image candidates → downloads
  leaf-extensions/   Lua-backed source extensions
  leaf-send/         Email to Kindle
  leaf-cli/          CLI wrapper
src-tauri/           Tauri desktop shell
src/                 React frontend
```

The core crate knows nothing about Tauri or any UI. The CLI, tests, and desktop app all drive the same pipeline code.

## Contributing

Contributions welcome! Please open an issue first to discuss major changes.

## License

MIT

---

<p align="center">
  <em>Made with 🍃 for manga readers who want control over their library.</em>
</p>
