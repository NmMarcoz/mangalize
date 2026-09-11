# CLAUDE.md

Mangalize turns folders of scraped manga chapters into fixed-layout EPUB / CBZ
volumes for a Kindle. `README.md` explains *what* it does and why the formats
were chosen — read it first. This file records *how the code is put together*
and the conventions to keep.

## Layout

```
crates/mangalize-core/    the pipeline. No UI, no Tauri, no network. Ever.
crates/mangalize-meta/    MangaDex + Kitsu clients. Networked.
crates/mangalize-library/ the stored collection: SQLite index + files. No network.
crates/mangalize-fetch/   page-URL -> image candidates -> downloads. Networked.
crates/mangalize-cli/     `mangalize` binary; thin wrapper over the above.
src-tauri/                Tauri v2 shell. Commands only; no pipeline logic.
src/                      React 19 + Vite 8 + Tailwind 4 frontend.
```

Dependency direction: `library` and `fetch` both depend on `core`, never on each
other, and neither depends on `meta`. The library is handed already-fetched
metadata as plain `PublishedVolume` values, so "where metadata comes from" stays
a decision the callers make.

Cargo workspace at the root includes `src-tauri` as a member (`mangalize-app`).
Shared deps live in `[workspace.dependencies]`; crates use `dep.workspace = true`.

`[profile.dev.package."*"] opt-level = 2` is deliberate — the `image` crate is
unusably slow unoptimised and the test fixtures encode real JPEGs.

## The architectural rule

`mangalize-core` must stay free of UI and network dependencies. The CLI, the
desktop app and the integration tests all drive the same `scan_volume` → edit
`Volume` → `writers::*::write` path. That is what keeps the pipeline testable
without launching a GUI and the UI shell replaceable.

Corollary: `src-tauri/src/lib.rs` is a translation layer. If you find yourself
writing an `if` about pages or chapters in there, it belongs in core.

## Data model (`core/src/project.rs`, `core/src/page.rs`)

`Volume { metadata, cover, chapters, root }` → `Chapter { title, source, pages }`
→ `Page { path, width, height, bytes, kind, excluded, split }`.

- Excluded pages stay in the list with an `ExcludeReason`, so the UI can offer
  them back. Never filter them out during scan.
- `Page::is_included()` / `Chapter::included()` / `Volume::included_pages()` are
  the only correct way to ask "what gets written".
- Everything is `Serialize + Deserialize` because the whole `Volume` crosses the
  Tauri IPC boundary in both directions. serde enums are `kebab-case`; the
  mirrors in `src/lib/api.ts` must be updated in the same commit.

## Scanning heuristics (`core/src/sieve.rs`, `core/src/scan.rs`)

The size judgement lives in `sieve.rs` and is shared: `scan.rs` uses it on files,
and `mangalize-fetch` uses it on images that are still only URLs, so the download
picker preselects pages and flags banners using the same rules as the scanner.
Thresholds are named consts at the top of `sieve.rs` (`HEIGHT_MIN`, `WIDTH_MAX`,
`SPREAD_MIN`, `MIN_SAMPLE`). Tune those, don't inline magic numbers.

- The modal page size is computed across the **whole volume**, not per chapter —
  every chapter came from the same rip.
- Below `MIN_SAMPLE` readable images, size filtering is skipped entirely rather
  than guessing from a bad sample.
- **File size is never an exclusion signal.** A near-blank page compresses to a
  few KB and is still a real page. There is a test asserting this.
- Extension-rejected files are dropped silently; files that *look* like images
  but fail to decode are kept and flagged. Noise vs. signal.
- `stable_id` hashes the folder name so re-exporting keeps the same EPUB identity
  instead of duplicating in the reader's library.

## Writers (`core/src/writers/`)

- `render_page` passes unsplit pages through **byte-for-byte**. Re-encoding a
  JPEG that is already the right size only costs quality and time. Only split
  spread halves get re-encoded.
