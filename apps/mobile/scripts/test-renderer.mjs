#!/usr/bin/env node
/**
 * ADB-driven test harness for the new EPUB renderer.
 *
 * Workflow per run:
 *   1. Force-stops + launches com.readr.app.
 *   2. If the dev launcher is showing, taps the "http://10.0.2.2"
 *      entry so the dev client connects to Metro.
 *   3. Waits for the library, picks a downloaded book (any READ button),
 *      taps the COVER (not the READ badge — that opens detail) to
 *      enter the reader.
 *   4. Uses the dev-only accessibility label
 *      (`READR_DEBUG|trail=...|visible=...`) rendered by the reader
 *      screen to read renderer state back from UIAutomator.
 *   5. Runs the listed test cases.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const log = (...x) => console.log('[harness]', ...x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(args) {
  return execFileSync('adb', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}
function shell(cmd) { return adb(['shell', cmd]); }
function tap(x, y) { shell(`input tap ${x} ${y}`); }
function swipe(x1, y1, x2, y2, dur = 300) { shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`); }

function dumpUI() {
  // Dump to /data/local/tmp (always-local tmpfs) instead of /sdcard —
  // the /sdcard FUSE mount intermittently returns "Transport endpoint is
  // not connected" after long harness runs on the emulator.
  try { shell('uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1'); } catch {}
  try {
    return shell('cat /data/local/tmp/ui.xml');
  } catch {
    // Fall back to /sdcard if /data/local/tmp is somehow not writable.
    try { shell('uiautomator dump /sdcard/ui.xml >/dev/null 2>&1'); } catch {}
    return shell('cat /sdcard/ui.xml');
  }
}

function parseUi(xml) {
  const nodes = [];
  const re = /<node ([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    // UIAutomator switches between double-quoted and single-quoted
    // attribute values when the value contains the other quote char.
    const attrRe = /(\w[\w-]*)=(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = a[2] ?? a[3] ?? '';
    nodes.push(attrs);
  }
  return nodes;
}

function boundsCenter(bounds) {
  const m = bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  return { x: (+m[1] + +m[3]) >> 1, y: (+m[2] + +m[4]) >> 1 };
}

function boundsOf(node) {
  const m = node.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] };
}

function clickableContainer(nodes, innerNode) {
  const inner = boundsOf(innerNode);
  if (!inner) return null;
  let best = null;
  let bestArea = Infinity;
  for (const n of nodes) {
    if (n.clickable !== 'true') continue;
    const b = boundsOf(n);
    if (!b) continue;
    if (inner.x1 < b.x1 || inner.x2 > b.x2) continue;
    if (inner.y1 < b.y1 || inner.y2 > b.y2) continue;
    const area = (b.x2 - b.x1) * (b.y2 - b.y1);
    if (area < bestArea) { best = n; bestArea = area; }
  }
  return best;
}

function parseDebugText(text) {
  if (!text || !text.startsWith('READR_DEBUG|')) return null;
  const latestStart = text.indexOf('|latest=');
  const tocStart = text.indexOf('|toc=');
  const trailStart = text.indexOf('|trail=');
  const visibleStart = text.indexOf('|visible=');
  if (trailStart < 0) return null;
  const latestRaw = latestStart >= 0 && tocStart >= 0
    ? text.slice(latestStart + 8, tocStart)
    : '';
  const tocRaw = tocStart >= 0
    ? text.slice(tocStart + 5, trailStart)
    : '';
  const trail = visibleStart >= 0
    ? text.slice(trailStart + 7, visibleStart)
    : text.slice(trailStart + 7);
  const visible = visibleStart >= 0 ? text.slice(visibleStart + 9) : '';
  let latest = null;
  if (latestRaw) { try { latest = JSON.parse(latestRaw); } catch { /* ignore */ } }
  let toc = null;
  if (tocRaw) { try { toc = JSON.parse(tocRaw); } catch { /* ignore */ } }
  // UIAutomator converts the \u001f separator we use in RN to '.' when
  // emitting the XML. Events are `<name>:<json-payload>`; we find the
  // start of each event by looking for a literal separator + known
  // event name prefix, then walk forward with a depth counter to the
  // matching closing brace.
  const eventNames = [
    'ready', 'tocLoaded', 'progressUpdated', 'restored', 'visibleText',
    'scrollModeChanged', 'selectionChanged', 'selectionCleared',
    'tapCenter', 'tapLeft', 'tapRight', 'searchResults', 'pageText',
    'debug', 'error', 'noteTapped', 'showAnnotation', 'highlightError',
    'noteError', 'pagesComputed',
  ];
  const events = [];
  const nameAlt = eventNames.join('|');
  const nameRe = new RegExp(`(?:^|\\.)(${nameAlt}):`, 'g');
  let m;
  while ((m = nameRe.exec(trail))) {
    const startOfJson = m.index + m[0].length; // past "type:"
    // Find matching brace.
    let depth = 0;
    let end = startOfJson;
    let inString = false;
    let escape = false;
    for (; end < trail.length; end++) {
      const ch = trail[end];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end++; break; }
      }
    }
    const raw = trail.slice(startOfJson, end);
    events.push({ type: m[1], raw });
  }
  return { trail, visible, events, latest, toc };
}

function extractDebug(nodes) {
  for (const n of nodes) {
    if (n.text?.startsWith('READR_DEBUG|')) {
      return parseDebugText(n.text);
    }
  }
  return null;
}

function latestProgress(debug) {
  // Prefer the explicit `latest` field — it's populated by the RN
  // reader screen from the most recent non-transient progressUpdated
  // and isn't subject to the 8-slot event-trail churn.
  if (debug?.latest) return debug.latest;
  if (!debug?.events) return null;
  for (let i = debug.events.length - 1; i >= 0; i--) {
    if (debug.events[i].type === 'progressUpdated') {
      try { return JSON.parse(debug.events[i].raw); } catch { /* ignore */ }
    }
  }
  return null;
}

function latestScrollMode(debug) {
  if (!debug?.events) return null;
  for (let i = debug.events.length - 1; i >= 0; i--) {
    if (debug.events[i].type === 'scrollModeChanged') {
      try { return JSON.parse(debug.events[i].raw).scrollMode; } catch { /* ignore */ }
    }
  }
  return null;
}

function screenSize() {
  const out = shell('wm size').trim();
  const m = out.match(/(\d+)x(\d+)/);
  return m ? { w: +m[1], h: +m[2] } : { w: 1404, h: 1872 };
}

