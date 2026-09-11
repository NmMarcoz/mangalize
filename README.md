# mangalize

Keep a manga library on your own disk, and turn it into volumes your e-reader
understands. Built because every web tool that does this caps you at 30 images
and then asks for money.

Add a series, and it tells you which chapters you are missing, volume by volume.
Paste the page holding a chapter's images and it pulls them in. Then you get a
fixed-layout EPUB you can send to a Kindle.

The original path still works untouched: drop a folder of chapters on the window
and export it, no library involved.

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
| Library: series, volumes, missing chapters | done |
| Downloading a chapter from a pasted URL | done |
| Batch download of every missing chapter | done |
| PDF writer | not started |
| CI builds for macOS and Windows | done |
| In-app auto-update from GitHub Releases | done |

## The library

```
~/Mangalize/
  mangalize.db
  series/
    Ichi the Witch [1]/
      cover.jpg
      chapters/
        c0007/0001.jpg …
```

A plain folder you own, with a SQLite index beside the files — the same shape
Calibre uses, and for the same reason: you should be able to back it up, move it
and look inside it without the app's help. The CLI and the desktop app default to
the same location, so they see the same collection.

The flow:

1. **Add a series.** Searches MangaDex, stores the metadata and cover, and pulls
   the published volume-to-chapter map.
2. **See the gaps.** The series page is a shelf of volume covers, each showing
   how much of it you hold. Volumes you have nothing of are dimmed. Selecting one
   lists its chapters — `missing 4–6, 11` rather than a wall of numbers.
3. **Get chapters.** Paste the URL of one chapter page, or fill the whole series
   in one go with a batch download.
4. **Build.** The volume goes into the editor you already had: exclude pages,
   split spreads, pick a cover, export.

Deleting files is always opt-in. Removing a series from the library leaves the
folder alone unless you explicitly ask otherwise, and re-syncing a series never
removes a chapter you hold just because the upstream index stopped listing it.

## Getting a chapter's images

This is the part that used to mean copying a URL into some image-extractor site.

Paste the page URL and Mangalize reads its markup for images — unpacking
`srcset`, preferring the real image over a lazy-loading placeholder, and finding
page lists embedded in scripts. Nothing site-specific; it works on whatever you
point it at.

Every candidate is then **measured before anything is saved**, using a range
request that reads only the image header. Those dimensions go through the same
size sieve the folder scanner uses, so real pages come pre-ticked, double-page
spreads are marked as spreads, and banners and favicons are shown but left
unticked. You confirm the selection; only then is anything downloaded.

Pages that build themselves in JavaScript have no images in their markup to find.
For those, **Open page** renders the URL in a real window — log in, dismiss the
banner, scroll until the pages load — and captures the images the page actually
loaded when you click Capture.

Two details that matter in practice: the page URL is always sent as the
`Referer`, because hotlink protection is the most common reason a scraped image
fails; and downloaded pages are named positionally (`0001.jpg`), because source
filenames are frequently hashes and reading order is the thing that must survive.

## Batch download

Chapter URLs on a reader site are nearly always the same string with one number
changed. Paste any one of them — or the series index — and Mangalize factors the
number out into a pattern.

It then looks for **only the chapters your library says are missing**. Links the
page actually published are used first, since a link is evidence; the remaining
gaps get a URL built from the pattern, and each of those is fetched once to
confirm it really loads. What you see is the plan: how many chapters were found,
which came from links and which from the pattern, and which could not be reached
at all. Nothing downloads until you press the button.

Chapters are then fetched one at a time, with a pause between them — the images
all come from one host, usually a small one. A chapter that fails is reported and
the run carries on rather than throwing away the forty that would have followed,
and you can stop a long batch at any point. Each chapter lands in the volume the
published layout puts it in, so the shelf fills itself in.

There is no crawling. The published chapter list bounds the search, and the plan
is always shown first.

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

The app opens on your library. Add a series, open it to see its volumes as a
cover gallery, and build one once you have its chapters. The export name is
derived from the series and volume and can be edited before you save.

To skip the library entirely, drop a volume folder onto the window or use the
folder button. Pages can be excluded, spreads split and a cover chosen before
exporting.

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

## Installing, and updates

