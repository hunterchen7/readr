/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Reader entry point — fetches the EPUB, parses it, mounts the render
 * host, and wires the postMessage bridge to the React Native host.
 *
 * This bundle REPLACES the old foliate-bundle.js + reader-bundle.js
 * pair. The JSON bridge contract matches the prior reader.ts so the
 * React Native host needs no changes.
 */

import { parseEpub } from './parser';
import type { ParsedBook, TocItem } from './parser';
import { RenderHost } from './host';
import type { Theme, ProgressDetail } from './host';
import { AnnotationLayer } from './annotations';
import { searchBook } from './search';
import { rangeToCfi, resolveCfi, isCfi, sectionCfi } from './cfi';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
    __READR_CONFIG?: { bookUrl: string };
    __READR?: { host: RenderHost; annotations: AnnotationLayer; book: ParsedBook };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function post(type: string, payload: any = {}): void {
  try {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
  } catch {
    // ignore — RN side will retry on its own cadence
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  post('debug', { msg: 'BOOT v11 FRESH BUNDLE STARTED' });
  const config = window.__READR_CONFIG;
  const bookUrl = config?.bookUrl;
  if (!bookUrl) {
    showError('Missing __READR_CONFIG.bookUrl');
    post('error', { message: 'Missing __READR_CONFIG.bookUrl' });
    return;
  }

  try {
    const blob = await fetchFile(bookUrl);
    const book = await parseEpub(blob);

    const loading = document.getElementById('loading');
    if (loading) loading.style.display = 'none';

    const viewer = document.getElementById('viewer');
    if (!viewer) throw new Error('#viewer not found');

    const host = new RenderHost(viewer, book, {
      onSelection: (text, range, sectionIndex, rect) => {
        const cfi = rangeToCfi(sectionIndex, range);
        post('selectionChanged', {
          text,
          cfi,
          rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        });
      },
      onSelectionCleared: () => post('selectionCleared'),
      onTap: (zone) => {
        post('debug', { msg: `tap zone=${zone} tapToTurn=${tapToTurn} scrollMode=${scrollMode}` });
        // Left/right tap zones turn pages when tap-to-turn is enabled
        // (paginated-only). Otherwise every tap toggles chrome via
        // tapCenter — the RN side has no dedicated left/right handler.
        if (zone === 'center' || !tapToTurn) {
          post('tapCenter');
          return;
        }
        if (zone === 'left') host.prevPage();
        else if (zone === 'right') host.nextPage();
      },
      onProgressUpdated: (detail) => emitProgress(detail, book),
      onDebug: (msg) => post('debug', { msg }),
    });

    const annotations = new AnnotationLayer(host);

    window.__READR = { host, annotations, book };

    // Wire incoming RN messages now that the system is ready.
    installRnBridge(host, annotations, book);

    // Notify RN of initial state.
    post('ready', { totalPages: null });
    post('tocLoaded', { chapters: flattenToc(book.toc) });

    // Handle tap-to-turn from inside the click handler — simpler than
    // round-tripping through RN for every tap.
    wireTapToTurn(host);

    // After a tick, run a first page count (paginated only) and emit
    // initial progress so RN has something to render before scroll.
    requestAnimationFrame(() => {
      host.recountPages();
      host.reportProgress(false);
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    showError('Failed to load book: ' + msg);
    post('error', { message: msg });
  }
}

// ─── Progress emit ───────────────────────────────────────────────────

let scrollMode = false;
let tapToTurn = true;

function emitProgress(detail: ProgressDetail, book: ParsedBook): void {
  const chapterLabel = chapterForSection(book.toc, detail.sectionHref);
  const cfi = sectionCfi(detail.sectionIndex);
  const host = window.__READR?.host;
  let visibleSample: string | undefined;
  if (!detail.transient) {
    try {
      visibleSample = host ? gatherVisibleText(host, 240) : '(no host)';
    } catch (err) {
      visibleSample = `(gather err: ${(err as Error).message})`;
    }
  }
  post('progressUpdated', {
    percentage: Math.round(detail.fraction * 100000) / 1000,
    anchorFraction: detail.fraction,
    cfi,
    chapter: chapterLabel,
    chapterHref: detail.sectionHref,
    sectionIndex: detail.sectionIndex,
    currentPage: detail.currentPage,
    totalPages: detail.totalPages,
    pageInSection: detail.pageInSection,
    pagesInSection: detail.pagesInSection,
    totalIsEstimate: false,
    transient: detail.transient,
    visibleSample,
  });
}

function chapterForSection(toc: TocItem[], href: string): string | null {
  const flat = flattenToc(toc);
  // Exact match wins; fall back to longest common prefix on path.
  for (const item of flat) {
    if (item.href === href) return item.label;
  }
  const path = href.split('#')[0];
  let best: { label: string; score: number } | null = null;
  for (const item of flat) {
    const itemPath = item.href.split('#')[0];
    if (itemPath === path) {
      if (!best || item.label.length < best.label.length) {
        best = { label: item.label, score: 1 };
      }
    }
  }
  return best?.label ?? null;
}

function flattenToc(toc: TocItem[], depth = 0, out: Array<{ label: string; href: string; depth: number }> = []): Array<{ label: string; href: string; depth: number }> {
  for (const item of toc) {
    out.push({ label: item.label, href: item.href, depth });
    if (item.subitems) flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

// ─── RN bridge ───────────────────────────────────────────────────────

function installRnBridge(
  host: RenderHost,
  annotations: AnnotationLayer,
  book: ParsedBook,
): void {
  // Track tap-to-turn and swipe enablement from theme updates.
  window.addEventListener('message', (e: MessageEvent) => {
    try {
      handleRnMessage(host, annotations, book, JSON.parse(e.data));
    } catch { /* ignore non-JSON */ }
  });
  // Android uses document 'message' event in some WebView versions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  document.addEventListener('message' as any, (e: any) => {
    try {
      handleRnMessage(host, annotations, book, JSON.parse(e.data));
    } catch { /* ignore */ }
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleRnMessage(
  host: RenderHost,
  annotations: AnnotationLayer,
  book: ParsedBook,
  data: { type: string; payload?: Record<string, unknown> },
): void {
  const payload = data.payload ?? {};
  switch (data.type) {
    case 'setTheme': {
      const t = payload as unknown as Theme;
      const mode = t.pageTurnMode ?? (t.tapToTurn === false ? 'swipe' : 'both');
      scrollMode = mode === 'scroll';
      tapToTurn = mode === 'tap' || mode === 'both';
      host.setTheme(t);
      post('scrollModeChanged', { scrollMode });
      // Any layout change may invalidate highlight rect positions.
      requestAnimationFrame(() => annotations.rerenderAll());
      break;
    }
    case 'goToLocation': {
      const cfi = payload.cfi as string | undefined;
      const fraction = payload.fraction as number | undefined;
      (async () => {
        // Wait for a paint so the section elements have their final
        // layout — scrollToFraction reads offsetHeight/offsetWidth and
        // pageCounts, both of which are only meaningful after layout.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        host.recountPages();
        try {
          let handled = false;
          if (cfi && isCfi(cfi)) {
            const sections = book.spine.map((s) => ({ index: s.index, doc: s.doc }));
            const resolved = resolveCfi(cfi, sections);
            post('debug', { msg: `goToLocation cfi=${cfi.slice(0, 60)} resolved=${resolved ? `sec=${resolved.sectionIndex} range=${!!resolved.range}` : 'null'}` });
            if (resolved) {
              if (resolved.range) {
                host.scrollToSection(resolved.sectionIndex);
                try { host.scrollToRange(resolved.range); } catch { /* ignore */ }
                handled = true;
              } else {
                // Spine-only CFI — scroll to the RESOLVED section. The
                // accompanying `fraction` is a global book-percentage,
                // not within-section, so we can't trust it to land
                // somewhere inside this section. Accept the slight
                // imprecision (land at section start) for a correct
                // section over the wrong section with "precise" offset.
                host.scrollToSection(resolved.sectionIndex);
                handled = true;
              }
            }
          }
          if (!handled && typeof fraction === 'number') {
            post('debug', { msg: `goToLocation fallback fraction=${fraction}` });
            host.scrollToFraction(fraction);
          }
        } catch (err) {
          post('debug', { msg: 'goToLocation failed: ' + (err as Error)?.message });
        }
        // Wait two more frames so the programmatic scroll has landed
        // (the browser defers scroll + its own scroll events one frame
        // beyond the scrollTo call), then report the settled position.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            host.reportProgress(false);
            post('restored');
          });
        });
      })();
      break;
    }
    case 'goToChapter': {
      const href = payload.href as string | undefined;
      if (!href) break;
      if (host.goToFragment(href)) post('restored');
      break;
    }
    case 'prevPage':
      host.prevPage();
      requestAnimationFrame(() => host.reportProgress(false));
      break;
    case 'nextPage':
      host.nextPage();
      requestAnimationFrame(() => host.reportProgress(false));
      break;
    case 'search': {
      const query = String(payload.query ?? '');
      (async () => {
        const results = await searchBook(book, query);
        post('searchResults', { results, query });
      })();
      break;
    }
    case 'clearSearch':
      // Our search doesn't draw a persistent highlight, so nothing to clear.
      break;
    case 'getPageText': {
      // Gather visible text from sections currently in viewport.
      const text = gatherVisibleText(host);
      post('pageText', { text });
      break;
    }
    case 'getVisibleText': {
      // Test-harness helper — returns the first ~300 visible chars
      // from the current viewport so automated tests can compare
      // on-screen content across actions (mode toggles, TOC nav,
      // resume, etc.) without tapping through the UI.
      const text = gatherVisibleText(host, 400);
      post('visibleText', { text });
      break;
    }
    case 'copyToClipboard': {
      const text = String(payload.text ?? '');
      if (text) copyText(text);
      break;
    }
    case 'addHighlight': {
      const cfi = String(payload.cfi ?? payload.cfiRange ?? '');
      const color = String(payload.color ?? 'yellow');
      if (cfi) {
        annotations.addHighlight(cfi, color);
      }
      break;
    }
    case 'removeHighlight': {
      const cfi = String(payload.cfi ?? payload.cfiRange ?? '');
      if (cfi) annotations.removeHighlight(cfi);
      break;
    }
    case 'addNote': {
      const cfi = String(payload.cfi ?? '');
      const noteType = payload.noteType === 'handwritten' ? 'handwritten' : 'typed';
      if (cfi) annotations.addNote(cfi, noteType);
      break;
    }
    case 'removeNote': {
      const cfi = String(payload.cfi ?? '');
      if (cfi) annotations.removeNote(cfi);
      break;
    }
  }
}

// ─── Tap-to-turn ─────────────────────────────────────────────────────

function wireTapToTurn(host: RenderHost): void {
  // The onTap callback emits zones to RN; the RN side toggles chrome
  // on center-taps and previously sent prev/nextPage messages for
  // left/right. Simplest UX: handle left/right directly here for
  // zero-latency page turns when tap-to-turn is on.
  //
  // We short-circuit via a window-level tap listener that also
  // consults a flag we derive from theme.pageTurnMode.
  document.addEventListener('click', (e: MouseEvent) => {
    // Annotation hits pre-empt page turns — if we hit an annotation,
    // fire a dedicated event and skip navigation.
    const ann = window.__READR?.annotations?.hitTest?.(e.clientX, e.clientY);
    if (ann) {
      e.stopPropagation?.();
      if (ann.kind === 'note') {
        post('noteTapped', {
          cfi: ann.cfi,
          noteType: ann.noteType,
          rect: { x: ann.rect.left, y: ann.rect.top, w: ann.rect.width, h: ann.rect.height },
        });
      } else {
        post('showAnnotation', {
          value: ann.cfi,
          rect: { x: ann.rect.left, y: ann.rect.top, w: ann.rect.width, h: ann.rect.height },
        });
      }
      return;
    }
    // RN's onTap callback already fired — it emits tapLeft/tapRight/tapCenter.
    // Page turning based on zone happens on the RN side via message.
  }, true);
}

// ─── Misc helpers ────────────────────────────────────────────────────

function gatherVisibleText(host: RenderHost, maxChars = 0): string {
  // Walk every text node inside any viewport-intersecting section and
  // accumulate their content.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const content = host.contentElement;

  // Use a Range-based approach: set a range over the section content
  // and skim its text. Simpler than a TreeWalker-from-shadow-root and
  // bypasses any cross-root walking quirks.
  const chunks: string[] = [];
  for (let i = 0; i < host.spineLength; i++) {
    const sec = host.sectionElement(i);
    if (!sec) continue;
    const r = sec.getBoundingClientRect();
    if (r.right <= 0 || r.bottom <= 0) continue;
    if (r.left >= vw || r.top >= vh) continue;

    // Visit every descendant element of this section. For each element
    // whose bounding rect intersects the viewport, grab its innerText.
    // Skip elements that themselves contain smaller text-bearing
    // elements we'll visit separately (to avoid duplicates) by only
    // taking leaf-ish blocks (<=1 level of child elements with text).
    const desc = sec.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, div, span');
    for (const el of Array.from(desc)) {
      const er = (el as HTMLElement).getBoundingClientRect();
      if (er.right <= 0 || er.bottom <= 0) continue;
      if (er.left >= vw || er.top >= vh) continue;
      const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
      if (!text) continue;
      chunks.push(text);
      if (maxChars > 0 && chunks.join(' ').length >= maxChars) break;
    }
    if (maxChars > 0 && chunks.join(' ').length >= maxChars) break;
  }

  // Fallback: if per-element scan found nothing (e.g. viewport inside
  // a <pre> or the first section has only images), take the section's
  // whole text.
  if (chunks.length === 0) {
    for (let i = 0; i < host.spineLength; i++) {
      const sec = host.sectionElement(i);
      if (!sec) continue;
      const r = sec.getBoundingClientRect();
      if (r.right <= 0 || r.bottom <= 0) continue;
      if (r.left >= vw || r.top >= vh) continue;
      const t = (sec.textContent ?? '').trim();
      if (t) { chunks.push(t); break; }
    }
  }

  let out = chunks.join(' ').replace(/\s+/g, ' ').trim();
  if (maxChars > 0 && out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

function copyText(text: string): void {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };
  try {
    navigator.clipboard.writeText(text).catch(fallback);
  } catch {
    fallback();
  }
}

function fetchFile(url: string): Promise<Blob> {
  // fetch() doesn't work with file:// on Android WebView. XHR does when
  // allowFileAccess is enabled.
  if (url.startsWith('file://')) {
    return new Promise<Blob>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.onload = () => (xhr.status === 200 || xhr.status === 0)
        ? resolve(xhr.response)
        : reject(new Error(`XHR failed: ${xhr.status}`));
      xhr.onerror = () => reject(new Error('XHR network error'));
      xhr.send();
    });
  }
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.blob();
  });
}

function showError(msg: string): void {
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'none';
  const err = document.getElementById('error');
  if (err) {
    err.style.display = 'flex';
    err.textContent = msg;
  }
}

boot();