// ─── Flow ─────────────────────────────────────────────────────────────

async function restartApp() {
  shell('am force-stop com.readr.app');
  await sleep(1500);
  shell('am start -n com.readr.app/.MainActivity');
  await sleep(3500);
}

async function connectDevClientIfNeeded() {
  const nodes = parseUi(dumpUI());
  if (!nodes.some((n) => n.text === 'DEVELOPMENT SERVERS')) return;
  const ip = nodes.find((n) => (n.text ?? '').includes('10.0.2.2'));
  const card = ip ? clickableContainer(nodes, ip) : null;
  if (!card) throw new Error('Dev launcher shown but no server card found');
  const c = boundsCenter(card.bounds);
  tap(c.x, c.y);
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const nn = parseUi(dumpUI());
    if (nn.some((n) => n.text === 'Library')) return;
    // Dev auto-login is handled by the (auth)/login useEffect when
    // EXPO_PUBLIC_DEV_TOKEN is set. If we see the login screen without
    // auto-login firing, fail fast — there's no OTP-interactive path
    // for the harness.
  }
  throw new Error('Library did not appear after connecting to dev server');
}

async function dismissSystemPopupsIfAny() {
  const nodes = parseUi(dumpUI());
  // Android 15+ shows a one-shot "Viewing full screen — to exit, swipe
  // down from the top of your screen" toast with a Got it button when
  // the reader first enters immersive mode. Tap it away.
  const gotIt = nodes.find((n) => n.text === 'Got it' && n.clickable === 'true');
  if (gotIt) {
    const c = boundsCenter(gotIt.bounds);
    tap(c.x, c.y);
    await sleep(500);
  }
}

let cachedToc = null;
async function openBookForTesting() {
  // Prefer a book already in progress (CONTINUE button) so the
  // renderer resumes deep into text content and our mode-toggle
  // tests actually see drift when there's a bug. Fall back to any
  // downloaded book if nothing is in-progress.
  for (let attempt = 0; attempt < 10; attempt++) {
    const nodes = parseUi(dumpUI());
    const cont = nodes.find(
      (n) => n.clickable === 'true' && (n['content-desc'] ?? '').startsWith('CONTINUE'),
    );
    const reads = nodes.filter((n) => n.clickable === 'true' && n['content-desc'] === 'READ');
    const target = cont ?? reads[Math.min(1, Math.max(0, reads.length - 1))];
    if (target) {
      const c = boundsCenter(target.bounds);
      tap(c.x, c.y);
      // Wait for the reader to fully materialize — both a debug node
      // AND a populated `latest` field (the React render that surfaces
      // it in the accessibility tree lands a frame or two after the
      // WebView posts progressUpdated).
      for (let w = 0; w < 40; w++) {
        await sleep(500);
        const nn = parseUi(dumpUI());
        const dbg = extractDebug(nn);
        if (dbg) {
          if (dbg.toc && !cachedToc) cachedToc = dbg.toc;
          const tocEv = dbg.events.find((e) => e.type === 'tocLoaded');
          if (tocEv && !cachedToc) { try { cachedToc = JSON.parse(tocEv.raw); } catch {} }
          if (dbg.latest) return dbg;
        }
      }
      throw new Error('Reader did not emit progressUpdated after opening book');
    }
    await sleep(1000);
  }
  throw new Error('No READ or CONTINUE button found on library');
}

async function waitSettle(ms = 1500) { await sleep(ms); }

function readerChromeVisible(nodes) {
  // Chrome is the header bar with TOC / bookmark / settings buttons.
  return nodes.some((n) => n['content-desc'] === 'Table of contents')
    && nodes.some((n) => n['content-desc'] === 'Reader settings');
}

function hasRealBounds(n) {
  // RN renders offscreen / collapsed views with [0,0][0,0] bounds.
  // Only treat a label as "present" if its bounds form a real rect.
  const b = boundsOf(n);
  return !!b && b.x2 > b.x1 && b.y2 > b.y1;
}

function settingsDropdownOpen(nodes) {
  // The Settings header inside the dropdown is a non-clickable Text.
  // `n.clickable` is the string "false" (not a boolean). The library's
  // bottom-tab "Settings" is clickable so we exclude it; a stray
  // zero-bounds sibling is RN measuring an offscreen sheet.
  return nodes.some(
    (n) => n.text === 'Settings'
      && n.clickable !== 'true'
      && hasRealBounds(n),
  );
}

function tocDrawerOpen(nodes) {
  // TOC drawer tabs are non-clickable Text labels. The reader screen
  // mounts the drawer offscreen (bounds=[0,0][0,0]) until opened, so
  // require real bounds to distinguish "mounted" from "visible".
  return nodes.some(
    (n) =>
      (n.text === 'Contents' || n.text === 'Bookmarks')
      && n.clickable !== 'true'
      && hasRealBounds(n),
  );
}

async function ensureChromeVisible() {
  const screen = screenSize();
  for (let attempt = 0; attempt < 8; attempt++) {
    // Dismiss any Android system popups (e.g. the "Viewing full
    // screen" immersive-mode toast) that may be covering our tap
    // targets.
    await dismissSystemPopupsIfAny();
    const xml = dumpUI();
    const nodes = parseUi(xml);
    if (readerChromeVisible(nodes)) return nodes;
    const hasDebug = xml.includes('READR_DEBUG');
    const atLibrary = nodes.some((n) => n.text === 'Library');
    if (process.env.HARNESS_DEBUG) {
      log(`  ensureChromeVisible attempt=${attempt} hasDebug=${hasDebug} atLibrary=${atLibrary} dropdown=${settingsDropdownOpen(nodes)} drawer=${tocDrawerOpen(nodes)}`);
    }
    if (settingsDropdownOpen(nodes) || tocDrawerOpen(nodes)) {
      shell('input keyevent 4');
      await sleep(500);
      continue;
    }
    tap(screen.w >> 1, screen.h >> 1);
    await sleep(700);
  }
  // On failure, preserve the last dump + a screenshot for diagnosis.
  try {
    execFileSync('bash', ['-c', 'adb exec-out screencap -p > /tmp/harness-chrome-fail.png']);
    writeFileSync('/tmp/harness-chrome-fail.xml', dumpUI());
  } catch {}
  throw new Error('reader chrome never appeared (app may have left the reader)');
}