- Images are `Stored` in the zip, not deflated — they are already compressed.
- EPUB: the `mimetype` entry must be first and uncompressed. Per-page viewport
  must match the image's real pixel dimensions or fixed-layout readers letterbox.
  Kindle hints use EPUB 2 style `<meta name=… content=…>`; that is what Kindle
  actually reads inside an EPUB 3 package.
- Both writers take `&mut Progress = dyn FnMut(usize, usize)`. `write()` is the
  thin wrapper over `write_with_progress()`.

## Metadata (`crates/mangalize-meta`)

- Network access is **always user-initiated**. Scan and export never touch it.
- MangaDex responses are walked as untyped `serde_json::Value` on purpose: the
  shapes are deep, optional and mostly discarded.
- MangaDex's canonical `title` is in whatever language the uploader chose, so the
  English name usually lives in `altTitles` — see `localized()`.
- Query `/aggregate` **without** `translatedLanguage`. Filtering gives a sparse,
  misleading volume map. (Also in the README; it is the one trap worth repeating.)
- `volume_sort_key` keeps "10" after "2" and unparseable labels last.
- AniList is out (public API disabled by its operators). Kitsu is the fallback
  and has no per-volume data.

## The library (`crates/mangalize-library`)

A folder the user owns, with a SQLite index beside the files:

```
<library>/mangalize.db
<library>/series/<Title [id]>/cover.jpg
<library>/series/<Title [id]>/chapters/c0007/0001.jpg
```

- Default root is `~/Mangalize` for **both** the CLI and the app, deliberately:
  same collection, either front end. Visible, not app-private — the user has to
  be able to back it up and move it.
- One `chapters` table holds published *and* downloaded chapters. A row with a
  null `folder` is a chapter we know exists but do not have, which is exactly the
  question the UI asks, so "missing" is a filter and not a join.
- **`sync_layout` never deletes.** Upstream indexes get re-tagged and re-numbered
  constantly; a chapter the user holds outranks whatever the index now says. It
  is counted as `orphaned` and kept. There is a test.
- Adding a series is idempotent on `(source, source_id)` — searching again for a
  series you already have is something users do constantly.
- `build_volume` scans the *whole* chapters folder and then filters, because the
  page-size norm is more reliable across a series than across one volume.
- Schema changes need a new step in `schema.rs` and a `CURRENT` bump. A newer
  index than the build understands is refused, never downgraded.

## Getting chapters (`crates/mangalize-fetch`)

Two halves, both driven by a URL the user pastes, and nothing site-specific.

