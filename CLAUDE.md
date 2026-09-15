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
- **A chapter that comes back mostly off-size is re-judged against its own
  norm.** Furniture is a minority *within* a chapter — a banner among twenty
  pages — so "almost all of this chapter is furniture" is never true; it means
  the chapter was ripped at a different size, which is what early chapters of a
  long series usually are. Without this the volume-wide norm silently dropped
  every page of chapter one. There is a test that scans a real fixture.
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
- **`shelved` is what separates the library from history.** Reading something
  from Explore records the series so history and resuming work the same whatever
  the source, but `all_series` only returns what the user chose to add. Adding it
  properly later finds the same row and shelves it; nothing ever demotes one.
- History filters on *reachability*, not on files: a chapter is in it if it was
  opened and can still be opened — pages on disk, or a source id to stream from.
  Filtering on `folder IS NOT NULL` is what kept streamed chapters out entirely.
- A built volume is recorded on the volume row, so the page can offer to share
  the file rather than spend a minute writing an identical one. `volumes` checks
  the file is still there before reporting it, the same way `volumes_missing_covers`
  does — the output folder is the user's and they may tidy it.
- `tags` is a newline-separated string, not a join table. The only questions
  asked of it are "does this series have that tag" and "what tags exist here",
  and a few hundred short strings answer both instantly.
- **`sync_layout` never deletes.** Upstream indexes get re-tagged and re-numbered
  constantly; a chapter the user holds outranks whatever the index now says. It
  is counted as `orphaned` and kept. There is a test.
- Adding a series is idempotent on `(source, source_id)` — searching again for a
  series you already have is something users do constantly.
- `build_volume` scans the *whole* chapters folder and then filters, because the
  page-size norm is more reliable across a series than across one volume.
- Volume cover art is stored in the series folder (`volumes/v1.jpg`), not a
  cache: it is what the shelf shows and should survive going offline.
  `volumes_missing_covers` treats a recorded path whose file has gone as missing,
  so a half-cleaned library heals itself.
- Schema changes need a new step in `schema.rs` and a `CURRENT` bump. A newer
  index than the build understands is refused, never downgraded.

## Getting chapters (`crates/mangalize-fetch`)

Three parts, all driven by a URL the user pastes, and nothing site-specific.

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
- `series.rs` finds the chapter number *inside a URL* and factors it into a
  template, which is what makes batch download possible. A `chapter`-style marker
  wins over a bare digit run, so `/manga/86-chapter-3/` is chapter 3, not 86.
  Only the path is searched — a `?page=2` is not a chapter number.
- `chapter_links` keeps only links matching the **dominant** URL shape on the
  page. That one rule is what separates a chapter list from navigation, related
  series and adverts, without knowing anything about the site.

### The batch rule worth keeping

`plan_batch` is bounded by the library's list of *missing* chapters. It never
crawls outward, and a constructed URL is fetched once to confirm it loads before
being offered. The user then sees the plan and confirms. Anything that would
turn this into an open-ended crawler is a change in kind, not degree.

Batches take chapters one at a time with a pause between them
(`BETWEEN_CHAPTERS` in `src-tauri/src/fetch.rs`). The images come from one host,
usually a small one. A per-chapter failure is recorded and the run continues —
one dead page in chapter 30 must not cost the user chapters 31 to 50.

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

## Spreads

**Spreads are split into two pages by default** (`scan.rs` sets `split = true`
for `PageKind::Spread`). This is not a preference, it is a workaround for how
Kindle behaves: shown a page twice the width of every other one it does not
scale it down to fit, it picks a region and zooms, so the reader sees half a
drawing with no indication there is more. Two ordinary pages always read
correctly. Verified on a real device after the fit-to-canvas approach failed
there while looking fine in desktop EPUB readers.

- Right half first for right-to-left titles — see `render_page`.
- `S` in the editor rejoins one; the `split_spreads` setting turns it off
  wholesale; the CLI has `--keep-spreads`.
- Split halves are re-encoded, so `SPLIT_QUALITY` (92) matters. The encoder
  default of 75 visibly mushes screentones and inked edges, and now that
  splitting is the default path every spread goes through it.
- The uniform-canvas rule in `epub.rs` still stands and is still tested: no page
  may declare a viewport wider than `original-resolution`. It is what keeps a
  deliberately-unsplit spread fitted rather than cut.

## Settings and build output

- `src-tauri/src/settings.rs` owns all configuration, stored as one JSON file in
  the app config dir. Every field on disk is optional so an older file still
  loads; defaults are applied on read.
- `welcomed` is separate from `output_root` being set, because "decide later" is
  a valid answer that must not re-prompt on every launch.
- **Naming lives in `volume.rs`**, not the UI: `build_path` gives
  `<output>/<Series>/<Series v01.epub>`, and `file_stem` pads to `v01` so `v2`
  sorts before `v10`. A one-off "Build as…" and an unattended batch must produce
  byte-identical names, which only holds while there is one implementation.