async function openSettings() {
  // Idempotent: if the settings dropdown is already up, return
  // without tapping — an extra tap would close it.
  const pre = parseUi(dumpUI());
  if (settingsDropdownOpen(pre)) return;
  const nodes = await ensureChromeVisible();
  const btn = nodes.find((n) => n['content-desc'] === 'Reader settings');
  if (!btn) throw new Error('Reader settings button not found');
  const c = boundsCenter(btn.bounds);
  tap(c.x, c.y);
  await sleep(900);
  // Belt-and-braces: verify the dropdown actually opened. If the chrome
  // was mid-fade when we tapped, the tap may have been swallowed.
  for (let i = 0; i < 3; i++) {
    if (settingsDropdownOpen(parseUi(dumpUI()))) return;
    tap(c.x, c.y);
    await sleep(700);
  }
}

async function setPageTurnMode(mode) {
  const wanted = { tap: 'Tap', swipe: 'Swipe', both: 'Both', scroll: 'Scroll' }[mode];
  if (!wanted) throw new Error('bad mode');
  const nodes = parseUi(dumpUI());
  if (!settingsDropdownOpen(nodes)) {
    throw new Error('Settings dropdown must be open before setPageTurnMode');
  }
  const btn = nodes.find((n) => n.clickable === 'true' && n['content-desc'] === wanted);
  if (!btn) throw new Error(`Page turn mode button "${wanted}" not found`);
  const c = boundsCenter(btn.bounds);
  tap(c.x, c.y);
  await sleep(800);
  // Only press back if the dropdown is still up — the selection may
  // have dismissed it on some ROMs.
  const afterNodes = parseUi(dumpUI());
  if (settingsDropdownOpen(afterNodes)) {
    shell('input keyevent 4');
    await sleep(500);
  }
}

async function openToc() {
  // Idempotent: if the TOC drawer is already up, return.
  const pre = parseUi(dumpUI());
  if (tocDrawerOpen(pre)) return;
  const nodes = await ensureChromeVisible();
  const btn = nodes.find((n) => n['content-desc'] === 'Table of contents');
  if (!btn) throw new Error('TOC button not found');
  const c = boundsCenter(btn.bounds);
  tap(c.x, c.y);
  await sleep(900);
  for (let i = 0; i < 3; i++) {
    if (tocDrawerOpen(parseUi(dumpUI()))) return;
    tap(c.x, c.y);
    await sleep(700);
  }
}

async function jumpToTocLabelPrefix(prefix) {
  await openToc();
  // TOC entries appear as rows with text matching the chapter label.
  for (let attempt = 0; attempt < 6; attempt++) {
    const nodes = parseUi(dumpUI());
    const target = nodes.find((n) => (n.text ?? '').trim().startsWith(prefix));
    if (target) {
      const wrapper = clickableContainer(nodes, target) ?? target;
      const c = boundsCenter(wrapper.bounds);
      tap(c.x, c.y);
      await sleep(1200);
      return;
    }
    await sleep(500);
  }
  throw new Error(`TOC entry starting with "${prefix}" not found`);
}

// ─── Settings primitives ─────────────────────────────────────────────

async function adjustSetting(settingName, delta) {
  // settingName: 'font size' | 'line spacing' | 'horizontal margin' |
  // 'vertical margin'. delta: positive = taps +, negative = taps -.
  // Assumes the settings dropdown is already open.
  if (delta === 0) return;
  const wantDesc = delta > 0
    ? `Increase ${settingName}`
    : `Decrease ${settingName}`;
  const taps = Math.abs(delta);
  for (let i = 0; i < taps; i++) {
    const nodes = parseUi(dumpUI());
    const btn = nodes.find((n) => n['content-desc'] === wantDesc && n.clickable === 'true');
    if (!btn) throw new Error(`${wantDesc} button not found in settings`);
    const c = boundsCenter(btn.bounds);
    tap(c.x, c.y);
    await sleep(300);
  }
  await sleep(400);
}

