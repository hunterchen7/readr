# Readr UI targets for the ADB test harness

Stable selectors — what the harness should look for in the
`uiautomator dump /sdcard/ui.xml` output. Prefer attribute-based
matchers over hard-coded coordinates; the coords change per device
and screen size, the labels don't.

Device we test against: emulator-5554 (sdk_gphone64_arm64, Android 16,
1404 × 1872, density 300). The harness reads `wm size` once at startup
and works in pixel coords.

## Dev launcher (expo-dev-client)

| Screen element | Match by | Action |
|----------------|----------|--------|
| Launcher active | `text == 'DEVELOPMENT SERVERS'` | detect state |
| Active dev-server card | `clickable=true` node **containing** a child with `text` starting with `http://10.0.2.2` | tap to connect |
| "New development server" button | `content-desc == 'New development server'` | rarely needed |
| "Fetch development servers" | `content-desc == 'Fetch development servers'` | unused |

## Library tab

| Screen element | Match by | Notes |
|----------------|----------|-------|
| Library screen marker | `text == 'Library'` | tab strip at bottom: Library / Stats / Settings |
| Jump-back-in card | `content-desc` starts with `'JUMP BACK IN,'` | `content-desc` is `"JUMP BACK IN, <title>, <chapter>, <pct>%"` |
| Read-it-again card | `content-desc` starts with `'READ IT AGAIN?,'` | opens book **detail** screen, not the reader |
| Book cover card (downloaded) | has a child with `content-desc` in (`CONTINUE`, `READ`) | Tap the **card** to jump directly into the reader |
| "CONTINUE" button | `content-desc == 'CONTINUE'` | resumes at saved position |
| "READ" button | `content-desc == 'READ'` | opens at the start (nothing saved) |
| "FINISHED" badge | `content-desc == 'FINISHED'` | card still opens the detail page, not the reader |
| "Download" button | `content-desc == 'Download'` | book not yet on device |
| Bottom tab: Library | `text == 'Library'` |
| Bottom tab: Stats | `text == 'Stats'` |
| Bottom tab: Settings | `text == 'Settings'` |
| Sort dropdown | `content-desc == 'Sort descending'` |
| Filter chips | `content-desc` one of `All`, `Reading`, `Unread`, `Finished`, `Downloaded` |
| Upload | `content-desc == 'Upload book'` |
| Search | `content-desc == 'Search library'` |
| Switch list/grid | `content-desc` starts with `'Switch to '` |
| Sync | `content-desc == 'Sync library'` |

## Reader header (visible only when chrome is toggled on)

| Element | Match by |
|---------|----------|
| TOC button | `content-desc == 'Table of contents'` |
| Bookmark toggle | `content-desc == 'Add bookmark'` or `'Remove bookmark'` |
| Reader settings | `content-desc == 'Reader settings'` |
| Book title (header Text) | first Text with `text` matching the book title |

## Reader progress widget (bottom)

Chrome-on, full widget:

| Element | Match by | Example text |
|---------|----------|--------------|
| Chapter label | `styles.progressLabel` first row | "Chapter 5: Samaritans" |
| Percentage | regex `^\d+\.\d+%$` | "46.9%" |
| Section page | regex `^p\. \d+\/\d+$` | "p. 12/23" |
| Book page | regex `^p\. \d+\/\d+$` (second occurrence) | "p. 149/303" |

Chrome-off, mini progress:

| Mode | Text regex | Example |
|------|------------|---------|
| Verbose | `^p\. \d+\/\d+\s+·\s+\d+\.\d+%$` | "p. 149/303 · 46.6%" |
| Bar | no text (just fill) | — |
| Off | no widget | — |

## Reader settings dropdown

Once `Reader settings` is tapped the dropdown overlays the right half
of the screen. All buttons are `clickable=true` with a `content-desc`:

| Section | Options (`content-desc`) |
|---------|--------------------------|
| Theme | `Light`, `Sepia`, `Canvas`, `Gray`, `Dark`, `Black` |
| Font family | `Default` (+ chevron) |
| Size | `A-`, `A+` |
| Line spacing | `-`, `+` |
| Weight | `Light`, `Regular`, `Medium`, `Bold` |
| Horizontal margin | `-`, `+` |
| Vertical margin | `-`, `+` |
| **Page turn mode** | **`Tap`, `Swipe`, `Both`, `Scroll`** |
| Progress bar | `Off`, `Bar`, `Verbose` |
| Page number | `Page number top left/alternate/right`, `Page number bottom left/alternate/right`, `Off` |
| Tap-to-turn | `content-desc` mentions it only in a toggle row; we read the current value from theme, not the UI |

## TOC drawer

Opens from the left after tapping the TOC button.

| Element | Match by |
|---------|----------|
| Tab: Contents | `text == 'Contents'` |
| Tab: Bookmarks | `text == 'Bookmarks'` |
| Tab: Notes | `text == 'Notes'` |
| Tab: Highlights | `text == 'Highlights'` |
| TOC entry row | `text` equals the chapter label (full text, subtitle included) |
| Go to page button | `content-desc == 'Go to page'` |

## Context menu (on text selection)

| Element | Match by |
|---------|----------|
| Highlight yellow | `content-desc == 'Highlight yellow'` |
| Note | `content-desc == 'Note'` |
| Draw | `content-desc == 'Draw'` |
| Copy | `content-desc == 'Copy'` |
| Define | `content-desc == 'Define'` |
| Lookup provider | `content-desc` equals the provider name (`Google`, `Wikipedia`, …) |

## Interaction patterns

- **Show chrome while reading:** tap screen center. The renderer's tap
  handler posts `tapCenter`; RN toggles `controlsVisible`.
- **Dismiss a drawer/dropdown:** press back (`adb shell input keyevent 4`).
  This does **not** exit the reader — it only closes the overlay.
- **Leave the reader:** press back when no overlay is open. Back lands
  on the previous screen (usually the library).
- **Paginated page-turns:** tap the left/right third of the viewport
  (when `Tap` or `Both` is the page-turn mode) or swipe. The renderer
  only forwards `tapCenter` to RN; left/right taps advance pages
  in-WebView.
- **Scroll:** `input swipe x y x y duration` (big y-delta).

## How to read renderer state from outside

The reader screen renders a hidden `<Text testID="readr-debug">` with
an accessibility label containing every bridge event + a stable
"latest" snapshot. Pipeline for the test harness:

```
<Text content-desc="READR_DEBUG|latest=<json>|toc=<json>|trail=<events>|visible=<text>">
```

- `latest` — last non-transient `progressUpdated` payload (kept even
  when the `trail` rolls off its 8-event window).
- `toc` — the TOC loaded at boot (kept across re-opens).
- `trail` — last 8 bridge events separated by `\u001f` (rendered as
  `.` in the XML dump; events parse by walking matching braces per
  type name).
- `visible` — sample of visible text, up to 400 chars.

This lets ADB-driven tests verify state + compare visible text
*without* running JS in the WebView from outside.