- `extract.rs` scans markup for attributes rather than building a DOM: reader
  pages are frequently malformed, and every question asked ("what is this tag's
  `src`?") is answerable from the tag text. Lazy placeholders lose to `data-src`;
  `srcset` is unpacked; script bodies are scanned for embedded page lists.
- Document order is page order. Never sort by filename — plenty of sites serve
  hashed or opaque names.
- Candidates are **measured before anything is saved**, via a ranged GET that
  reads only the header. That is what lets the sieve preselect real pages.
- The page URL is always sent as `Referer`. Hotlink protection is the single most
  common reason a scraped image 403s, and there is a test that covers it.
- Downloads are 4-wide at most: the images all come from one host.
- Stored page names are positional (`0001.jpg`), never derived from the URL.

## The harvest window (`src-tauri/src/harvest.rs`)

For pages that build themselves in JavaScript, the app opens the URL in a real
window, injects a collector, and the user clicks Capture. This needs
`core:event:allow-emit` granted to that one window for remote URLs
(`capabilities/harvest.json`). Read the module docs before touching it: the
surface is deliberately narrow, and captured URLs are treated as untrusted input
that is only ever *offered* to the user, never acted on.

## Tauri layer (`src-tauri/src/`)

- Split by concern: `volume`, `meta`, `library`, `fetch`, `harvest`, plus
  `settings` and `util`. `lib.rs` is registration only.
- Every command is `async` and does real work inside `spawn_blocking`; probing a
  few hundred image headers blocks the UI thread otherwise. The `blocking()`
  helper in `util.rs` flattens `anyhow::Error` + `JoinError` into the `String`
  the frontend expects.
- The library is opened per request rather than held in app state. SQLite makes
  it cheap, and it keeps every command a plain blocking job with no shared
  mutable state.
- Errors cross IPC as `String`. The frontend shows them verbatim.
- Progress crosses as the `build-progress` event, coalesced (every 4 pages).
- `thumbs.rs` caches JPEG thumbnails under the app cache dir, keyed by
  `path|mtime|len|max` so a replaced page regenerates automatically. FNV-1a,
  explicitly non-cryptographic.
- Downloaded covers go to the **app cache**, never next to the user's files.
- New commands must be added to `generate_handler![…]`. New plugins need their
  permission in `src-tauri/capabilities/default.json`.

## Frontend (`src/`)

- `src/lib/api.ts` and `src/lib/library.ts` are the boundary: every `invoke` and
  every Rust type mirror lives in one of the two. Components import from those,
  never call `invoke` themselves.
- `src/views/` holds the three screens (`LibraryView`, `SeriesView`,
  `EditorView`); `App.tsx` is the router and owns only the volume, scan state
  and the error toast.
- The editor cannot tell whether its volume came from a scanned folder or from
  the library, and must not learn to.
- `@/` aliases `./src` (vite + tsconfig paths).
- shadcn-style primitives in `src/components/ui/`. Tailwind v4 via the Vite
  plugin — no `tailwind.config.js`, theme lives in `src/index.css`.
- State is plain `useState` in `App.tsx` passed down; there is no store and it
  does not need one yet.
- The `Volume` in React state is the source of truth and is sent back whole on
  export. Mutations are immutable rebuilds (`mutate()` in `App.tsx`).
- Images go through `src/lib/thumbs.ts` over the shared gate in
  `src/lib/imagecache.ts`: 6-wide concurrency plus an object-URL memo, driven by
  the IntersectionObserver in `useThumbnail` / `usePreview`. Hundreds of cards
  asking for their own decode would saturate the blocking pool. Call
  `clearThumbnails()` whenever the folder changes.
- Remote previews are fetched **through the backend**, not by pointing an `<img>`
  at the URL, so they carry the same `Referer` the download will.
- Keyboard handlers must bail out on `INPUT` / `TEXTAREA` / `contentEditable`.

## Style

Rust and TypeScript both follow the same comment discipline, and it is the main
thing to preserve when editing: **comments explain the "why", never the "what"**.
A comment that restates the code is noise; a comment recording a trap, a format
requirement, or a rejected alternative is the point. Module-level `//!` docs say
what the module is for and what it deliberately does not do.

Tests are named as sentences describing the behaviour
(`a_tiny_but_correctly_sized_page_is_kept`), not `test_classify_2`.

## Commands

```sh
cargo test                      # unit + end-to-end over a synthetic scrape
cargo clippy --all-targets
cargo build --release           # ./target/release/mangalize

bun install
bun run tauri dev
bun run build                   # tsc --noEmit && vite build
```

Requires rustc >= 1.88 (the pinned `image` version demands it).

The whole library flow is drivable from the terminal, which is much the fastest
way to check a real site's markup:

```sh
mangalize library add "Ichi the Witch"
mangalize library status 1
mangalize library peek "https://…/chapter-7"     # list what a page offers
mangalize library get 1 7 "https://…/chapter-7"
mangalize library build 1 1 -o v01.epub
```

Three integration suites, none of which mock the thing they are testing:

- `crates/mangalize-core/tests/pipeline.rs` — a fixture reproducing real scrape
  quirks (mixed filename schemes, site furniture, a spread, chapter 10),
  asserting on the resulting EPUB/CBZ structure.
- `crates/mangalize-library/tests/library.rs` — a real library folder: add,
  sync, download, delete, reopen, build.
- `crates/mangalize-fetch/tests/fetch.rs` — a real `TcpListener` serving a
  chapter page with lazy-loaded images, a spread, a banner and hotlink
  protection. The failures that actually happen here (range requests, `Referer`
  checks, mislabelled content types) only exist at the HTTP layer, so mocking
  the transport would test nothing.
