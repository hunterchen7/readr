/// <reference lib="dom" />
/**
 * Render host — owns the shadow-DOM container, the per-section divs,
 * the theme/CSS-variable pipeline, and the scroll/paginated layout
 * modes. Everything book-content related lives inside a single shadow
 * tree so book stylesheets can't leak to the reader UI (and vice
 * versa).
 */

import type { ParsedBook, SpineItem } from './parser';

export interface Theme {
  bg?: string;
  fg?: string;
  fontSize?: number;
  lineHeight?: number;
  fontWeight?: number;
  fontFamily?: string;
  margin?: number;
  marginV?: number;
  tapToTurn?: boolean;
  pageTurnMode?: 'tap' | 'swipe' | 'both' | 'scroll';
  isEink?: boolean;
}

export type LayoutMode = 'scroll' | 'paginated';

export interface HostCallbacks {
  onSelection(text: string, range: Range, sectionIndex: number, rect: DOMRect): void;
  onSelectionCleared(): void;
  onTap(zone: 'left' | 'center' | 'right'): void;
  onProgressUpdated(detail: ProgressDetail): void;
  onDebug(msg: string): void;
}

export interface ProgressDetail {
  fraction: number;
  sectionIndex: number;
  sectionHref: string;
  chapterLabel: string | null;
  currentPage: number | null;
  totalPages: number | null;
  pageInSection: number | null;
  pagesInSection: number | null;
  /** True while the update is a transient scroll-driven update. */
  transient: boolean;
}

const BUNDLED_FONTS = [
  'Literata', 'Lora', 'Merriweather', 'EB Garamond', 'Source Serif 4',
  'Noto Serif', 'Crimson Text', 'Libre Baskerville', 'Playfair Display',
  'PT Serif', 'Roboto Slab', 'Roboto', 'Open Sans', 'Inter', 'Nunito',
  'Fira Mono', 'IBM Plex Mono',
];

function fontFaceCSS(): string {
  return BUNDLED_FONTS.map((f) => {
    const file = f.replace(/\s+/g, '');
    return `@font-face{font-family:'${f}';src:url('file:///android_asset/fonts/${file}.ttf')}`;
  }).join('\n');
}

export class RenderHost {
  readonly book: ParsedBook;
  private shadowRoot: ShadowRoot;
  private contentEl: HTMLElement;
  /** One DIV per spine item, in spine order. */
  private sectionEls: HTMLElement[] = [];
  /** Cached per-section page-counts (paginated mode only). */
  private sectionPageCounts: number[] = [];
  private totalPages: number = 0;
  private currentTheme: Theme = {};
  private mode: LayoutMode = 'paginated';
  private themeStyle: HTMLStyleElement;
  private bookStyle: HTMLStyleElement;
  private cb: HostCallbacks;
  /**
   * Layout anchor — the (sectionIdx, elementRef, textOffset) most
   * recently reported to the host. Preserved across mode switches so
   * the visible content stays the same before/after the flip.
   */
  private lastAnchor: LayoutAnchor | null = null;
  /** Map section index → byte-weighted cumulative fraction of book start. */
  private sectionStartFractions: number[] = [];
  /** Number of characters per section (proxy for bytes; stable enough). */
  private sectionSizes: number[] = [];
  private totalSize: number = 0;
  /** Debounce timer for scroll-driven progress updates. */
  private scrollRaf = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * True once the initial restore navigation has completed OR the user
   * has interacted with the book. Until then, setTheme-induced layout
   * changes DON'T scroll to the captured anchor — that anchor is the
   * cover (since the host is still at scrollLeft=0 before goToLocation
   * lands), and its scrollToAnchor fights the concurrent applySavedRestore
   * on the RN side, yanking the viewport back to section 0.
   */
  private navigated = false;

  /**
   * Wall-clock epoch. While `now() < scrollReportMutedUntil`, scroll
   * events do NOT trigger progress reports. We use this to protect the
   * mode-flip's anchor-based report from being immediately overwritten
   * by a new captureAnchor from the post-scroll settle listener that
   * (because of CSS-column spillover across section boundaries) would
   * probe into an earlier-reading-order section.
   */
  private scrollReportMutedUntil = 0;

  constructor(host: HTMLElement, book: ParsedBook, cb: HostCallbacks) {
    this.book = book;
    this.cb = cb;
    this.shadowRoot = host.attachShadow({ mode: 'open' });

    this.themeStyle = document.createElement('style');
    this.themeStyle.id = 'readr-theme';
    this.bookStyle = document.createElement('style');
    this.bookStyle.id = 'readr-book-styles';

    const host2 = document.createElement('style');
    host2.textContent = this.hostCss();

    this.contentEl = document.createElement('div');
    this.contentEl.id = 'book-content';
    this.contentEl.dataset.mode = this.mode;

    this.shadowRoot.append(host2, this.themeStyle, this.bookStyle, this.contentEl);

    this.computeSectionSizes();
    this.mountSections();
    // Materialize section 0 immediately so first paint has real content.
    this.materializeSection(0);
    this.wireListeners();
  }

  // ─── Theme / CSS-variable layer ────────────────────────────────────