Releases carry a `.dmg` for macOS and both a `.exe` and an `.msi` for Windows.
Builds are unsigned for now, so the first launch shows a warning: on macOS,
right-click the app and choose Open; on Windows, "More info" then "Run anyway".
Everything after that is normal, updates included.

The app checks for a new release once on launch and shows a strip along the
bottom if there is one. Nothing is downloaded until you click Update, and the
check is silent when it fails — a machine with no network should not be nagged.
There is also a manual check in the library header.

### Cutting a release

```sh
# 1. bump the version in src-tauri/tauri.conf.json, commit it
# 2. tag it, matching that version exactly
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` builds on macOS and Windows runners, and opens a
**draft** release with the installers attached. Review it, then publish — the
in-app updater reads the latest *published* release, so a draft is invisible to
users until you are happy with it.

The workflow fails early if the tag and the version in `tauri.conf.json`
disagree, because an updater that offers `v0.2.0` and installs something else is
a miserable thing to debug.

Running the workflow manually (`workflow_dispatch`) builds the same installers
and attaches them as workflow artifacts without creating a release, which is how
to test a CI change without spending a version number.

### How updates are trusted

Update artifacts are signed with a minisign key that never leaves your machine
and GitHub Secrets; the app holds only the public half, in `tauri.conf.json`. An
installed copy will refuse an update that is not signed by that key, so a
compromised release page is not enough to push code to users.

This is unrelated to OS code signing. Adding an Apple Developer certificate and
a Windows code-signing certificate is what removes the first-launch warnings;
the workflow has those steps written out and commented, needing only the secrets.

Two secrets are required for releases to build:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the generated private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password, empty if none was set |

Losing the private key means existing installs can no longer be updated — they
would have to be reinstalled by hand. Keep a backup somewhere safe.

## The CLI

```sh
cargo build --release

# The library, end to end
./target/release/mangalize library add "Ichi the Witch"
./target/release/mangalize library status 1
./target/release/mangalize library peek "https://…/chapter-7"
./target/release/mangalize library get 1 7 "https://…/chapter-7"
./target/release/mangalize library batch 1 "https://…/chapter-1" --dry-run
./target/release/mangalize library batch 1 "https://…/chapter-1"
./target/release/mangalize library build 1 1 -o ichi-v01.epub
./target/release/mangalize library remove 1                # keeps the files
./target/release/mangalize library remove 1 --delete-files # does not

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

`library peek` is worth knowing about on its own: it lists what a page offers,
with dimensions and whether each image looks like a page, without downloading
anything. The library lives at `~/Mangalize` unless you set `$MANGALIZE_LIBRARY`
or pass `--library`.

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
    sieve.rs          page vs. spread vs. site furniture, by size
    scan.rs           folder -> Volume, junk filtering, spread detection
    project.rs        the editable model (volume, chapters, metadata)
    writers/
      epub.rs         EPUB 3 fixed-layout, Kindle-tuned
      cbz.rs          zip + ComicInfo.xml
  mangalize-meta/     MangaDex and Kitsu clients
  mangalize-library/  the stored collection: SQLite index + files on disk
  mangalize-fetch/    page URL -> image candidates -> downloaded pages
    series.rs         chapter-number-in-URL detection, for batch download
  mangalize-cli/      thin wrapper over the above
```

The core crate deliberately knows nothing about Tauri, or any UI. The CLI, the
tests and the desktop app all drive the same code, which keeps the pipeline
testable without launching a GUI and keeps the UI shell replaceable.

`mangalize-library` never touches the network either — it is handed metadata that
was already fetched, and bytes that were already downloaded. That is what lets
the whole library be tested against a real folder with no network at all.

The size sieve is shared rather than duplicated: the folder scanner applies it to
files, and the download picker applies it to images that are still only URLs, so
both agree on what a page is.

## Development

```sh
cargo test        # unit tests plus three end-to-end suites
cargo clippy --all-targets
```

Requires rustc 1.88 or newer.

The end-to-end tests avoid mocking the thing under test. The pipeline suite
builds a fixture reproducing the quirks of a real scrape — mixed filename
schemes, site furniture, a spread, a chapter numbered 10 — and asserts on the
resulting EPUB and CBZ structure. The library suite works against a real library
folder. The fetch suite runs an actual HTTP server serving a chapter page with
lazy-loaded images, a spread, a banner and hotlink protection, because the
failures that happen in practice only exist at the HTTP layer.
