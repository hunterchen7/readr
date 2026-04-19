# Readr renderer E2E test plan

## Goal

Every user-visible behavior of the reader should be exercised end-to-end
on an emulator via ADB, with **content-level assertions** (not vibes):
either the renderer's state snapshot matches expectations, or the
visible text we read from the debug label matches what it should.

## Harness primitives

The ADB harness already has:

- **`openBookForTesting()`** — from library, taps a CONTINUE/READ card,
  waits for `dbg.latest` to populate.
- **`readReaderState()`** — polls the dev `readr-debug` accessibility
  label until `latest` is present. Returns `{ progress, visible, toc }`.
- **`openSettings()` / `openToc()`** — taps the header icons, returns
  when the sheet is mounted.
- **`setPageTurnMode(mode)`** — taps one of `Tap|Swipe|Both|Scroll`.

Add these primitives (new work):

- **`adjustSetting(label, delta)`** — generic +/- knob, e.g. line
  spacing, horizontal margin, font size. Matches by section label,
  taps `-` `delta` times or `+` `|delta|` times.
- **`selectTheme(name)`** — taps one of the 6 theme chips.
- **`selectFontFamily(name)`** — opens font dropdown, taps the name.
- **`selectWeight(name)`** — taps `Light|Regular|Medium|Bold`.
- **`jumpToChapter(titlePrefix)`** — opens TOC, scrolls the list, taps
  the matching row.
- **`toggleBookmark()`** — taps the bookmark icon; returns the new
  state from `Add bookmark|Remove bookmark` content-desc.
- **`selectText(rect)`** — long-press at a rect, then drag a handle
  across to form a selection. (Text selection is the hardest to
  automate, so we use it sparingly.)
- **`dbQuery(table)`** — pulls sqlite via `adb shell run-as cat` + local
  `sqlite3`, returns rows. For verifying bookmarks/highlights land in
  the DB after UI actions.

## Book fixtures

Three books chosen for orthogonal coverage:

| Fixture | Why |
|---------|-----|
| **Heirs to Forgotten Kingdoms** | Long text-heavy chapters (48-page sections), deeply nested TOC, pre-existing highlights/bookmarks in prod DB — covers CSS scoping, resume precision, highlight replay. |
| **In God's Path** | EPUB with embedded fonts + inline `style="..."` blocks — covers theme !important overrides + font-face loading. |
| **Not My Party** | 20+ TOC entries, many short chapters — covers section-boundary edge cases + TOC scroll. |

Fixtures are picked by title on the library so the harness is
resilient to reordering.

## Test suites

### 1. Boot + render

| # | Name | Assertion |
|---|------|-----------|
| 1.1 | Reader mounts | `latest` populated within 15s of tapping a book card |
| 1.2 | TOC loaded | `toc.chapters.length > 0`, every entry has `label` + `href` |
| 1.3 | Visible text present | `visible.length > 100` on a text chapter |
| 1.4 | Cover renders | Section 0 shows without crashing; image resource resolves (blob URL) |

### 2. Resume

Reset the test book's progress to a known CFI via `sqlite3` injection +
WAL wipe (proven reliable). Every test here is:

1. Inject `{ cfi: X, percentage: Y }` for the test deviceId.
2. Open book.
3. `readReaderState()`.
4. Assert `progress.sectionIndex` matches the CFI's spine index ±0, and
   `percentage` within 2% of `Y`.

| # | Name | Setup |
|---|------|-------|
| 2.1 | Resume mid-chapter | Chapter 5, 47% |
| 2.2 | Resume at chapter start | Chapter 3, 0% of section |
| 2.3 | Resume cover (no progress) | Empty row — lands on section 0 |
| 2.4 | Resume far into book | Last chapter, 95% |
| 2.5 | Close + reopen | Open, navigate to Chapter 3 via TOC, back to library, reopen card → lands on Chapter 3 |

### 3. Mode toggle seamlessness

For each direction:

1. Navigate to a known text-heavy position.
2. Snapshot `{ sectionIndex, percentage, visible.slice(0, 200) }`.
3. Toggle mode via settings.
4. Snapshot again.
5. Assert:
   - `sectionIndex` unchanged.
   - `|pct_after - pct_before| < 2`.
   - `longestCommonSubstring(before.visible, after.visible) >= 40`.

| # | Name | From | To |
|---|------|------|-----|
| 3.1 | scroll → paginated | scroll | both |
| 3.2 | paginated → scroll | both  | scroll |
| 3.3 | 5× cycle | scroll ↔ both | drift < 3 sections, < 5% pct |
| 3.4 | Font-size change in-mode | both | both, A+ 3x | reflow keeps section |

### 4. Page turns (paginated)

Run in paginated (`Both`) mode at a known chapter:

| # | Name | Sequence | Assertion |
|---|------|----------|-----------|
| 4.1 | Tap right advances | tap right zone | `currentPage` += 1 |
| 4.2 | Tap left regresses | tap left zone | `currentPage` -= 1 |
| 4.3 | Swipe right advances | swipe LR | `currentPage` += 1 |
| 4.4 | Swipe left regresses | swipe RL | `currentPage` -= 1 |
| 4.5 | Cross section boundary | repeatedly advance until `sectionIndex` changes | `sectionIndex` += 1, `pageInSection` resets to 1 |
| 4.6 | Tap-to-turn off (Swipe-only) | set mode `Swipe`; tap right → no advance; swipe LR → advance | - |

### 5. Live scroll progress

In scroll mode:

| # | Name | Assertion |
|---|------|-----------|
| 5.1 | `currentPage` advances during scroll | swipe up; `currentPage` is monotonically non-decreasing across 3 consecutive dumps |
| 5.2 | `percentage` advances continuously | after a single swipe, `pct_after - pct_before > 0.05` |
| 5.3 | Section crossing | scroll over a section boundary; `sectionIndex` increments |

### 6. Theme switching

For each of 6 themes (Light, Sepia, Canvas, Gray, Dark, Black):

| # | Name | Assertion |
|---|------|-----------|
| 6.x | Theme N applies | tap theme chip; screenshot; sample 10 pixels in the text area; bg pixel matches expected theme bg; fg pixel matches expected theme fg |

Expected pixel table:

| Theme | bg hex | fg hex |
|-------|--------|--------|
| Light | `#ffffff` | `#111111` |
| Sepia | `#f8f0e3` | `#5b4636` |
| Canvas | `#d4c5a9` | `#3a2e1e` |
| Gray | `#2a2a2a` | `#cccccc` |
| Dark | `#1a1a2e` | `#e0e0e0` |
| Black | `#000000` | `#c8c8c8` |

Pixel assertion: sample at `(center_x, viewport_mid)`, accept ±15 per
channel.

### 7. Typography

| # | Name | Action | Assertion |
|---|------|--------|-----------|
| 7.1 | Font size A+ | tap 3x | in paginated, `totalPages` decreases (fewer words per page = more pages, so actually _increases_); in scroll mode `totalPages` rises too |
| 7.2 | Font size A- | tap 3x | opposite direction |
| 7.3 | Line spacing + | tap 3x | `totalPages` increases; visible text unchanged length |
| 7.4 | Line spacing - | tap 3x | `totalPages` decreases |
| 7.5 | Weight Bold | tap Bold | visible text same; screenshot shows heavier strokes (optional: leave to manual) |
| 7.6 | Each font family | open Default dropdown → pick each; verify layout reflows without crashing, position preserved |

### 8. Margins

| # | Name | Action | Assertion |
|---|------|--------|-----------|
| 8.1 | Horizontal + | tap 3x | text column narrower (screenshot: measure text block width) |
| 8.2 | Horizontal - | tap 3x | text column wider |
| 8.3 | Vertical + (paginated) | tap 3x | top/bottom gap increases; `visible.slice(0,40)` unchanged |
| 8.4 | Vertical - (paginated) | tap 3x | gap decreases |
| 8.5 | Vertical change forces repagination | `totalPages` changes as margin-v changes |

### 9. TOC navigation