- `safe_component` replaces path separators with dashes, so a series title can
  never become a nested or parent path. There are tests for `..` and for titles
  made only of dots, which would otherwise name a real directory.
- Batch building happens entirely in the backend (`build_library_volumes`).
  Shipping a `Volume` per item across IPC just to send it straight back would
  move a lot of page metadata for nothing. A failed volume is recorded and the
  batch continues.

## Releases and the updater

- Two entry points: run the workflow with a version (CI bumps, commits, tags,
  builds, publishes), or push a `v*` tag yourself. For a hand-pushed tag the tag
  and `version` in `src-tauri/tauri.conf.json` **must** match; CI enforces it.
- **Bump, tag and build happen in one run on purpose.** A tag pushed with
  `GITHUB_TOKEN` does not trigger another workflow, so the obvious "tag here,
  build over there" split silently produces no release at all.
- Releases publish immediately, so the `check` job (tests, frontend build,
  `clippy -D warnings`) gates the tag rather than following it. Tagging first and
  failing after leaves a pushed tag with no release.
- **The platform matrix runs `max-parallel: 1` on purpose.** tauri-action creates
  the release when it cannot find one for the tag, so running the platforms
  together means both look at once, both find nothing, and both create one —
  two release objects on one tag, half the installers on each, and a
  `latest.json` naming only whichever won. v1.8.0 did this, 0.7s apart, and
  Windows silently got no installer and no update. Serialised, the second job
  finds the first one's release and merges into its `latest.json`.
- The APK is attached with `gh release upload`, not an action. softprops takes
  the tag it updates from `github.ref`, which on a `workflow_dispatch` run is
  `refs/heads/main` — it finds the release and then fails trying to rename it to
  a branch.
- Running the workflow with an empty version builds installers as artifacts and
  releases nothing — use it to test CI changes.
- `updaterJsonPreferNsis: true` in the workflow is load-bearing. Both a `.msi`
  and an NSIS `.exe` are built, and tauri-action otherwise points `latest.json`
  at the `.msi`, whose installer needs elevation and so prompts for UAC on every
  update.
- `createUpdaterArtifacts: true` in `tauri.conf.json` is what produces the `.sig`
  files. Without it the release builds fine and updates silently never work.
- macOS ships a universal binary (`--target universal-apple-darwin`), so the
  runner needs both `aarch64-` and `x86_64-apple-darwin` Rust targets.
- The updater keypair is *not* OS code signing. The private key lives only on the
  maintainer's machine and in GitHub Secrets; `pubkey` in `tauri.conf.json` is
  the public half and is meant to be committed. Losing the private key strands
  every installed copy.
- The startup check is silent by design (`useUpdater`): it fails in dev, offline,
  and in any build not installed from a release. Only an explicit check reports
  errors.

## Android

The app ships from the same Rust and the same React. What differs is gated, not
forked.

### What is gated, and why

| Gone on Android | Reason |
| --- | --- |
| Send to Kindle | `keyring` has no Android backend, so there is nowhere safe to keep the SMTP password. `send.rs` is `#[cfg(desktop)]` and the command returns `UNAVAILABLE`. |
| The harvest window | It needs a second webview. Android has one. Pages that build themselves in JavaScript can only be reached by reading their markup. |
| Folder pickers | Android sandboxes app storage. The library and the build folder both live in `app_data_dir()`; reaching outside needs a document picker this app has no use for. |
| Reveal in Finder | No file manager to reveal into. |
| The Tauri updater | No Android implementation. Naming `updater:default` in a shared capability is what broke the first Android build — hence `capabilities/desktop.json` and its `platforms` field. Android updates itself instead; see below. |
| Drag and drop | Nothing to drag from. |

The frontend asks `src/lib/platform.ts`, which reads the user agent. It hides
affordances rather than letting them fail: a button that opens a folder picker
Android does not have is worse than no button, because it looks like something
that should work.

### Exporting

Building works and is the point, so the output has to be reachable. It goes to
`download_dir()`, which on Android is the app's *external* files directory —
no permission, visible over USB — rather than `app_data_dir()`, where the
library lives and nothing else can see it. `output_root` is re-resolved on every
`load` there instead of being read from the settings file, because with no
folder picker a stale stored path would be uncorrectable.

Getting the file into another app is `export.rs` plus `SharePlugin.kt`: one
command, one file, and the system share sheet picks the destination.
`tauri-plugin-opener` cannot do this — on Android it only knows how to open a
URL — and handing out a `file://` path instead of the FileProvider's
`content://` one throws `FileUriExposedException`. The paths the provider will
hand out are listed in `res/xml/file_paths.xml`; a build written outside all of
them fails at the share, not at the build.

### Four things that are not obvious

**`env(safe-area-inset-*)` does not do what it does on iOS.** Android's WebView
only ever reports a *display cutout* through it, never the status bar or the
gesture bar. On a phone without a notch every inset reads zero and the app draws
its header under the clock. The insets are offered to the view hierarchy
instead, so `MainActivity.kt` takes them there and pads the window the WebView
lives in. The web side then knows nothing about it.