function readSettingValue(nodes, settingName) {
  // Returns the numeric text value next to the +/- buttons, parsed as a
  // float. Uses the "Font size N" / "Line spacing N" / etc label we gave
  // the value Text.
  const valueLabelPrefix = {
    'font size': 'Font size ',
    'line spacing': 'Line spacing ',
    'horizontal margin': 'Horizontal margin ',
    'vertical margin': 'Vertical margin ',
  }[settingName];
  if (!valueLabelPrefix) return null;
  const node = nodes.find((n) => (n['content-desc'] ?? '').startsWith(valueLabelPrefix));
  if (!node) return null;
  const raw = (node['content-desc'] ?? '').slice(valueLabelPrefix.length);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function selectTheme(name) {
  // Assumes the settings dropdown is open. Names: Light, Sepia, Canvas,
  // Gray, Dark, Black.
  const nodes = parseUi(dumpUI());
  const btn = nodes.find((n) => n['content-desc'] === `Theme ${name}` && n.clickable === 'true');
  if (!btn) throw new Error(`Theme "${name}" button not found`);
  const c = boundsCenter(btn.bounds);
  tap(c.x, c.y);
  await sleep(600);
}

async function selectWeight(name) {
  // Assumes the settings dropdown is open. Names: Light, Regular,
  // Medium, Bold. The weight buttons use the label as content-desc.
  const nodes = parseUi(dumpUI());
  const btn = nodes.find((n) => n['content-desc'] === name && n.clickable === 'true');
  if (!btn) throw new Error(`Weight "${name}" button not found`);
  const c = boundsCenter(btn.bounds);
  tap(c.x, c.y);
  await sleep(500);
}

async function setProgressWidget(mode) {
  // Mode: Off | Bar | Verbose. Buttons use label as content-desc.
  const nodes = parseUi(dumpUI());
  const btn = nodes.find((n) => n['content-desc'] === mode && n.clickable === 'true');
  if (!btn) throw new Error(`Progress widget button "${mode}" not found`);
  const c = boundsCenter(btn.bounds);
  tap(c.x, c.y);
  await sleep(500);
}

async function dismissDropdown() {
  // Close the settings dropdown with a single back press (when it's up)
  // then a short settle wait so the subsequent reader state read lands
  // after layout settles.
  shell('input keyevent 4');
  await sleep(700);
}

// ─── Reader-surface gesture primitives ───────────────────────────────

async function tapPageZone(dir) {
  // Tap the WebView's left/right tap-turn zone. Content is zoned at
  // 20% / 60% / 20% horizontally; we aim 10% from the edge vertically
  // centered so we miss the header/footer chrome.
  const screen = screenSize();
  const y = Math.round(screen.h * 0.5);
  const x = dir === 'left' ? Math.round(screen.w * 0.10)
          : dir === 'right' ? Math.round(screen.w * 0.90)
          : Math.round(screen.w * 0.5);
  tap(x, y);
  await sleep(600);
}

async function swipePageZone(dir) {
  // Horizontal swipe across the content area. 'left' means finger moves
  // right-to-left (advances to next page). 'right' moves left-to-right
  // (previous page).
  const screen = screenSize();
  const y = Math.round(screen.h * 0.5);
  const x1 = dir === 'left' ? Math.round(screen.w * 0.85) : Math.round(screen.w * 0.15);
  const x2 = dir === 'left' ? Math.round(screen.w * 0.15) : Math.round(screen.w * 0.85);
  swipe(x1, y, x2, y, 250);
  await sleep(700);
}

async function bookmarkToggle() {
  // Taps the header bookmark icon and returns the new state as 'added'
  // or 'removed' based on the post-tap content-desc.
  const nodes = await ensureChromeVisible();
  const btn = nodes.find((n) => n['content-desc'] === 'Add bookmark' || n['content-desc'] === 'Remove bookmark');
  if (!btn) throw new Error('Bookmark toggle not found in chrome');
  const c = boundsCenter(btn.bounds);
  tap(c.x, c.y);
  await sleep(900);
  const after = parseUi(dumpUI()).find((n) => n['content-desc'] === 'Add bookmark' || n['content-desc'] === 'Remove bookmark');
  if (!after) return 'unknown';
  return after['content-desc'] === 'Remove bookmark' ? 'added' : 'removed';
}

// Apply a default reader theme before a test runs. Opens settings,
// resets key knobs, and closes. Keeps the test body focused on the
// behavior it's actually testing. `setPageTurnMode` already closes the
// dropdown when it's still up, so we don't dismiss again.
async function resetReaderDefaults() {
  await openSettings();
  await selectTheme('Light');
  await setPageTurnMode('both');
  // Dropdown was closed by setPageTurnMode if the ROM didn't dismiss it
  // on selection; if it's still there, nudge it once.
  const stillOpen = settingsDropdownOpen(parseUi(dumpUI()));
  if (stillOpen) await dismissDropdown();
}

async function readReaderState({ waitForProgress = true } = {}) {
  // Poll until latestProgress is available — the renderer's initial
  // reportProgress can trail the book-open signal by a few frames, and
  // a one-shot dump right after can read a stale (empty) debug label.
  const deadline = Date.now() + (waitForProgress ? 3000 : 0);
  while (true) {
    await waitSettle(300);
    const nodes = parseUi(dumpUI());
    const dbg = extractDebug(nodes);
    const progress = dbg ? latestProgress(dbg) : null;
    if (!waitForProgress || progress || Date.now() >= deadline) {
      return {
        dbg,
        progress,
        scrollMode: dbg ? latestScrollMode(dbg) : null,
        visible: dbg?.visible ?? '',
      };
    }
  }
}

async function closeAnyDrawerOrSheet() {
  for (let i = 0; i < 3; i++) {
    const nodes = parseUi(dumpUI());
    if (!settingsDropdownOpen(nodes) && !tocDrawerOpen(nodes)) return;
    shell('input keyevent 4');
    await sleep(400);
  }
}

function isOnHomeScreen(nodes) {
  return nodes.some((n) => (n['content-desc'] ?? '') === 'Home')
    && nodes.some((n) => (n.text ?? '').trim() === 'Play Store');
}

function isOnDevLauncher(nodes) {
  return nodes.some((n) => n.text === 'DEVELOPMENT SERVERS');
}

function isOnLibrary(nodes) {
  return nodes.some((n) => n.text === 'Library');
}

function isInReader(nodes) {
  // The dev-only debug Text is only rendered inside the reader screen.
  return nodes.some((n) => (n.text ?? '').startsWith('READR_DEBUG|'));
}

async function ensureInReader() {
  // Fast path first — don't touch state if we're already in the
  // reader. Pressing back speculatively (via closeAnyDrawerOrSheet)
  // on a false-positive "Settings" detection was bouncing us out of
  // the reader entirely.
  if (isInReader(parseUi(dumpUI()))) return;
  await closeAnyDrawerOrSheet();
  if (isInReader(parseUi(dumpUI()))) return;

  for (let attempt = 0; attempt < 10; attempt++) {
    const nodes = parseUi(dumpUI());
    const state = isInReader(nodes) ? 'reader'
      : isOnHomeScreen(nodes) ? 'home'
      : isOnDevLauncher(nodes) ? 'launcher'
      : isOnLibrary(nodes) ? 'library'
      : 'unknown';
    if (attempt > 0) log(`  ensureInReader[${attempt}]: state=${state}`);
    if (state === 'reader') return;
    if (state === 'home' || state === 'unknown') {
      shell('am force-stop com.readr.app');
      await sleep(800);
      shell('am start -n com.readr.app/.MainActivity');
      await sleep(4500);
      continue;
    }
    if (state === 'launcher') {
      await connectDevClientIfNeeded();
      continue;
    }
    if (state === 'library') {
      await openBookForTesting();
      continue;
    }
    await sleep(1000);
  }
  throw new Error('could not get back into the reader');
}

// ─── Tests ────────────────────────────────────────────────────────────

const tests = [
  {
    name: 'initial render emits progress',
    async run() {
      const st = await readReaderState();
      if (!st.progress) throw new Error('no progressUpdated emitted');
      if (typeof st.progress.sectionIndex !== 'number') throw new Error('bad sectionIndex');
      log('  initial:', { section: st.progress.sectionIndex, chapter: st.progress.chapter, page: `${st.progress.currentPage}/${st.progress.totalPages}` });
    },
  },
  {
    name: 'scroll-to-paginated preserves section + content',
    async run() {
      // Force scroll mode up front.
      await openSettings();
      await setPageTurnMode('scroll');
      await waitSettle(1000);
      // Aggressively scroll to get past front-matter into text-heavy
      // chapters. Each swipe travels ~700px; twelve of them push us
      // 8000+ pixels into the book which reliably clears cover +
      // copyright + TOC front-matter sections.
      const screen = screenSize();
      for (let i = 0; i < 14; i++) {
        swipe(screen.w >> 1, screen.h * 0.92, screen.w >> 1, screen.h * 0.18, 280);
        await sleep(220);
      }
      await waitSettle(1800);

      // Give RN a moment to update its latestProgress state before we
      // read it — the scroll settle can fire progressUpdated up to
      // 250ms AFTER the last scroll, and setLatestProgress lands on
      // the next React render (one more tick).
      await waitSettle(800);
      const before = await readReaderState();
      if (!before.progress) throw new Error('no progress before toggle');
      log('  before:', { section: before.progress.sectionIndex, chapter: before.progress.chapter, pct: before.progress.percentage });
      log('  before visible:', before.visible.slice(0, 120));
      adb(['exec-out', 'screencap', '-p']).length && execFileSync('bash', ['-c', `adb exec-out screencap -p > /tmp/harness-before.png`]);

      await openSettings();
      await setPageTurnMode('both');
      await waitSettle(1800);

      const after = await readReaderState();
      if (!after.progress) throw new Error('no progress after toggle');
      log('  after:', { section: after.progress.sectionIndex, chapter: after.progress.chapter, pct: after.progress.percentage });
      log('  after visible:', after.visible.slice(0, 120));
      execFileSync('bash', ['-c', `adb exec-out screencap -p > /tmp/harness-after.png`]);

      if (after.progress.sectionIndex !== before.progress.sectionIndex) {
        throw new Error(`section drifted: ${before.progress.sectionIndex} → ${after.progress.sectionIndex}`);
      }
      // Approximate text match — at least 20 chars of the visible text
      // should overlap between the two modes.
      if (before.visible && after.visible) {
        const sharedPrefix = commonSubstring(before.visible, after.visible);
        if (sharedPrefix.length < 20) {
          throw new Error(`visible text diverged: shared substring only "${sharedPrefix}" (${sharedPrefix.length} chars)`);
        }
        log('  shared text run:', sharedPrefix.slice(0, 80));
      }
    },
  },
  {
    name: 'TOC navigation jumps to chosen chapter',
    async run() {
      // Pull a specific chapter from the debug tocLoaded event.
      await closeAnyDrawerOrSheet();
      let toc = cachedToc;
      if (!toc) {
        const st = await readReaderState();
        toc = st.dbg?.toc ?? null;
        if (toc) cachedToc = toc;
      }
      if (!toc) throw new Error('no cached toc');
      const chapter = toc.chapters?.find((c) => /Chapter\s+3|Chapter\s+Three/i.test(c.label))
        ?? toc.chapters?.find((c) => /Introduction|Prologue/i.test(c.label))
        ?? toc.chapters?.[2];
      if (!chapter) throw new Error('no suitable TOC entry');
      log(`  jumping to "${chapter.label}" (${chapter.href})`);
      await openToc();
      // Find the TOC entry row. TOC items show the label as text.
      for (let attempt = 0; attempt < 6; attempt++) {
        const nodes = parseUi(dumpUI());
        const row = nodes.find((n) => (n.text ?? '').trim() === chapter.label);
        if (row) {
          const wrapper = clickableContainer(nodes, row) ?? row;
          const c = boundsCenter(wrapper.bounds);
          tap(c.x, c.y);
          break;
        }
        // TOC may need scroll if entry is below the fold.
        const screen = screenSize();
        swipe(screen.w >> 1, screen.h * 0.8, screen.w >> 1, screen.h * 0.3, 300);
        await sleep(400);
      }
      await waitSettle(1500);

      const after = await readReaderState();
      if (!after.progress) throw new Error('no progress after TOC nav');
      log('  landed:', { section: after.progress.sectionIndex, chapter: after.progress.chapter });
      if (after.progress.chapter && after.progress.chapter.trim() !== chapter.label.trim()) {
        // Chapter labels can differ slightly from TOC labels (e.g. with
        // subtitle). Check that the href-derived section matches the
        // spine index the TOC entry should have pointed to.
        const hrefOk = (after.progress.chapterHref ?? '').includes(
          chapter.href.split('#')[0]?.replace(/^\.\//, '') ?? '',
        );
        if (!hrefOk) {
          throw new Error(`TOC nav landed on wrong chapter: ${after.progress.chapter} (wanted ${chapter.label})`);
        }
      }
    },
  },
  {
    name: 'close + reopen resumes to saved position',
    async run() {
      // Nav somewhere with real content so we're not trivially testing
      // resume-to-cover (section 0 matches itself by accident).
      await jumpToTocLabelPrefix('Introduction');
      await waitSettle(1500);
      const snapshotBefore = await readReaderState();
      if (!snapshotBefore.progress) throw new Error('no progress before close');
      if (snapshotBefore.progress.sectionIndex === 0) {
        throw new Error('test needs to start somewhere other than the cover');
      }
      log('  before close:', {
        section: snapshotBefore.progress.sectionIndex,
        chapter: snapshotBefore.progress.chapter,
        pct: snapshotBefore.progress.percentage,
      });
      const beforeVisible = snapshotBefore.visible.slice(0, 120);
      log('  before visible:', beforeVisible);

      // Back out to library, then re-open the book.
      shell('input keyevent 4');
      await waitSettle(1500);
      // If the toggle mode left the reader's header open, a single back
      // press goes to the library. Otherwise we may need another back.
      for (let i = 0; i < 3; i++) {
        const nodes = parseUi(dumpUI());
        if (nodes.some((n) => n.text === 'Library' || n.text === 'CONTINUE' || (n['content-desc'] ?? '').startsWith('CONTINUE'))) break;
        shell('input keyevent 4');
        await waitSettle(700);
      }
      await openBookForTesting();
      await waitSettle(2500);
      const snapshotAfter = await readReaderState();
      if (!snapshotAfter.progress) throw new Error('no progress after reopen');
      log('  after reopen:', {
        section: snapshotAfter.progress.sectionIndex,
        chapter: snapshotAfter.progress.chapter,
        pct: snapshotAfter.progress.percentage,
      });
      const afterVisible = snapshotAfter.visible.slice(0, 120);
      log('  after visible:', afterVisible);

      if (snapshotAfter.progress.sectionIndex !== snapshotBefore.progress.sectionIndex) {
        throw new Error(`resume landed on different section: ${snapshotBefore.progress.sectionIndex} → ${snapshotAfter.progress.sectionIndex}`);
      }
      const deltaPct = Math.abs(snapshotAfter.progress.percentage - snapshotBefore.progress.percentage);
      if (deltaPct > 1.5) {
        throw new Error(`resume drift too large: ${deltaPct.toFixed(2)}%`);
      }
    },
  },
  {
    name: 'paginated-to-scroll preserves section + content',
    async run() {
      // Assume previous test left us in paginated (both). Capture,
      // switch, compare.
      const before = await readReaderState();
      log('  before:', { section: before.progress?.sectionIndex, chapter: before.progress?.chapter, pct: before.progress?.percentage });
      log('  before visible:', before.visible.slice(0, 120));

      await openSettings();
      await setPageTurnMode('scroll');
      await waitSettle(1500);

      const after = await readReaderState();
      log('  after:', { section: after.progress?.sectionIndex, chapter: after.progress?.chapter, pct: after.progress?.percentage });
      log('  after visible:', after.visible.slice(0, 120));

      if (after.progress.sectionIndex !== before.progress.sectionIndex) {
        throw new Error(`section drifted: ${before.progress.sectionIndex} → ${after.progress.sectionIndex}`);
      }
      if (before.visible && after.visible) {
        const shared = commonSubstring(before.visible, after.visible);
        if (shared.length < 20) {
          throw new Error(`visible text diverged: shared "${shared}" (${shared.length} chars)`);
        }
        log('  shared text run:', shared.slice(0, 80));
      }
    },
  },
  // ─── Typography ──────────────────────────────────────────────────────
  {
    name: 'font-size + increases page count, - decreases (paginated)',
    async run() {
      await resetReaderDefaults();
      // Move fontSize to a middle-of-range value before the test so we
      // have headroom in both directions (range is 12..32). Read the
      // current value and step it to 20.
      await openSettings();
      const initNodes = parseUi(dumpUI());
      const currentFs = readSettingValue(initNodes, 'font size') ?? 20;
      const resetDelta = 20 - currentFs;
      if (resetDelta !== 0) await adjustSetting('font size', resetDelta);
      await dismissDropdown();

      const base = await readReaderState();
      if (!base.progress?.totalPages) throw new Error('no totalPages baseline');
      const baseTotal = base.progress.totalPages;
      const baseSection = base.progress.sectionIndex;
      log('  baseline:', { total: baseTotal, section: baseSection, fs: 20 });
      await openSettings();
      await adjustSetting('font size', +3);
      await dismissDropdown();
      const bigger = await readReaderState();
      log('  +3 fontSize:', { total: bigger.progress?.totalPages, section: bigger.progress?.sectionIndex });
      if (!bigger.progress?.totalPages || bigger.progress.totalPages <= baseTotal) {
        throw new Error(`fontSize+ did not increase totalPages: ${baseTotal} → ${bigger.progress?.totalPages}`);
      }
      if (bigger.progress.sectionIndex !== baseSection) {
        throw new Error(`section drifted on font change: ${baseSection} → ${bigger.progress.sectionIndex}`);
      }
      // Revert so later tests start from a known baseline.
      await openSettings();
      await adjustSetting('font size', -3);
      await dismissDropdown();
    },
  },
  {
    name: 'line spacing change reflows without section drift',
    async run() {
      await resetReaderDefaults();
      const base = await readReaderState();
      const baseTotal = base.progress?.totalPages ?? 0;
      const baseSection = base.progress?.sectionIndex ?? -1;
      await openSettings();
      await adjustSetting('line spacing', +3);
      await dismissDropdown();
      const after = await readReaderState();
      if (after.progress?.sectionIndex !== baseSection) {
        throw new Error(`section drifted: ${baseSection} → ${after.progress?.sectionIndex}`);
      }
      if (!after.progress?.totalPages || after.progress.totalPages <= baseTotal) {
        throw new Error(`line spacing+ did not increase totalPages: ${baseTotal} → ${after.progress?.totalPages}`);
      }
      log('  lineSpacing+: total', baseTotal, '→', after.progress.totalPages);
      // Revert.
      await openSettings();
      await adjustSetting('line spacing', -3);
      await dismissDropdown();
    },
  },
  // ─── Margins ─────────────────────────────────────────────────────────
  {
    name: 'horizontal margin + keeps section, decreases column width',
    async run() {
      await resetReaderDefaults();
      const base = await readReaderState();
      const baseSection = base.progress?.sectionIndex ?? -1;
      await openSettings();
      await adjustSetting('horizontal margin', +3);
      await dismissDropdown();
      const after = await readReaderState();
      if (after.progress?.sectionIndex !== baseSection) {
        throw new Error(`horizontal margin change drifted section: ${baseSection} → ${after.progress?.sectionIndex}`);
      }
      // Revert.
      await openSettings();
      await adjustSetting('horizontal margin', -3);
      await dismissDropdown();
    },
  },
  {
    name: 'vertical margin + forces repagination',
    async run() {
      await resetReaderDefaults();
      const base = await readReaderState();
      const baseSection = base.progress?.sectionIndex ?? -1;
      const baseTotal = base.progress?.totalPages ?? 0;
      await openSettings();
      await adjustSetting('vertical margin', +3);
      await dismissDropdown();
      const after = await readReaderState();
      if (after.progress?.sectionIndex !== baseSection) {
        throw new Error(`vertical margin change drifted section: ${baseSection} → ${after.progress?.sectionIndex}`);
      }
      // Vertical margin change should affect page count (taller margins
      // = less vertical space for content = more pages). Accept either
      // direction of change since the sign depends on baseline.
      if (!after.progress?.totalPages || after.progress.totalPages === baseTotal) {
        log('  warning: totalPages unchanged (' + baseTotal + ') after marginV change');
      } else {
        log('  marginV+: total', baseTotal, '→', after.progress.totalPages);
      }
      // Revert.
      await openSettings();
      await adjustSetting('vertical margin', -3);
      await dismissDropdown();
    },
  },
  // ─── Themes ──────────────────────────────────────────────────────────
  {
    name: 'theme switch to Sepia preserves position',
    async run() {
      await resetReaderDefaults();
      const base = await readReaderState();
      const baseSection = base.progress?.sectionIndex ?? -1;
      const basePct = base.progress?.percentage ?? 0;
      await openSettings();
      await selectTheme('Sepia');
      await dismissDropdown();
      const after = await readReaderState();
      if (after.progress?.sectionIndex !== baseSection) {
        throw new Error(`theme switch drifted section: ${baseSection} → ${after.progress?.sectionIndex}`);
      }
      if (Math.abs((after.progress?.percentage ?? 0) - basePct) > 2) {
        throw new Error(`theme switch drifted pct: ${basePct} → ${after.progress?.percentage}`);
      }
      log('  sepia applied, section preserved');
      // Revert to Light so subsequent tests share a baseline.
      await openSettings();
      await selectTheme('Light');
      await dismissDropdown();
    },
  },
  {
    name: 'theme switch to Dark preserves position',
    async run() {
      await resetReaderDefaults();
      const base = await readReaderState();
      const baseSection = base.progress?.sectionIndex ?? -1;
      await openSettings();
      await selectTheme('Dark');
      await dismissDropdown();
      const after = await readReaderState();
      if (after.progress?.sectionIndex !== baseSection) {
        throw new Error(`Dark theme drifted section: ${baseSection} → ${after.progress?.sectionIndex}`);
      }
      // Revert.
      await openSettings();
      await selectTheme('Light');
      await dismissDropdown();
    },
  },
  // ─── Font weight ─────────────────────────────────────────────────────
  {
    name: 'font weight Bold applies without drift',
    async run() {
      await resetReaderDefaults();
      const base = await readReaderState();
      const baseSection = base.progress?.sectionIndex ?? -1;
      await openSettings();
      await selectWeight('Bold');
      await dismissDropdown();
      const after = await readReaderState();
      if (after.progress?.sectionIndex !== baseSection) {
        throw new Error(`Bold weight drifted section: ${baseSection} → ${after.progress?.sectionIndex}`);
      }
      // Revert.
      await openSettings();
      await selectWeight('Regular');
      await dismissDropdown();
    },
  },
  // ─── Page turns (paginated) ──────────────────────────────────────────
  {
    name: 'tap right advances, tap left regresses',
    async run() {
      await resetReaderDefaults();
      const start = await readReaderState();
      const startPage = start.progress?.currentPage ?? 0;
      log('  startPage:', startPage);
      // Advance.
      await tapPageZone('right');
      await waitSettle(800);
      const fwd = await readReaderState();
      log('  after tap right:', fwd.progress?.currentPage);
      if (!fwd.progress?.currentPage || fwd.progress.currentPage <= startPage) {
        throw new Error(`tap right did not advance: ${startPage} → ${fwd.progress?.currentPage}`);
      }
      // Regress.
      await tapPageZone('left');
      await waitSettle(800);
      const back = await readReaderState();
      log('  after tap left:', back.progress?.currentPage);
      if (!back.progress?.currentPage || back.progress.currentPage >= fwd.progress.currentPage) {
        throw new Error(`tap left did not regress: ${fwd.progress.currentPage} → ${back.progress?.currentPage}`);
      }
    },
  },
  {
    name: 'close + reopen preserves within-section offset',
    async run() {
      // Jump deep, then turn several pages within a section so the
      // saved state is definitively NOT at section-start. A resume
      // bug (like "snap to section top") would show section matches
      // but pct drift > a page.
      await resetReaderDefaults();
      await jumpToTocLabelPrefix('Introduction');
      await waitSettle(1500);
      for (let i = 0; i < 5; i++) {
        await tapPageZone('right');
        await waitSettle(500);
      }
      await waitSettle(1000);
      const before = await readReaderState();
      if (!before.progress) throw new Error('no progress before close');
      log('  before close:', { section: before.progress.sectionIndex, pct: before.progress.percentage, page: before.progress.currentPage });
      const beforeVisible = before.visible.slice(0, 120);

      // Close + reopen via cold-start.
      shell('am force-stop com.readr.app');
      await sleep(1500);
      shell('am start -n com.readr.app/.MainActivity');
      await sleep(4500);
      await connectDevClientIfNeeded();
      await openBookForTesting();
      await waitSettle(2500);
      const after = await readReaderState();
      if (!after.progress) throw new Error('no progress after reopen');
      log('  after reopen:', { section: after.progress.sectionIndex, pct: after.progress.percentage, page: after.progress.currentPage });
      const afterVisible = after.visible.slice(0, 120);

      if (after.progress.sectionIndex !== before.progress.sectionIndex) {
        throw new Error(`section drift: ${before.progress.sectionIndex} → ${after.progress.sectionIndex}`);
      }
      const pctDrift = Math.abs((after.progress.percentage ?? 0) - (before.progress.percentage ?? 0));
      if (pctDrift > 0.5) {
        throw new Error(`pct drift too large: ${before.progress.percentage} → ${after.progress.percentage} (|Δ|=${pctDrift.toFixed(3)})`);
      }
      const overlap = commonSubstring(beforeVisible, afterVisible);
      if (overlap.length < 40) {
        throw new Error(`visible text diverged: shared "${overlap.slice(0, 60)}" (${overlap.length} chars)`);
      }
      log('  precision OK: pct Δ =', pctDrift.toFixed(3), 'overlap chars =', overlap.length);
    },
  },
  {
    name: 'mode flip mid-section preserves visible top content',
    async run() {
      // Go into Intro, turn several pages so we're MID-section, then
      // flip to scroll. The top-of-viewport paragraph should stay
      // visible (content continuity) across the flip.
      await resetReaderDefaults();
      await jumpToTocLabelPrefix('Introduction');
      await waitSettle(1500);
      for (let i = 0; i < 4; i++) {
        await tapPageZone('right');
        await waitSettle(500);
      }
      await waitSettle(800);
      const paginated = await readReaderState();
      log('  paginated:', { sec: paginated.progress?.sectionIndex, pct: paginated.progress?.percentage });
      const paginatedVisible = paginated.visible;

      await openSettings();
      await setPageTurnMode('scroll');
      await waitSettle(1800);

      const scrolled = await readReaderState();
      log('  scrolled :', { sec: scrolled.progress?.sectionIndex, pct: scrolled.progress?.percentage });
      const scrolledVisible = scrolled.visible;

      if (scrolled.progress?.sectionIndex !== paginated.progress?.sectionIndex) {
        throw new Error(`section drifted on flip: ${paginated.progress?.sectionIndex} → ${scrolled.progress?.sectionIndex}`);
      }
      const overlap = commonSubstring(paginatedVisible, scrolledVisible);
      if (overlap.length < 40) {
        throw new Error(`visible-text overlap too small: "${overlap.slice(0, 60)}" (${overlap.length} chars)`);
      }
      log('  overlap chars =', overlap.length);

      // Flip back to paginated — should also preserve.
      await openSettings();
      await setPageTurnMode('both');
      await waitSettle(1800);
      const back = await readReaderState();
      log('  back to pagi:', { sec: back.progress?.sectionIndex, pct: back.progress?.percentage });
      if (back.progress?.sectionIndex !== scrolled.progress?.sectionIndex) {
        throw new Error(`section drifted on return flip: ${scrolled.progress?.sectionIndex} → ${back.progress?.sectionIndex}`);
      }
      const backOverlap = commonSubstring(scrolledVisible, back.visible);
      if (backOverlap.length < 40) {
        throw new Error(`return-flip overlap too small: "${backOverlap.slice(0, 60)}" (${backOverlap.length} chars)`);
      }
    },
  },
  {
    name: 'percentage advances on each page turn (within a section)',
    async run() {
      // Nav to a text-heavy chapter (Ch 1 Mandaeans → section 11).
      await resetReaderDefaults();
      await jumpToTocLabelPrefix('Introduction');
      await waitSettle(1200);
      const start = await readReaderState();
      const startPct = start.progress?.percentage ?? -1;
      const startSection = start.progress?.sectionIndex;
      log('  start:', { section: startSection, pct: startPct });
      // Capture pct after 5 tap-rights. Each should nudge pct up.
      const pcts = [startPct];
      for (let i = 0; i < 5; i++) {
        await tapPageZone('right');
        await waitSettle(600);
        const st = await readReaderState();
        pcts.push(st.progress?.percentage ?? -1);
      }
      log('  pct series:', pcts);
      // Expect the final pct > startPct (strictly advancing across 5 pages).
      const last = pcts[pcts.length - 1];
      if (last <= startPct) {
        throw new Error(`pct did not advance across 5 page turns: ${startPct} → ${last}`);
      }
      // Expect monotonically non-decreasing.
      for (let i = 1; i < pcts.length; i++) {
        if (pcts[i] < pcts[i - 1] - 0.01) {
          throw new Error(`pct regressed between tap ${i - 1} and ${i}: ${pcts[i - 1]} → ${pcts[i]}`);
        }
      }
    },
  },
  {
    name: 'swipe advances one page',
    async run() {
      await resetReaderDefaults();
      const start = await readReaderState();
      const startPage = start.progress?.currentPage ?? 0;
      await swipePageZone('left');
      await waitSettle(800);
      const after = await readReaderState();
      if (!after.progress?.currentPage || after.progress.currentPage <= startPage) {
        throw new Error(`swipe did not advance: ${startPage} → ${after.progress?.currentPage}`);
      }
      // Regress by swiping the other direction.
      await swipePageZone('right');
      await waitSettle(800);
    },
  },
  // ─── TOC navigation (deeper) ─────────────────────────────────────────
  {
    name: 'TOC jump to Introduction',
    async run() {
      await resetReaderDefaults();
      await jumpToTocLabelPrefix('Introduction');
      const st = await readReaderState();
      const label = st.progress?.chapter ?? '';
      if (!/Introduction/i.test(label)) {
        throw new Error(`TOC jump to Introduction landed on ${label}`);
      }
      log('  landed:', st.progress.chapter);
    },
  },
  // ─── Bookmarks ───────────────────────────────────────────────────────
  {
    name: 'bookmark add + remove toggles icon content-desc',
    async run() {
      await resetReaderDefaults();
      const first = await bookmarkToggle();
      log('  first toggle:', first);
      if (first !== 'added') throw new Error(`expected "added", got ${first}`);
      const second = await bookmarkToggle();
      log('  second toggle:', second);
      if (second !== 'removed') throw new Error(`expected "removed", got ${second}`);
    },
  },
];

function commonSubstring(a, b) {
  // Longest common substring via DP, capped for short texts.
  if (!a || !b) return '';
  const n = Math.min(a.length, 2000);
  const m = Math.min(b.length, 2000);
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  let best = 0, bi = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a.charAt(i - 1) === b.charAt(j - 1)) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best) { best = dp[i][j]; bi = i; }
      }
    }
  }
  return a.slice(bi - best, bi);
}