  private hostCss(): string {
    return `
      :host {
        display: block;
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        background: var(--bg, #fff);
        color: var(--fg, #111);
        font-family: var(--font-family, serif);
        font-size: var(--font-size, 16px);
        line-height: var(--line-height, 1.6);
        font-weight: var(--font-weight, 400);
      }
      #book-content {
        width: 100vw;
        height: 100vh;
        box-sizing: border-box;
        padding: 0;
        margin: 0;
        outline: none;
      }
      /* Layout is identical in both modes — block flow, vertical
       * scroll. Mode toggle only changes the snap behavior + tap/swipe
       * handling. Zero CSS reflow on mode flip (the single biggest
       * source of lag on e-ink Supernote) and no multi-column math
       * anywhere — each "page" is simply one viewport height tall. */
      #book-content {
        overflow-y: auto;
        overflow-x: hidden;
        scroll-behavior: auto;
      }
      #book-content[data-mode="paginated"] {
        /* Snap each page boundary to the top of the viewport so the
         * page turn feels discrete. scroll-padding-top + scroll-margin
         * aren't needed because section spacing is internal. */
        scroll-snap-type: y mandatory;
        /* No horizontal drag — the tap/swipe layer provides page
         * advance. Keep pan-y so the native vertical gesture still
         * drives the snap scroller. */
        touch-action: pan-y;
      }
      section.spine-section {
        box-sizing: border-box;
        /* Vertical paragraph breathing only; horizontal handled by the
         * per-paragraph padding below. */
      }
      #book-content[data-mode="paginated"] section.spine-section {
        padding: var(--margin-v, 24px) var(--margin-h, 48px);
      }
      #book-content[data-mode="scroll"] section.spine-section {
        padding: var(--margin-v, 24px) var(--margin-h, 48px);
        padding-bottom: calc(var(--margin-v, 24px) + 1em);
      }

      /* Theme safety: force bg/fg inheritance through book DOM. */
      section.spine-section * {
        max-width: 100%;
      }
      section.spine-section img,
      section.spine-section svg,
      section.spine-section picture {
        max-width: 100% !important;
        height: auto !important;
      }
      /* Annotation overlay container (positioned by annotations module). */
      svg.readr-annot-layer {
        position: absolute;
        pointer-events: none;
        overflow: visible;
      }
    `;
  }