**16 KB pages.** Android 15 devices use them, and a shared library linked for
4 KB ones loads in a compatibility mode behind a system dialog telling the user
the app is broken. `/.cargo/config.toml` passes `-Wl,-z,max-page-size=16384` for
the four Android targets. Check it with:

```sh
llvm-readelf -l target/aarch64-linux-android/release/libmangalize_app.so | grep LOAD
```

The alignment column must read `0x4000`. The emulator image to test on is the
one whose name contains `16k`.

**The library is opened once per request, so the first launch races itself.**
Several commands hit an empty index at the same time, and before `migrate` took
the write lock up front they all read version 0 and all ran the initial schema —
the losers failing with "table series already exists" and leaving a half-built
index every later open tripped over. Android is what surfaced it, being slow
enough to lose the race every time. Setting `journal_mode` is part of the same
story and is *not* retried: it needs exclusive access and fails rather than
waiting, so it is only attempted when the file is not already in WAL, and losing
is fine because the mode belongs to the file.

**The back button closes the app unless something listens.** Tauri only forwards
it to the webview if a listener is registered, and otherwise finishes the
activity — from any screen, including the middle of a chapter. `App.tsx`
registers `onBackButtonPress` and answers it with `backFrom(view)`, the same
function shape the in-app back buttons use, so the two can never disagree about
where back goes.

### `src-tauri/gen/android` is committed

Generated, but not entirely: `MainActivity.kt` and the manifest are ours and
`tauri android init` leaves them alone. Committing the project means those edits
survive a fresh checkout. Only build output is ignored. Everything under
`app/src/main/java/dev/mangalize/app/generated/` is Tauri's and is rewritten on
every build — do not edit it.

### Updating a sideloaded build

"A phone updates through whatever store installed it" is no answer for an APK
the user sideloaded, so `update.rs` asks GitHub for the latest release,
downloads the APK and hands it to Android's package installer.

The install is never silent, and that is the guarantee: the system asks, and it
refuses an APK signed with a different key than the installed one. That is what
the desktop updater's signature check buys, enforced by the OS instead.

Two things learned from watching it run on a device:

- A device that has not allowed installs from this app gets sent to the settings
  screen that allows it. The update offer has to *survive* that failure — the
  user is expected to grant permission and come back — so a failed install
  returns to `available`, never `error`.
- Play Protect interposes its own dialog for an app it has not seen. There is
  nothing to do about that from inside the app, and "Install without scanning"
  is behind "More details".

### Building

```sh
scripts/android.sh              # signed release APK at target/mangalize-release.apk
scripts/android.sh install      # … and push it to the running device
scripts/android.sh logs         # follow the app's log, web console included
```

Signing lives in that script rather than in `app/build.gradle.kts` because that
file *is* regenerated. The keystore is outside the repo — `~/.mangalize/` by
default, overridable with `MANGALIZE_KEYSTORE`.

The default keystore is a local one with a throwaway password, good for putting
a build on a device you own and nothing else. An Android app's signing key is
its identity: publish with that one and anyone who reads `scripts/android.sh`
can sign an update phones will accept as yours. Generate a real keystore, keep
it somewhere it cannot be lost — a key that changes cannot update an installed
app — and point `MANGALIZE_KEYSTORE` at it.

Needs `ANDROID_HOME`, an NDK, and a JDK; the script finds the newest NDK and
build-tools installed rather than pinning a version. Android Studio's bundled
JBR works as `JAVA_HOME`.

CI runs the same script, which is the point of it being a script: the release
job sets `MANGALIZE_KEYSTORE*` from repository secrets and nothing about how a
build is signed differs between a runner and a laptop. The APK is arm64 only —
building the other three ABIs would triple the job for an APK nobody installs —
and it is attached to the release the desktop job already created, which is why
`android` needs `build` rather than running beside it.

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
mangalize library batch 1 "https://…/chapter-1" --dry-run   # show the plan only
mangalize library batch 1 "https://…/chapter-1"
mangalize library build 1 1 -o v01.epub
```

`batch --dry-run` is the fastest way to find out whether a site's URL shape is
one the detector understands, and it downloads nothing.

Three integration suites, none of which mock the thing they are testing:

- `crates/mangalize-core/tests/pipeline.rs` — a fixture reproducing real scrape
  quirks (mixed filename schemes, site furniture, a spread, chapter 10),
  asserting on the resulting EPUB/CBZ structure.
- `crates/mangalize-library/tests/library.rs` — a real library folder: add,
  sync, download, delete, reopen, build.
- `crates/mangalize-fetch/tests/fetch.rs` — a real `TcpListener` serving a
  chapter page with lazy-loaded images, a spread, a banner and hotlink
  protection, plus a numbered chapter run that 404s past its last chapter. The
  failures that actually happen here (range requests, `Referer` checks,
  mislabelled content types, chapters the site does not have) only exist at the
  HTTP layer, so mocking the transport would test nothing.
