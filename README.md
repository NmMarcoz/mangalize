# mangalize

Turn folders of downloaded manga chapters into a single volume your e-reader
understands. Built because every web tool that does this caps you at 30 images
and then asks for money.

Point it at a folder of chapters, get back a fixed-layout EPUB you can send to a
Kindle.

## Status

The desktop app and the CLI both work. PDF output is not written yet.

| Piece | State |
| --- | --- |
| Folder scanning, junk filtering, page ordering | done |
| Double-page spread detection and splitting | done |
| EPUB 3 fixed-layout writer (Kindle) | done |
| CBZ writer (Komga, Kavita, Tachiyomi) | done |
| Tauri desktop UI | done |
| Online metadata lookup (MangaDex / Kitsu) | done |
| PDF writer | not started |

## Why fixed-layout EPUB

For reading manga on a Kindle, the format matters more than it looks:

- **CBR** is a RAR archive — proprietary, and Kindle cannot open it. Use CBZ if
  you want a comic archive, but Kindle cannot read that either. CBZ here is for
  Komga, Kavita, Tachiyomi and desktop readers.
- **PDF** on a Kindle is a poor experience: fixed page size, no panel zoom,
  sluggish page turns, no real library metadata.
- **EPUB 3 fixed-layout** is what works. Send to Kindle accepts EPUB and converts
  it to KFX on device. With `rendition:layout: pre-paginated`, a per-page
  viewport matching each image, and Amazon's `book-type: comic` hints, you get
  proper page turns, right-to-left reading order and a real cover.

## The desktop app

```sh
bun install
bun run tauri dev        # development
bun run tauri build      # bundled installer for the current platform
```

Drop a volume folder onto the window, or use the folder button. Pages can be
excluded, spreads split and a cover chosen before exporting.

| Key | Action |
| --- | --- |
| `X` | Exclude or restore the selected pages |
| `S` | Split or rejoin the selected spreads |
| `C` | Use the selected page as the cover |
| `Ctrl`/`Cmd` + `A` | Select everything currently visible |
| `Esc` | Clear the selection |

Click selects, `Ctrl`/`Cmd`-click toggles, `Shift`-click extends a range.

Thumbnails are generated on demand as cards scroll into view, capped to a few
concurrent decodes, and cached on disk keyed by each file's identity. That is
what keeps a several-hundred-page volume responsive.

## Metadata lookup

"Fetch metadata online" searches [MangaDex], falling back to [Kitsu]. It fills in
the series title, author and description, offers the official per-volume cover
art, and checks your folder against the published volume layout.

Lookup is always user-initiated. Scanning and exporting never touch the network.

```sh
mangalize lookup "Ichi the Witch" --detail
```

### Why MangaDex

MangaDex is the only free, key-less API that publishes **per-volume** cover art
and a volume-to-chapter map, which is exactly what assembling a volume needs.
Everything else returns a single series poster.

AniList would otherwise be the obvious pick, but its public API currently
responds `403 The AniList API has been temporarily disabled due to severe
stability issues`. Jikan depends on MyAnimeList being up, and Google Books needs
your own key to avoid a shared quota.

One trap worth recording: query `/aggregate` **without** a `translatedLanguage`
filter. Volume tagging is per-translation and crowd-sourced, so filtering to
English returns a sparse, misleading map, while the unfiltered view gives the
real tankoubon structure.

[MangaDex]: https://api.mangadex.org/docs/
[Kitsu]: https://kitsu.docs.apiary.io/

## The CLI

```sh
cargo build --release

# See what the scanner found, without writing anything
./target/release/mangalize scan ~/Downloads/"Itch The Witch Volume 01"

# Build a volume for your Kindle
./target/release/mangalize build ~/Downloads/"Itch The Witch Volume 01" \
    -o itch-vol01.epub --author "Osamu Nishi"

# Or a CBZ for other readers
./target/release/mangalize build ~/Downloads/"Itch The Witch Volume 01" \
    -o itch-vol01.cbz --format cbz
```

Useful flags:

| Flag | Effect |
| --- | --- |
| `--format epub\|cbz` | Output format. Defaults to `epub`. |
| `--title`, `--author` | Override what was guessed from the folder name. |
| `--ltr` | Left-to-right reading. Default is right-to-left. |
| `--split-spreads` | Cut every double-page spread into two pages. |

## What the scanner does

Scraped chapter folders are messy in predictable ways, so the scanner applies
heuristics and reports what it decided:

```
series    Itch The Witch
volume    1
chapters  7
pages     167

Chapter 1     50 pages, 6 spreads, 7 excluded
    03.jpg.jpeg                       1600x1168  spread
    banner.png                         600x400   excluded: off-size
    favicon-32x32.jpg.jpeg              32x32    excluded: off-size
```

**Junk filtering.** Files that were never images (`.svg`, `.gif`, `.css`) are
dropped outright. Files that *are* images but whose dimensions fall far outside
the volume's normal page size — banners, favicons, tracking pixels — are kept in
the list but flagged, so a UI can offer them back.

Size on disk is never used to exclude anything. A near-blank page compresses to a
few kilobytes and is still a real page.

**Page ordering.** Filename schemes vary between chapters of the same rip
(`01.jpg.jpeg` in one, `01_14.jpg.jpeg` in the next). Digit runs are compared
numerically, so page 10 follows page 9 rather than page 1.

**Spread detection.** A page roughly twice the width of the volume's norm is a
double-page spread. By default it is kept whole and marked
`rendition:page-spread-center` so readers show it as one image. `--split-spreads`
cuts it in two, emitting the right half first for right-to-left titles.

## Layout

```
crates/
  mangalize-core/     pipeline; no UI dependency of any kind
    natsort.rs        natural filename ordering
    page.rs           per-image facts and classification
    scan.rs           folder -> Volume, junk filtering, spread detection
    project.rs        the editable model (volume, chapters, metadata)
    writers/
      epub.rs         EPUB 3 fixed-layout, Kindle-tuned
      cbz.rs          zip + ComicInfo.xml
  mangalize-meta/     MangaDex and Kitsu clients; the only networked code
  mangalize-cli/      thin wrapper over core and meta
```

The core crate deliberately knows nothing about Tauri, or any UI. The CLI, the
tests and the eventual desktop app all drive the same code, which keeps the
pipeline testable without launching a GUI and keeps the UI shell replaceable.

## Development

```sh
cargo test        # unit tests plus end-to-end tests over a synthetic scrape
cargo clippy --all-targets
```

The integration tests build a fixture that reproduces the quirks of a real
scrape — mixed filename schemes, site furniture, a spread, a chapter numbered 10
— and assert on the resulting EPUB and CBZ structure.
