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
  try { shell('uiautomator dump /sdcard/ui.xml >/dev/null 2>&1'); } catch {}
  return shell('cat /sdcard/ui.xml');
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
  const trailStart = text.indexOf('|trail=');
  const visibleStart = text.indexOf('|visible=');
  if (trailStart < 0) return null;
  const latestRaw = latestStart >= 0
    ? text.slice(latestStart + 8, trailStart)
    : '';
  const trail = visibleStart >= 0
    ? text.slice(trailStart + 7, visibleStart)
    : text.slice(trailStart + 7);
  const visible = visibleStart >= 0 ? text.slice(visibleStart + 9) : '';
  let latest = null;
  if (latestRaw) { try { latest = JSON.parse(latestRaw); } catch { /* ignore */ } }
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
  return { trail, visible, events, latest };
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
  // First clickable card containing "10.0.2.2" is the active dev server.
  const ip = nodes.find((n) => (n.text ?? '').includes('10.0.2.2'));
  const card = ip ? clickableContainer(nodes, ip) : null;
  if (!card) throw new Error('Dev launcher shown but no server card found');
  const c = boundsCenter(card.bounds);
  tap(c.x, c.y);
  // Bundle + JS init — Metro may take a few seconds to serve.
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const nn = parseUi(dumpUI());
    if (nn.some((n) => n.text === 'Library')) return;
  }
  throw new Error('Library did not appear after connecting to dev server');
}

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
      for (let w = 0; w < 25; w++) {
        await sleep(500);
        const nn = parseUi(dumpUI());
        const dbg = extractDebug(nn);
        if (dbg?.latest || dbg?.events?.some((e) => e.type === 'progressUpdated')) return dbg;
      }
      throw new Error('Reader did not emit progressUpdated after opening book');
    }
    await sleep(1000);
  }
  throw new Error('No READ or CONTINUE button found on library');
}

async function waitSettle(ms = 1500) { await sleep(ms); }

async function openSettings() {
  const screen = screenSize();
  // Chrome is toggled by a center tap. On scroll mode our tap handler
  // always posts `tapCenter`. Retry a few times while waiting for the
  // settings button to appear.
  for (let attempt = 0; attempt < 5; attempt++) {
    const nodes = parseUi(dumpUI());
    const existing = nodes.find((n) => n['content-desc'] === 'Reader settings');
    if (existing) {
      const c = boundsCenter(existing.bounds);
      tap(c.x, c.y);
      await sleep(900);
      return;
    }
    tap(screen.w >> 1, screen.h >> 1);
    await sleep(700);
  }
  throw new Error('Reader settings button did not appear after chrome taps');
}

async function setPageTurnMode(mode) {
  const wanted = { tap: 'Tap', swipe: 'Swipe', both: 'Both', scroll: 'Scroll' }[mode];
  if (!wanted) throw new Error('bad mode');
  const nodes = parseUi(dumpUI());
  const btn = nodes.find((n) => n.clickable === 'true' && n['content-desc'] === wanted);
  if (!btn) throw new Error(`Page turn mode button "${wanted}" not found`);
  const c = boundsCenter(btn.bounds);
  tap(c.x, c.y);
  await sleep(800);
  // Dismiss the dropdown.
  shell('input keyevent 4');
  await sleep(500);
}

async function openToc() {
  const screen = screenSize();
  // Make sure chrome is visible.
  for (let attempt = 0; attempt < 4; attempt++) {
    const nodes = parseUi(dumpUI());
    const toc = nodes.find((n) => n['content-desc'] === 'Table of contents');
    if (toc) {
      const c = boundsCenter(toc.bounds);
      tap(c.x, c.y);
      await sleep(900);
      return;
    }
    tap(screen.w >> 1, screen.h >> 1);
    await sleep(600);
  }
  throw new Error('Table of contents button did not appear');
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

async function readReaderState() {
  await waitSettle(300);
  const nodes = parseUi(dumpUI());
  const dbg = extractDebug(nodes);
  return {
    dbg,
    progress: dbg ? latestProgress(dbg) : null,
    scrollMode: dbg ? latestScrollMode(dbg) : null,
    visible: dbg?.visible ?? '',
  };
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
  await connectDevClientIfNeeded();
  log('library reached');
  const openDbg = await openBookForTesting();
  log('reader opened, events:', openDbg.events.length);

  let passed = 0, failed = 0;
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    log(`→ ${t.name}`);
    try {
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