| # | Name | Setup | Assertion |
|---|------|-------|-----------|
| 9.1 | Jump to any chapter by label | pick a "Chapter N" entry | `sectionHref` contains entry's href prefix |
| 9.2 | Jump to nested entry | scroll TOC, pick a depth=1 entry | lands on correct section |
| 9.3 | Jump to front-matter (Copyright / Dedication) | - | landed on the correct section |
| 9.4 | Jump to back-matter (Index / Notes) | - | - |
| 9.5 | Jump to Introduction twice | same entry, different times | consistent landing |

### 10. Bookmarks

| # | Name | Action | Assertion |
|---|------|--------|-----------|
| 10.1 | Create bookmark | tap bookmark icon | DB `bookmarks` has a row with current CFI |
| 10.2 | Bookmark icon reflects state | ^ | header icon's content-desc flips `Add bookmark → Remove bookmark` |
| 10.3 | Remove bookmark | tap again | DB row is soft-deleted (`deleted_at` set) |
| 10.4 | Bookmark list in TOC drawer | open TOC → Bookmarks tab | created bookmark appears |
| 10.5 | Jump to bookmark | tap bookmark row | reader navigates to that CFI |

### 11. Highlights

Uses existing foliate-era highlights for the test book (preserved via
CFI compatibility).

| # | Name | Assertion |
|---|------|-----------|
| 11.1 | Existing highlights render | pull N highlight rows from DB; navigate to each; screenshot; assert a colored rect exists in the text area at roughly the expected y |
| 11.2 | New highlight from selection | long-press to select, tap Highlight → yellow; DB row appears; SVG rect drawn |
| 11.3 | Remove highlight | long-press on existing highlight; context menu → Remove; DB tombstoned |

### 12. Progress widget

| # | Name | Action | Assertion |
|---|------|--------|-----------|
| 12.1 | Off mode | settings → Progress bar Off | chrome has no bottom progress UI |
| 12.2 | Bar mode | settings → Bar | mini bar visible when chrome hidden |
| 12.3 | Verbose mode | settings → Verbose | mini widget shows "p. N/M · X.Y%" text |
| 12.4 | Page indicator top-left/alternate/right | each option | indicator appears at the right corner |

### 13. Cross combinations

A compact matrix instead of the full cartesian product. For each
theme ∈ {Light, Sepia, Dark}, for each mode ∈ {scroll, paginated}:

- Open book.
- Apply theme + mode.
- Assert rendered text is the same (within overlap threshold).
- Assert page count is sensible.

Adds 6 tests.

### 14. Edge cases

| # | Name | Assertion |
|---|------|-----------|
| 14.1 | Very short section (cover) | `pagesInSection` ≥ 1; navigation doesn't crash |
| 14.2 | Section with only images | visible text may be empty; no crash; `getPageText` returns `""` |
| 14.3 | Book with JS | scripts stripped by parser; no console error; content renders |
| 14.4 | Book with 0 TOC entries | TOC drawer shows empty list; no crash |
| 14.5 | Rapid-fire taps | 20 taps in 1 second; reader advances sensibly, no ANRs |
| 14.6 | Mode flip in scroll-mid | change mode while mid-scroll; position preserved |

## Orchestration

Each test case is a `{ name, setup?, run, teardown? }` object in the
tests array. `setup` can:

- Reset theme to defaults.
- Inject a known progress row via `sqlite3` (with WAL wipe).
- Navigate to a known chapter.

`teardown` restores defaults.

Tests are grouped; a CLI flag like `--group=6` runs just theme tests.

## Acceptance

- All Suite 1–5 tests pass on every run.
- Suite 6–9 pass on most runs; deterministic once metro is warm.
- Suites 10–14 pass when auth is valid (our dev-token flow covers
  this).

## Out of scope for now

- iOS — harness is Android-only.
- Web (Expo Web export) — same renderer should work but needs its own
  browser-driven harness.
- PDF reader — separate bundle (`pdf.min.mjs`), separate tests.
- TTS + audio — tested manually.
- Offline → online sync race — e2e-unfriendly, covered by sync-engine
  unit tests.