  setTheme(theme: Theme): void {
    const prev = this.currentTheme;
    this.currentTheme = theme;

    // Capture an anchor BEFORE applying the CSS. After reflow, the
    // element's layout position may shift hundreds of columns, leaving
    // `getBoundingClientRect()` outside the viewport — which breaks both
    // our "is lastAnchor still in view?" check and any re-probing at
    // the fixed viewport point. Freezing the anchor pre-change gives
    // the post-change scrollToAnchor a stable element to seek back to.
    const willChangeLayout = this.layoutSig(theme) !== this.layoutSig(prev)
      || (theme.pageTurnMode === 'scroll' ? 'scroll' : 'paginated') !== this.mode;
    let preAnchor: LayoutAnchor | null = null;
    if (willChangeLayout) {
      if (this.lastAnchor?.element?.isConnected) {
        const r = this.lastAnchor.element.getBoundingClientRect();
        const inView = r.right > 0 && r.bottom > 0
          && r.left < window.innerWidth && r.top < window.innerHeight;
        if (inView) preAnchor = this.lastAnchor;
      }
      if (!preAnchor) preAnchor = this.captureAnchor();
    }

    // Push CSS variables to shadow :host via the outer host element.
    const hostEl = this.shadowRoot.host as HTMLElement;
    hostEl.style.setProperty('--bg', theme.bg ?? '#fff');
    hostEl.style.setProperty('--fg', theme.fg ?? '#111');
    hostEl.style.setProperty('--font-size', `${theme.fontSize ?? 16}px`);
    hostEl.style.setProperty('--line-height', String(theme.lineHeight ?? 1.6));
    hostEl.style.setProperty('--font-weight', String(theme.fontWeight ?? 400));
    hostEl.style.setProperty('--font-family', theme.fontFamily || 'serif');
    hostEl.style.setProperty('--margin-h', `${theme.margin ?? 48}px`);
    hostEl.style.setProperty('--margin-v', `${theme.marginV ?? 24}px`);

    // Force document-level bg to match so the status-bar / body area
    // never flashes a different colour than the reader.
    document.documentElement.style.background = theme.bg ?? '#fff';
    document.body.style.background = theme.bg ?? '#fff';

    // Theme CSS — book content override rules.
    this.themeStyle.textContent = this.buildThemeCss(theme);

    // Layout mode flip. Preserve the anchor so content visually stays
    // put (same paragraph in view) across the switch. We also force
    // the post-flip progress report to use the preserved anchor
    // rather than re-probing — after a flip the fixed probe point
    // would land on content earlier in reading order (an earlier
    // column's spillover content), dragging the reported section
    // backward by one unit.
    const nextMode: LayoutMode = theme.pageTurnMode === 'scroll' ? 'scroll' : 'paginated';
    if (nextMode !== this.mode) {
      this.mode = nextMode;
      this.contentEl.dataset.mode = nextMode;
      // Layout is identical in both modes (block flow, overflow-y:
      // auto); only the snap CSS + tap/swipe handling differ. So the
      // user's visible content is UNCHANGED across the flip — no
      // reflow, no cover, no anchor dance. If we're going into
      // paginated, snap the current scrollTop to the nearest vh so
      // subsequent taps land on clean boundaries.
      if (nextMode === 'paginated') {
        this.snapToNearestPage();
      }
      this.cb.onDebug(`modeFlip to=${nextMode} scrollTop=${this.contentEl.scrollTop}`);
      // Still invalidate page counts so the next report recomputes
      // (currentPage/totalPages depend on vh, which may differ if the
      // keyboard is open etc.).
      this.sectionPageCounts = [];
      this.sectionPageStart = [];
      this.reportProgress(false);
    } else {
      const layoutChanged = this.layoutSig(theme) !== this.layoutSig(prev);
      if (layoutChanged) {
        const anchor = preAnchor;
        const skipAnchor = !this.navigated;
        this.scrollReportMutedUntil = performance.now() + 3000;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (anchor && !skipAnchor) this.scrollToAnchor(anchor);
            this.sectionPageCounts = [];
            this.sectionPageStart = [];
            if (anchor && !skipAnchor) this.reportProgressFor(anchor, false);
          });
        });
      }
    }
  }

  private layoutSig(t: Theme): string {
    return JSON.stringify([
      t.fontSize, t.lineHeight, t.fontFamily, t.fontWeight,
      t.margin, t.marginV,
    ]);
  }

  private buildThemeCss(theme: Theme): string {
    const eink = !!theme.isEink;
    const fg = theme.fg ?? '#111';
    const lh = theme.lineHeight ?? 1.6;
    const fw = theme.fontWeight ?? 400;
    const ff = theme.fontFamily || 'serif';
    const fs = theme.fontSize ?? 16;
    const parts: string[] = [
      fontFaceCSS(),
      // The section root inherits host typography, but ALSO gets
      // explicit values so when we change a theme knob the book's own
      // CSS (which often sets `line-height: 1.4`, `font-family`, etc.
      // on body or paragraphs) doesn't stomp on us. Use !important
      // because book stylesheets almost always use plain rules.
      `section.spine-section, section.spine-section * {`,
      `  color: ${fg} !important;`,
      `  background: transparent !important;`,
      `  background-color: transparent !important;`,
      `  background-image: none !important;`,
      `  border-color: ${fg} !important;`,
      `  text-shadow: none !important;`,
      `  line-height: ${lh} !important;`,
      `  font-weight: ${fw} !important;`,
      `  font-family: ${ff}, serif !important;`,
      `}`,
      // Root font-size drives em/rem sizing throughout the shadow DOM.
      // Apply to the section root only — not `*` — so the book's own
      // ems stay relative (headings stay 2em, etc.).
      `section.spine-section { font-size: ${fs}px !important; }`,
      // Strip decorative borders / shadows the book may have set.
      `section.spine-section *:not(table):not(th):not(td):not(hr) {`,
      `  border: 0 !important;`,
      `  box-shadow: none !important;`,
      `  outline: 0 !important;`,
      `}`,
      // Keep link underlines visible.
      `section.spine-section a { text-decoration: underline; color: ${fg} !important; }`,
    ];
    if (eink) {
      parts.push(
        `section.spine-section * { animation: none !important; transition: none !important; filter: none !important; }`,
        `section.spine-section img { filter: grayscale(100%) contrast(1.15) !important; }`,
      );
    }
    return parts.join('\n');
  }

  // ─── Section mounting ──────────────────────────────────────────────

  private computeSectionSizes(): void {
    this.sectionSizes = this.book.spine.map((s) => Math.max(1, s.bodyHtml.length));
    this.totalSize = this.sectionSizes.reduce((a, b) => a + b, 0);
    this.sectionStartFractions = new Array(this.book.spine.length + 1);
    let running = 0;
    for (let i = 0; i < this.book.spine.length; i++) {
      this.sectionStartFractions[i] = this.totalSize > 0 ? running / this.totalSize : 0;
      running += this.sectionSizes[i] ?? 0;
    }
    this.sectionStartFractions[this.book.spine.length] = 1;
  }

  /** Spine indices whose innerHTML has been populated. */
  private materialized = new Set<number>();
  /** Queue of spine indices to lazy-materialize on idle. */
  private lazyQueue: number[] = [];
  private lazyInflight = false;

  /** Callback fired when a section transitions from placeholder to real
   *  content — used by the annotations layer to replay highlights/notes
   *  that hadn't yet been drawable. */
  private onSectionMaterialized: ((index: number) => void) | null = null;

  /** Register a listener for section-materialized events. */
  setSectionMaterializedHandler(fn: (index: number) => void): void {
    this.onSectionMaterialized = fn;
  }

  private mountSections(): void {
    // Aggregate book-provided CSS into one <style> element inside the
    // shadow. Each spine item's styles are namespaced to the section
    // via an attribute selector so rules from one chapter don't bleed
    // into another.
    const allStyles: string[] = [];
    for (const s of this.book.spine) {
      if (s.styles.trim()) {
        allStyles.push(`/* section ${s.index} */\n` + scopeCss(s.styles, s.index));
      }
    }
    this.bookStyle.textContent = allStyles.join('\n\n');

    // Mount every spine section's HTML up-front. Lazy-mount was tried
    // and reverted — empty placeholder sections with estimated heights
    // don't give the scroll container enough total height for paging
    // to work (nextPage would clamp to scrollHeight - vh, which with
    // ~100px placeholders was often smaller than vh itself). Re-add
    // lazy materialization only after page counts + anchor math have
    // been proven robust against it.
    for (const s of this.book.spine) {
      const el = document.createElement('section');
      el.className = 'spine-section';
      el.dataset.idx = String(s.index);
      el.dataset.href = s.href;
      el.dataset.path = s.path;
      el.setAttribute('data-readr-section', String(s.index));
      el.innerHTML = s.bodyHtml;
      this.contentEl.appendChild(el);
      this.sectionEls.push(el);
      this.materialized.add(s.index);
    }
  }

  /** Populate a placeholder section with its actual HTML content.
   *  Idempotent. */
  materializeSection(index: number): void {
    if (this.materialized.has(index)) return;
    const el = this.sectionEls[index];
    const spine = this.book.spine[index];
    if (!el || !spine) return;
    el.innerHTML = spine.bodyHtml;
    el.style.minHeight = '';
    this.materialized.add(index);
    // Page counts are no longer accurate — drop them so the next
    // reportProgress recomputes. Cheaper than eagerly remeasuring on
    // every single materialize tick.
    this.sectionPageCounts = [];
    this.sectionPageStart = [];
    if (this.onSectionMaterialized) {
      try { this.onSectionMaterialized(index); } catch { /* ignore */ }
    }
  }

  /** Ensure the target section and `radius` neighbors on each side are
   *  materialized. Called from navigation + scroll-settle paths. */
  ensureMaterializedAround(center: number, radius = 1): void {
    const lo = Math.max(0, center - radius);
    const hi = Math.min(this.book.spine.length - 1, center + radius);
    for (let i = lo; i <= hi; i++) this.materializeSection(i);
  }

  /** Kick off a background drain that materializes remaining sections
   *  during browser idle time. Runs one at a time so it never stalls
   *  input events. */
  startBackgroundMaterialize(): void {
    if (this.lazyInflight) return;
    this.lazyQueue = [];
    for (let i = 0; i < this.book.spine.length; i++) {
      if (!this.materialized.has(i)) this.lazyQueue.push(i);
    }
    if (this.lazyQueue.length === 0) return;
    this.lazyInflight = true;
    const drain = () => {
      const next = this.lazyQueue.shift();
      if (next == null) { this.lazyInflight = false; return; }
      this.materializeSection(next);
      this.scheduleIdle(drain);
    };
    this.scheduleIdle(drain);
  }

  private scheduleIdle(fn: () => void): void {
    // Prefer requestIdleCallback — Chromium supports it in WebView.
    // Fall back to requestAnimationFrame on older WebView builds.
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback(fn, { timeout: 500 });
    } else {
      requestAnimationFrame(() => requestAnimationFrame(fn));
    }
  }

  // ─── Event wiring ──────────────────────────────────────────────────

  private wireListeners(): void {
    this.contentEl.addEventListener('click', (e) => {
      const w = window.innerWidth;
      const x = e.clientX;
      const zone: 'left' | 'center' | 'right' =
        x < w * 0.2 ? 'left' : x > w * 0.8 ? 'right' : 'center';
      this.cb.onTap(zone);
    });

    // Paginated mode: snap the vertical scroll to vh multiples on
    // touchend. The layout is identical to scroll mode (block flow,
    // overflow-y: auto) so mode-flip has zero reflow cost — only the
    // snap behavior differs. We listen to touchend (not scrollend) so
    // the snap happens after the user's fling naturally decelerates,
    // consistent with Kindle/Apple Books behaviour.
    this.contentEl.addEventListener('touchend', () => {
      if (this.mode !== 'paginated') return;
      // Let the browser's inertia finish first, then snap.
      requestAnimationFrame(() => requestAnimationFrame(() => this.snapToNearestPage()));
    }, { passive: true });

    // Selection — debounced via selectionchange.
    let selTimer: ReturnType<typeof setTimeout> | null = null;
    this.shadowRoot.addEventListener('selectionchange', () => {
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(() => this.emitSelectionOrClear(), 150);
    });
    // Shadow roots don't always fire selectionchange on Android WebView;
    // also listen to pointerup as a backup.
    this.shadowRoot.addEventListener('pointerup', () => {
      setTimeout(() => this.emitSelectionOrClear(), 80);
    });
    document.addEventListener('selectionchange', () => {
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(() => this.emitSelectionOrClear(), 150);
    });

    this.contentEl.addEventListener('scroll', () => {
      if (performance.now() < this.scrollReportMutedUntil) return;
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        if (performance.now() < this.scrollReportMutedUntil) return;
        this.reportProgress(true);
        // As the user scrolls, keep the window of materialized sections
        // in front of them. Uses the anchor's section as the center.
        const anchor = this.captureAnchor();
        if (anchor) this.ensureMaterializedAround(anchor.sectionIndex, 1);
      });
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        if (performance.now() < this.scrollReportMutedUntil) return;
        this.reportProgress(false);
      }, 250);
    });
  }

  private emitSelectionOrClear(): void {
    const sel = getShadowSelection(this.shadowRoot);
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      const range = sel.getRangeAt(0);
      const sectionEl = findAncestor(range.startContainer, (el) => el.classList?.contains('spine-section'));
      const sectionIdx = sectionEl ? Number(sectionEl.dataset.idx) : -1;
      const rect = range.getBoundingClientRect();
      this.cb.onSelection(sel.toString(), range, sectionIdx, rect);
    } else {
      this.cb.onSelectionCleared();
    }
  }

  // ─── Layout anchors ────────────────────────────────────────────────

  captureAnchor(): LayoutAnchor | null {
    // Find the topmost element currently in the viewport. Probe along
    // the top edge first so the captured element is the one whose
    // SCREEN-Y is closest to 0 — that minimises visual jump on a mode
    // flip, since `scrollToAnchor` lands the captured element at y=0
    // in the new layout. Probing deeper (y=10%vh) used to push the
    // anchor 300px down, so post-flip everything jerked up by 300px.
    // Sweep across the row at increasing y so we still find content
    // when the very top is empty (section padding, leading whitespace).
    const ys = [4, 12, 24, 48, window.innerHeight * 0.1, window.innerHeight * 0.2];
    const xs = [
      window.innerWidth * 0.25,
      window.innerWidth * 0.5,
      window.innerWidth * 0.75,
      window.innerWidth * 0.1,
    ];
    for (const py of ys) {
      for (const px of xs) {
        const hit = this.elementAtShadowPoint(px, py);
        if (!hit) continue;
        const section = findAncestor(hit, (el) => el.classList?.contains('spine-section'));
        if (!section) continue;
        const sectionIdx = Number(section.dataset.idx);
        return { sectionIndex: sectionIdx, element: hit };
      }
    }
    // Fallback: find the first section whose bounds intersect the
    // current viewport, anchor at its root.
    for (let i = 0; i < this.sectionEls.length; i++) {
      const sec = this.sectionEls[i];
      if (!sec) continue;
      const r = sec.getBoundingClientRect();
      if (r.right <= 0 || r.bottom <= 0) continue;
      if (r.left >= window.innerWidth || r.top >= window.innerHeight) continue;
      return { sectionIndex: i, element: sec };
    }
    // Nothing visible — default to first section so callers have
    // something to report.
    const first = this.sectionEls[0];
    return first ? { sectionIndex: 0, element: first } : null;
  }

  scrollToAnchor(anchor: LayoutAnchor): void {
    this.ensureMaterializedAround(anchor.sectionIndex, 1);
    const target = anchor.element;
    if (!target?.isConnected) {
      this.scrollToSection(anchor.sectionIndex);
      return;
    }
    this.scrollElementIntoView(target);
    this.navigated = true;
  }

  scrollToSection(index: number): void {
    this.ensureMaterializedAround(index, 1);
    const sec = this.sectionEls[index];
    if (!sec) return;
    this.scrollElementIntoView(sec);
    this.navigated = true;
  }

  /**
   * Scroll inside `sectionIndex` to the position corresponding to
   * `globalFraction` (0..1, book-wide). Used by the resume path: the
   * saved CFI pins the SECTION (so we never cross a boundary), and
   * the global fraction supplies within-section precision via the
   * known per-section start/end fractions.
   */
  scrollToSectionFraction(sectionIndex: number, globalFraction: number | undefined): void {
    this.ensureMaterializedAround(sectionIndex, 1);
    const sec = this.sectionEls[sectionIndex];
    if (!sec) return;
    if (typeof globalFraction !== 'number') {
      this.scrollToSection(sectionIndex);
      return;
    }
    const f = Math.max(0, Math.min(1, globalFraction));
    const secStart = this.sectionStartFractions[sectionIndex] ?? 0;
    const secEnd = this.sectionStartFractions[sectionIndex + 1] ?? 1;
    const span = Math.max(0.0001, secEnd - secStart);
    // Clamp the within-section fraction to [0, 1) — if `f` is past
    // `secEnd` the saved progress was likely on a section boundary; we
    // round DOWN to keep the user in this section rather than the next.
    const withinSec = Math.max(0, Math.min(0.9999, (f - secStart) / span));

    // Both modes now share block layout; position is just scrollTop.
    // Paginated additionally snaps the resulting scrollTop to the
    // nearest vh boundary so we land cleanly on a page edge.
    const contentRect = this.contentEl.getBoundingClientRect();
    const secRect = sec.getBoundingClientRect();
    const absSecTop = this.contentEl.scrollTop + secRect.top - contentRect.top;
    const raw = Math.max(0, absSecTop + withinSec * sec.offsetHeight);
    const vh = window.innerHeight;
    const target = this.mode === 'paginated'
      ? Math.round(raw / vh) * vh
      : raw;
    this.contentEl.scrollLeft = 0;
    this.contentEl.scrollTop = target;
    this.navigated = true;
  }

  scrollToRange(range: Range): void {
    // Anchor-align to a range's start container. Prefer the parent
    // element over raw text nodes since elements have useful bounds.
    let node: Node | null = range.startContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (node && (node as HTMLElement).getBoundingClientRect) {
      this.scrollElementIntoView(node as HTMLElement);
    }
  }

  /**
   * Scroll the content container so `el` is at the top-left of the
   * viewport for the current mode. Uses explicit scrollTo math
   * (rather than scrollIntoView) so it works deterministically even
   * immediately after a mode flip, when the element's `offsetParent`
   * chain may not yet match the post-flip scroll container.
   */
  private scrollElementIntoView(el: HTMLElement): void {
    const contentRect = this.contentEl.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const targetTop = rect.top - contentRect.top + this.contentEl.scrollTop;
    // Paginated mode: snap to the nearest full-page boundary so the
    // element lands at the top of a page. In scroll mode: land the
    // element exactly at viewport top (no snap).
    const vh = window.innerHeight;
    const finalTop = this.mode === 'paginated'
      ? Math.max(0, Math.round(targetTop / vh) * vh)
      : Math.max(0, targetTop);
    this.contentEl.scrollLeft = 0;
    this.contentEl.scrollTop = finalTop;
  }

  /** Scroll to a fraction of the whole book (0..1). */
  scrollToFraction(fraction: number): void {
    const f = Math.max(0, Math.min(1, fraction));
    // Find section containing this fraction. Use f < end (strict) so an
    // exact-boundary fraction lands on the STARTING section (the one
    // whose start == f), not the preceding section whose end == f.
    let idx = this.book.spine.length - 1;
    for (let i = 0; i < this.book.spine.length; i++) {
      const start = this.sectionStartFractions[i] ?? 0;
      const end = this.sectionStartFractions[i + 1] ?? 1;
      if (f >= start && f < end) { idx = i; break; }
    }
    this.ensureMaterializedAround(idx, 1);
    const sec = this.sectionEls[idx];
    if (!sec) return;
    const start = this.sectionStartFractions[idx] ?? 0;
    const end = this.sectionStartFractions[idx + 1] ?? 1;
    const withinSec = end > start ? (f - start) / (end - start) : 0;

    // Both modes share block layout — compute the target scrollTop and
    // snap to vh in paginated.
    const rect = sec.getBoundingClientRect();
    const absTop = this.contentEl.scrollTop + rect.top - this.contentEl.getBoundingClientRect().top;
    const raw = Math.max(0, absTop + withinSec * sec.offsetHeight);
    const vh = window.innerHeight;
    const target = this.mode === 'paginated' ? Math.round(raw / vh) * vh : raw;
    this.contentEl.scrollLeft = 0;
    this.contentEl.scrollTop = target;
    this.navigated = true;
  }

  // ─── Page counting ─────────────────────────────────────────────────

  /** Per-section start-page index (in the book-wide page count). */
  private sectionPageStart: number[] = [];

  recountPages(): void {
    // Both modes share block layout: a "page" is one viewport height
    // worth of scroll. Pure scrollHeight / clientHeight math — no
    // Range scanning, no getClientRects loops. Orders of magnitude
    // cheaper than the old multi-column traversal.
    const vh = window.innerHeight;
    if (vh <= 0) return;
    const totalHeight = this.contentEl.scrollHeight;
    this.totalPages = Math.max(1, Math.ceil(totalHeight / vh));

    const sectionPages: number[] = [];
    const sectionStart: number[] = [];
    const contentTop = this.contentEl.getBoundingClientRect().top;
    const scrollTop = this.contentEl.scrollTop;
    let runningPage = 0;
    for (let i = 0; i < this.sectionEls.length; i++) {
      const el = this.sectionEls[i];
      if (!el) { sectionPages.push(1); sectionStart.push(runningPage); runningPage += 1; continue; }
      const rect = el.getBoundingClientRect();
      const absTop = rect.top - contentTop + scrollTop;
      const startPage = Math.max(0, Math.floor(absTop / vh));
      sectionStart.push(startPage);
      const secHeight = el.offsetHeight;
      const secPages = Math.max(1, Math.ceil(secHeight / vh));
      sectionPages.push(secPages);
      runningPage = startPage + secPages;
    }
    this.sectionPageCounts = sectionPages;
    this.sectionPageStart = sectionStart;
  }

  // ─── Progress reporting ────────────────────────────────────────────

  currentFraction(): number {
    if (this.mode === 'scroll') {
      const max = this.contentEl.scrollHeight - this.contentEl.clientHeight;
      if (max <= 0) return 0;
      return Math.max(0, Math.min(1, this.contentEl.scrollTop / max));
    }
    const max = this.contentEl.scrollWidth - this.contentEl.clientWidth;
    if (max <= 0) return 0;
    return Math.max(0, Math.min(1, this.contentEl.scrollLeft / max));
  }

  /**
   * Report current progress up to the host callback. `transient`
   * updates are high-frequency (scroll-driven) and shouldn't trigger
   * persistence.
   */
  reportProgress(transient: boolean): void {
    this.reportProgressFor(this.captureAnchor(), transient);
  }

  reportProgressFor(anchor: LayoutAnchor | null, transient: boolean): void {
    if (!anchor) return;
    // Only update lastAnchor from NON-transient reports — transient
    // reports during scroll can briefly anchor on a section-boundary
    // element (e.g. next section's first heading crosses into the
    // probe point mid-scroll), which would then become stale by the
    // time the user taps to toggle mode. Non-transient reports fire
    // after scroll settles, reflecting the final viewport.
    if (!transient) this.lastAnchor = anchor;
    const section = this.book.spine[anchor.sectionIndex];
    if (!section) return;

    // Compute a book-level fraction weighted by section sizes.
    const sectionStart = this.sectionStartFractions[anchor.sectionIndex] ?? 0;
    const sectionEnd = this.sectionStartFractions[anchor.sectionIndex + 1] ?? 1;
    const sectionSpan = Math.max(0, sectionEnd - sectionStart);
    // Position of anchor within its own section.
    const withinSec = this.anchorFractionWithinSection(anchor);
    const bookFraction = sectionStart + withinSec * sectionSpan;

    // Page counts. Paginated mode derives currentPage directly from
    // scrollLeft / viewport width — withinSec drifted per-tap but
    // didn't advance the reported page fast enough (the probe element
    // is roughly the same % through the section whether we're on page
    // 3 or page 4 of it). scrollLeft is the ground truth.
    let currentPage: number | null = null;
    let totalPages: number | null = null;
    let pageInSection: number | null = null;
    let pagesInSection: number | null = null;
    // Make sure page counts reflect the CURRENT mode. If we're e.g.
    // freshly resumed in scroll mode but `sectionPageStart` is stale
    // from a previous paginated render, the column-based math below
    // would return wrong numbers. Cheap to call — just measures.
    if (this.sectionPageCounts.length !== this.book.spine.length) {
      this.recountPages();
    }
    if (this.sectionPageCounts.length === this.book.spine.length) {
      totalPages = Math.max(1, Math.ceil(this.contentEl.scrollHeight / window.innerHeight));
      const vh = window.innerHeight;
      const scrollTop = this.contentEl.scrollTop;
      // Both modes use the same scroll-axis math now: a page is one
      // viewport height. Paginated snaps scrollTop to vh boundaries,
      // so floor(scrollTop / vh) + 1 always lands on the expected
      // page number. Scroll mode uses the same formula — it's just
      // not snapped, so the reported page advances smoothly.
      currentPage = Math.max(1, Math.min(totalPages, Math.floor(scrollTop / vh) + 1));
      const sec = this.sectionEls[anchor.sectionIndex];
      if (sec) {
        const contentTop = this.contentEl.getBoundingClientRect().top;
        const secRect = sec.getBoundingClientRect();
        const absSecTop = scrollTop + secRect.top - contentTop;
        const secPages = this.sectionPageCounts[anchor.sectionIndex] ?? 1;
        pageInSection = Math.max(1, Math.min(secPages, Math.floor((scrollTop - absSecTop) / vh) + 1));
        pagesInSection = secPages;
      }
    }

    this.cb.onDebug(`emit progressUpdated sec=${anchor.sectionIndex} frac=${bookFraction.toFixed(4)} transient=${transient} scrollLeft=${this.contentEl.scrollLeft}`);
    this.cb.onProgressUpdated({
      fraction: bookFraction,
      sectionIndex: anchor.sectionIndex,
      sectionHref: section.href,
      chapterLabel: null, // set by caller via TOC lookup
      currentPage,
      totalPages,
      pageInSection,
      pagesInSection,
      transient,
    });
  }

  private anchorFractionWithinSection(anchor: LayoutAnchor): number {
    const sec = this.sectionEls[anchor.sectionIndex];
    if (!sec) return 0;
    const secHeight = sec.offsetHeight;
    if (secHeight <= 0) return 0;
    const anchorRect = anchor.element.getBoundingClientRect();
    const secRect = sec.getBoundingClientRect();
    const contentTop = this.contentEl.getBoundingClientRect().top;
    const absSecTop = this.contentEl.scrollTop + secRect.top - contentTop;
    const absAnchorTop = this.contentEl.scrollTop + anchorRect.top - contentTop;
    return Math.max(0, Math.min(1, (absAnchorTop - absSecTop) / secHeight));
  }

  // ─── Prev/next page ────────────────────────────────────────────────

  prevPage(): void {
    const vh = window.innerHeight;
    // Paginated: jump exactly one viewport up, landing on a snap
    // boundary. Scroll mode: shorter step so the user can see a bit
    // of overlap between pages.
    const step = this.mode === 'paginated' ? vh : vh * 0.9;
    const current = this.contentEl.scrollTop;
    const target = this.mode === 'paginated'
      ? Math.max(0, Math.round(current / vh) * vh - vh)
      : Math.max(0, current - step);
    this.contentEl.scrollTop = target;
  }

  nextPage(): void {
    const vh = window.innerHeight;
    const step = this.mode === 'paginated' ? vh : vh * 0.9;
    const current = this.contentEl.scrollTop;
    const target = this.mode === 'paginated'
      ? Math.round(current / vh) * vh + vh
      : current + step;
    this.contentEl.scrollTop = target;
  }

  /** Align scrollTop to the nearest `vh` boundary. Called on touchend
   *  in paginated mode so the user always lands cleanly on a page. */
  private snapToNearestPage(): void {
    const vh = window.innerHeight;
    if (vh <= 0) return;
    const current = this.contentEl.scrollTop;
    const snapped = Math.round(current / vh) * vh;
    if (Math.abs(current - snapped) > 0.5) {
      this.contentEl.scrollTop = snapped;
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private elementAtShadowPoint(x: number, y: number): HTMLElement | null {
    // Try shadow-root elementsFromPoint first (Chrome-specific), fall
    // back to document-level which pierces shadow boundaries. Returns
    // the specific element at the point (validated to be inside a
    // spine section) — NOT the section itself. Returning the section
    // would collapse every probe to the same rect and the progress
    // calc would always see withinSec=0.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sr = this.shadowRoot as any;
    let els: Element[] = [];
    if (typeof sr.elementsFromPoint === 'function') {
      els = sr.elementsFromPoint(x, y) ?? [];
    }
    if (!els.length) {
      els = document.elementsFromPoint(x, y) ?? [];
    }
    for (const el of els) {
      if (!(el as HTMLElement).closest?.('section.spine-section')) continue;
      // Prefer text-bearing blocks; skip the section wrapper itself
      // (using it as anchor collapses withinSec to 0).
      if ((el as HTMLElement).classList?.contains('spine-section')) continue;
      return el as HTMLElement;
    }
    // Nothing inner — the only candidate was the section wrapper. Let
    // the caller decide how to handle (fallback chain runs next).
    return null;
  }

  /** Expose spine item list for navigation by href. */
  findSectionByHref(href: string): SpineItem | null {
    const want = normalizeHref(href);
    for (const s of this.book.spine) {
      if (normalizeHref(s.href) === want) return s;
    }
    // Fall back to path-only match (strip fragment from both).
    const wantPath = want.split('#')[0];
    for (const s of this.book.spine) {
      if ((s.href.split('#')[0] ?? s.href) === wantPath) return s;
    }
    return null;
  }

  get spineLength(): number { return this.book.spine.length; }
  get currentMode(): LayoutMode { return this.mode; }
  get currentAnchor(): LayoutAnchor | null { return this.lastAnchor; }
  get contentElement(): HTMLElement { return this.contentEl; }
  get shadow(): ShadowRoot { return this.shadowRoot; }

  /** Get the Document object for a given section (we store sanitized DOM). */
  sectionDoc(index: number): Document | null {
    return this.book.spine[index]?.doc ?? null;
  }
  sectionElement(index: number): HTMLElement | null {
    return this.sectionEls[index] ?? null;
  }

  goToFragment(href: string): boolean {
    const section = this.findSectionByHref(href);
    if (!section) return false;
    const frag = href.includes('#') ? href.split('#')[1] : null;
    if (frag) {
      // Look up the element by ID inside the rendered section div.
      const sec = this.sectionEls[section.index];
      if (sec) {
        const el = sec.querySelector(`#${CSS.escape(frag)}`);
        if (el) {
          this.scrollToAnchor({ sectionIndex: section.index, element: el as HTMLElement });
          this.reportProgress(false);
          return true;
        }
      }
    }
    this.scrollToSection(section.index);
    this.reportProgress(false);
    return true;
  }
}

interface LayoutAnchor {
  sectionIndex: number;
  element: HTMLElement;
}

function normalizeHref(h: string): string {
  return h.replace(/^\.\//, '');
}

function scopeCss(css: string, sectionIndex: number): string {
  // Lightweight scope: prepend every top-level selector with the section
  // attribute so book CSS only applies inside its own section. Robust
  // against all-but-the-gnarliest selector lists.
  const selectorRegex = /(^|\})\s*([^{}@]+)\s*\{/g;
  return css.replace(selectorRegex, (_m, pre, sel) => {
    const trimmed = sel.trim();
    // Leave @-rules, keyframes, etc alone.
    if (!trimmed || trimmed.startsWith('@') || trimmed.startsWith('%')) {
      return `${pre}${sel}{`;
    }
    const scopedSelectors = trimmed.split(',').map((s: string) => {
      const t = s.trim();
      if (!t) return t;
      if (t.startsWith('html') || t.startsWith('body')) {
        return `section.spine-section[data-idx="${sectionIndex}"]`;
      }
      return `section.spine-section[data-idx="${sectionIndex}"] ${t}`;
    });
    return `${pre}${scopedSelectors.join(',')}{`;
  });
}

function findAncestor<T extends Node | null>(
  start: Node | null | undefined,
  pred: (el: HTMLElement) => unknown,
): HTMLElement | null {
  let node: Node | null = start ?? null;
  while (node) {
    if (node.nodeType === 1 && pred(node as HTMLElement)) return node as HTMLElement;
    node = node.parentNode;
  }
  return null;
}

function getShadowSelection(sr: ShadowRoot): Selection | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anySr = sr as any;
  if (typeof anySr.getSelection === 'function') return anySr.getSelection();
  return document.getSelection();
}