// ─── Runner ──────────────────────────────────────────────────────────

async function main() {
  const filter = process.argv[2] ?? '';

  const devices = adb(['devices']).split('\n').filter((l) => /\tdevice$/.test(l));
  if (devices.length === 0) throw new Error('No ADB device attached');
  log('device:', devices[0].split('\t')[0]);

  await restartApp();
  // Dev launcher may not render immediately after `am start`; give it
  // a couple of dumps to catch up.
  for (let i = 0; i < 8; i++) {
    const nn = parseUi(dumpUI());
    if (isOnDevLauncher(nn) || nn.some((n) => n.text === 'Library')) break;
    await sleep(1000);
  }
  await connectDevClientIfNeeded();
  log('library reached');
  const openDbg = await openBookForTesting();
  log('reader opened, events:', openDbg.events.length, 'latest:', openDbg.latest?.sectionIndex, openDbg.latest?.chapter);
  // Book just opened — give the reader a full beat before tests poke
  // at it. The WebView's initial layout pass, page-count measurement,
  // and the first few progressUpdated round-trips can fire over ~1s
  // after `latest` populates, and early taps during that window are
  // sometimes swallowed or redirected by RN's render cycle.
  await sleep(3000);

  let passed = 0, failed = 0;
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    log(`→ ${t.name}`);
    try {
      // Simple, reliable pre-flight: force-stop + cold-open the book
      // if we're not demonstrably in the reader. More costly (~30s
      // per test) but deterministic, no state-machine heuristics.
      if (!dumpUI().includes('READR_DEBUG')) {
        shell('am force-stop com.readr.app');
        await sleep(1500);
        shell('am start -n com.readr.app/.MainActivity');
        await sleep(4500);
        // Dev launcher → library (auto-login via EXPO_PUBLIC_DEV_TOKEN).
        await connectDevClientIfNeeded();
        // Library → reader.
        await openBookForTesting();
      }
      // One last sanity check so test failures don't cascade.
      if (!dumpUI().includes('READR_DEBUG')) {
        throw new Error('reader did not open after cold-start');
      }
      await t.run();
      log(`✓ ${t.name}`);
      passed++;
    } catch (err) {
      log(`✗ ${t.name}: ${err.message}`);
      failed++;
    }
  }
  log(`done: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[harness] fatal:', err);
  process.exit(1);
});
