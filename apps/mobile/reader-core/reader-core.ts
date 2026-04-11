/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Platform-agnostic EPUB reader core. Used to live inline in
 * webview-src/reader.ts, which ran only inside the Android WebView
 * and talked to the RN host via window.ReactNativeWebView. When the
 * web reader started sharing the same logic, we pulled the stateful
 * pieces out into this factory — the webview shim and the Expo-Web
 * screen both instantiate a ReaderCore and wire it up to whichever
 * transport they have.
 *
 * What's in here:
 *   - foliate-view lifecycle (create, open, goTo, prev/next)
 *   - theme CSS generation + application
 *   - tap handlers, selection relay, page-turn zones
 *   - hidden measurement view for accurate page counts
 *   - annotation replay across section unloads
 *   - same JSON event protocol as before
 *
 * What's NOT in here:
 *   - the HTML shell (loading div, error div, transition cover) —
 *     those belong to whichever host mounts the core
 *   - `window.__foliate` / `window.__READR_CONFIG` / `ReactNativeWebView`
 *     lookups — all injected via `deps`
 *   - the file:// XHR fallback — the native shim passes a fetcher
 *     that knows how to handle file:// URLs; web just uses fetch()
 */

// ─── Foliate type slices (no official d.ts) ─────────────────────────────

export interface FoliateTocItem {
  label: string;
  href: string;
  subitems?: FoliateTocItem[];
}
export interface FoliateBook {
  sections: Array<{ id?: string; createDocument(): Promise<Document> }>;
  toc?: FoliateTocItem[];
  search?(q: string): AsyncIterable<{ cfi: string; excerpt: string; label: string }>;
}
export interface FoliateOverlayer {
  highlight: unknown;
  underline: unknown;
  squiggly: unknown;
}
export interface FoliateRenderer extends HTMLElement {
  page?: number;
  pages?: number;
  setStyles?(styles: string | [string, string]): void;
  getContents?(): Array<{ doc: Document; index: number }>;
}
export interface FoliateView extends HTMLElement {
  open(book: FoliateBook): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  goTo(target: any): Promise<unknown>;
  goToFraction(f: number): Promise<unknown>;
  prev(): Promise<unknown>;
  next(): Promise<unknown>;
  clearSearch?(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addAnnotation?(ann: any, remove?: boolean): void;
  getCFI?(index: number, range: Range): string;
  getSectionFractions?(): number[];
  renderer?: FoliateRenderer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastLocation?: any;
}

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
  pageTurnMode?: "tap" | "swipe" | "both";
  isEink?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReaderMessage = { type: string; payload?: any };

// ─── Core deps + handle ─────────────────────────────────────────────────

export interface ReaderCoreDeps {
  /** foliate-js makeBook function. Injected so the core doesn't
   *  need to know whether foliate arrived via a script tag
   *  (native) or a dynamic ESM import (web). */
  makeBook: (file: File) => Promise<FoliateBook>;
  /** foliate-js Overlayer namespace. Needed for draw-annotation
   *  styling (highlight / squiggly / underline). */
  Overlayer: FoliateOverlayer;
  /** Where to mount the <foliate-view> element. */
  container: HTMLElement;
  /** Emit an event back to the host (progressUpdated, toc,
   *  selectionChanged, tapCenter, etc). Same payload shape as the
   *  old `post()` helper. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEvent: (type: string, payload: any) => void;
  /** Fetch a book binary as a Blob. Native uses XHR for file://
   *  URLs (allowFileAccess); web just uses fetch(). */
  fetchBookFile: (url: string) => Promise<Blob>;
  /** Base URL to resolve bundled @font-face src against. Native
   *  passes `file:///android_asset/fonts`; web can pass null to
   *  skip @font-face entirely and let the browser fall back. */
  fontBaseUrl?: string | null;
  /** Optional hook fired whenever the theme bg/fg changes so the
   *  host can paint its own chrome. The native shim uses this to
   *  keep <html>/<body> in sync; web is a no-op because the RN
   *  overlays already read `theme` from state. */
  onThemeChange?: (bg: string, fg: string) => void;
}

export interface ReaderCoreHandle {
  init(bookUrl: string): Promise<void>;
  dispatch(data: ReaderMessage): void;
  destroy(): void;
}

// ─── Bundled fonts ──────────────────────────────────────────────────────

const BUNDLED_FONTS = [
  "Literata", "Lora", "Merriweather", "EB Garamond", "Source Serif 4",
  "Noto Serif", "Crimson Text", "Libre Baskerville", "Playfair Display",
  "PT Serif", "Roboto Slab", "Roboto", "Open Sans", "Inter", "Nunito",
  "Fira Mono", "IBM Plex Mono",
];

function fontFaceCSS(fontBaseUrl: string | null | undefined): string {
  if (!fontBaseUrl) return "";
  return BUNDLED_FONTS.map((f) => {
    const file = f.replace(/\s+/g, "");
    return `@font-face{font-family:'${f}';src:url('${fontBaseUrl}/${file}.ttf')}`;
  }).join("\n");
}

// ─── Pure helpers ───────────────────────────────────────────────────────

export interface FlatTocItem {
  label: string;
  href: string;
  depth: number;
}

function flattenToc(toc: FoliateTocItem[], depth = 0): FlatTocItem[] {
  const items: FlatTocItem[] = [];
  for (const item of toc) {
    items.push({ label: item.label, href: item.href, depth });
    if (item.subitems) items.push(...flattenToc(item.subitems, depth + 1));
  }
  return items;
}

function layoutSignature(t: Theme): string {
  return JSON.stringify([
    t.margin ?? null,
    t.marginV ?? null,
    t.fontSize ?? null,
    t.fontFamily ?? null,
    t.fontWeight ?? null,
    t.lineHeight ?? null,
  ]);
}

function buildThemeCSS(theme: Theme, fontBaseUrl: string | null | undefined): string {
  const eink = !!theme.isEink;
  const fg = theme.fg || "#111";
  const fs = theme.fontSize || 16;
  const lh = theme.lineHeight || 1.6;
  const fw = theme.fontWeight || 400;
  const ff = theme.fontFamily || "";
  const marginH = theme.margin ?? 48;

  const base = [
    fontFaceCSS(fontBaseUrl),
    // Keep the iframe completely transparent so the host's theme bg
    // shows through — no inner/outer colour mismatch possible, even
    // while a mid-transition section is still carrying old styles.
    `html, body { background: transparent !important; }`,
    // Force ALL elements: color, transparent bg, typography, no borders.
    // Books embed their own stylesheets that add decorative borders in
    // hard-coded colours (sepia rules, beige dividers, etc) which stay
    // stale through theme changes. Kill them all — the theme's
    // typography should speak for itself.
    "* {",
    `  color: ${fg} !important;`,
    `  background: transparent !important;`,
    `  background-color: transparent !important;`,
    `  background-image: none !important;`,
    `  border: 0 !important;`,
    `  outline: 0 !important;`,
    `  box-shadow: none !important;`,
    `  line-height: ${lh} !important;`,
    `  font-weight: ${fw} !important;`,
    ff ? `  font-family: ${ff} !important;` : "",
    "}",
    // Tables still need their grid to be readable — restore a minimal
    // themed border for table cells only.
    `table, th, td { border: 1px solid ${fg} !important; border-collapse: collapse !important; }`,
    `html { font-size: ${fs}px !important; }`,
    // Horizontal page inset lives inside the section document. Vertical
    // top/bottom gutter comes from foliate's paginator `margin`
    // attribute, which is the renderer primitive intended for it.
    `body { margin: 0 !important; padding: 0 ${marginH}px !important; box-sizing: border-box !important; }`,
    "img { max-width: 100% !important; height: auto !important; background-color: transparent !important; }",
    "a, a:link, a:visited { text-decoration: underline; }",
  ];

  if (eink) {
    base.push(
      "img { filter: grayscale(100%) contrast(1.15); }",
      "* {",
      "  text-shadow: none !important;",
      "  animation: none !important;",
      "  transition: none !important;",
      "  filter: none !important;",
      "}",
      "img { filter: grayscale(100%) contrast(1.15) !important; }",
      `a, a:link, a:visited, a:hover { color: ${fg} !important; text-decoration: underline; }`,
    );
  }

  return base.join("\n");
}

// ─── Factory ────────────────────────────────────────────────────────────

export function createReaderCore(deps: ReaderCoreDeps): ReaderCoreHandle {
  // State that used to live at module level in reader.ts. Still a
  // mutable graph — translating to a class would just rename
  // `let view` to `this.view` without buying anything.
  let view: FoliateView | null = null;
  let book: FoliateBook | null = null;
  let bookFile: File | null = null;
  let tapToTurn = true;
  let swipeEnabled = true;
  let currentSectionDoc: Document | null = null;
  let sectionPageCounts: Record<number, number> = {};
  let sectionPageCountsLocked = false;
  let currentThemeCSS = "";
  let currentTheme: Theme = {};
  const noteCfis = new Map<string, "typed" | "handwritten">();
  const highlightRegistry = new Map<string, string>();
  let lastLayoutSig: string | null = null;

  // Measurement (hidden foliate view) state.
  let _measureSeq = 0;
  let _measureRunning = false;
  let destroyed = false;

  // Track the host-document click listener so destroy() can remove it.
  // Native WebView has no leak — tearing down the WebView also kills
  // `document` — but on web this listener attaches to the host page's
  // document, which outlives the reader screen, so every reader open
  // would accrue a captured handleTap closure otherwise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hostDocClickListener: ((e: any) => void) | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function post(type: string, payload: any): void {
    if (destroyed) return;
    deps.onEvent(type, payload);
  }

  // Compute progressUpdated payload from a foliate location detail
  // and post it. Reads view.renderer state directly because that's
  // the live source for per-section display values.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function computeAndPostProgress(d: any): void {
    if (!d || !view) return;
    const frac: number = d.fraction ?? 0;
    const totalSections = book?.sections?.length ?? 1;
    const secIdx = Math.max(0, Math.min(totalSections - 1, d.section?.current ?? 0));

    const rPages = view.renderer?.pages;
    const rPage = view.renderer?.page;
    const pagesInSection = typeof rPages === "number" && rPages > 2 ? rPages - 2 : 1;
    const pageInSection = typeof rPage === "number" && typeof rPages === "number" && rPages > 2
      ? Math.max(1, Math.min(pagesInSection, rPage))
      : 1;

    let currentPage: number;
    let totalPages: number;
    let totalIsEstimate: boolean;

    if (sectionPageCountsLocked) {
      if (typeof rPages === "number" && rPages > 2) {
        const runtimeCount = rPages - 2;
        if (sectionPageCounts[secIdx] !== runtimeCount) {
          sectionPageCounts[secIdx] = runtimeCount;
        }
      }

      const sectionFractions = view.getSectionFractions?.() ?? [];
      const measuredPages = sectionPageCounts[secIdx] ?? 1;
      let pageInSectionMeasured = 1;
      if (measuredPages > 1) {
        const sectionStart = sectionFractions[secIdx] ?? (secIdx / totalSections);
        const sectionEnd = sectionFractions[secIdx + 1] ?? ((secIdx + 1) / totalSections);
        const sectionSpan = Math.max(0, sectionEnd - sectionStart);
        const sectionFrac = sectionSpan > 0
          ? Math.min(1, Math.max(0, (frac - sectionStart) / sectionSpan))
          : 0;
        pageInSectionMeasured = Math.max(
          1,
          Math.min(measuredPages, Math.round(sectionFrac * measuredPages) || 1),
        );
      }
      totalPages = 0;
      let pagesBefore = 0;
      for (let i = 0; i < totalSections; i++) {
        const count = sectionPageCounts[i] ?? 1;
        if (i < secIdx) pagesBefore += count;
        totalPages += count;
      }
      totalPages = Math.max(1, totalPages);
      currentPage = Math.max(1, Math.min(totalPages, pagesBefore + pageInSectionMeasured));
      totalIsEstimate = false;
    } else {
      const loc = d.location;
      totalPages = loc?.total ?? 1;
      currentPage = loc?.current != null ? loc.current + 1 : 1;
      totalIsEstimate = true;
    }

    post("progressUpdated", {
      percentage: Math.round(frac * 1000) / 10,
      cfi: d.cfi,
      chapter: d.tocItem?.label,
      chapterHref: d.tocItem?.href,
      sectionIndex: secIdx,
      currentPage,
      totalPages,
      pageInSection,
      pagesInSection,
      totalIsEstimate,
    });
  }

  // ─── Theming ──────────────────────────────────────────────────────────

  function injectThemeIntoDoc(doc: Document | null): void {
    if (!doc || !currentThemeCSS) return;
    try {
      let style = doc.getElementById("readr-theme") as HTMLStyleElement | null;
      if (!style) {
        style = doc.createElement("style");
        style.id = "readr-theme";
        (doc.head || doc.documentElement).appendChild(style);
      }
      style.textContent = currentThemeCSS;
    } catch { /* ignore */ }
  }

  function injectThemeIntoAllDocs(): void {
    try {
      const contents = view?.renderer?.getContents?.() ?? [];
      for (const c of contents) injectThemeIntoDoc(c.doc);
    } catch { /* ignore */ }
    if (currentSectionDoc) injectThemeIntoDoc(currentSectionDoc);
  }

  function applyThemeStyles(): void {
    if (!currentThemeCSS) return;
    try {
      view?.renderer?.setStyles?.(currentThemeCSS);
    } catch { /* ignore */ }
    injectThemeIntoAllDocs();
  }

  function applyTheme(theme: Theme): void {
    const prevTheme = currentTheme;
    currentTheme = theme;
    const sig = layoutSignature(theme);
    const isFirst = lastLayoutSig == null;
    const layoutChanged = isFirst || sig !== lastLayoutSig;
    lastLayoutSig = sig;
    post("debug", {
      msg: `applyTheme isFirst=${isFirst} layoutChanged=${layoutChanged} prevBg=${prevTheme.bg} newBg=${theme.bg}`,
    });

    // Colour work (cheap, no reflow).
    const bgColor = theme.bg || "#fff";
    const fgColor = theme.fg || "#111";
    deps.container.style.background = bgColor;
    if (view) {
      view.style.background = bgColor;
      forceShadowBackground(view, bgColor);
    }
    // Let the host (native shim or RN screen) paint its own chrome.
    deps.onThemeChange?.(bgColor, fgColor);

    // Page-turn mode (not layout-affecting).
    const mode: "tap" | "swipe" | "both" =
      theme.pageTurnMode ?? (theme.tapToTurn === false ? "swipe" : "both");
    tapToTurn = mode !== "swipe";
    swipeEnabled = mode !== "tap";

    currentThemeCSS = buildThemeCSS(theme, deps.fontBaseUrl);
    applyThemeStyles();

    const renderer = view?.renderer;
    if (!renderer) return;

    if (!layoutChanged) return;

    // Layout-affecting attributes on the paginator.
    renderer.setAttribute("flow", "paginated");
    renderer.setAttribute("gap", "0%");
    renderer.setAttribute("max-inline-size", "99999px");
    renderer.setAttribute("max-block-size", "99999px");
    renderer.setAttribute("margin", `${theme.marginV ?? 24}px`);
    sectionPageCounts = {};
    sectionPageCountsLocked = false;
    _measureSeq++;
    post("debug", {
      msg: `applyTheme triggered remeasure seq=${_measureSeq} margin=${theme.margin} marginV=${theme.marginV} fs=${theme.fontSize} ff=${theme.fontFamily}`,
    });
    requestAnimationFrame(() => {
      void runMeasurement();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function forceShadowBackground(host: any, bgColor: string): void {
    try {
      const sr: ShadowRoot | null = host.shadowRoot;
      if (!sr) return;
      let srStyle = sr.getElementById("readr-sr-theme") as HTMLStyleElement | null;
      if (!srStyle) {
        srStyle = document.createElement("style");
        srStyle.id = "readr-sr-theme";
        sr.prepend(srStyle);
      }
      srStyle.textContent =
        `:host{background:${bgColor}!important}` +
        `*{background:${bgColor}!important;border:0!important;outline:0!important;box-shadow:none!important;column-rule:none!important}` +
        "iframe{border:none!important}";
      for (const el of sr.querySelectorAll("*")) {
        const s = (el as HTMLElement).style;
        s.setProperty("background", bgColor, "important");
        s.setProperty("border", "0", "important");
        s.setProperty("outline", "0", "important");
        s.setProperty("box-shadow", "none", "important");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anySr = sr as any;
      if (!anySr._readrObserver) {
        anySr._readrObserver = new MutationObserver(() => {
          const bg = currentTheme?.bg || "#fff";
          for (const el of sr.querySelectorAll("*")) {
            (el as HTMLElement).style.setProperty("background", bg, "important");
            (el as HTMLElement).style.setProperty("border-color", "transparent", "important");
          }
        });
        anySr._readrObserver.observe(sr, { childList: true, subtree: true });
      }
    } catch { /* ignore */ }
  }

  // ─── Measurement (page counts via a hidden foliate instance) ─────────

  async function runMeasurement(): Promise<void> {
    if (_measureRunning) return;
    _measureRunning = true;

    try {
      while (true) {
        const mySeq = _measureSeq;
        const ok = await measureOnce(mySeq);
        if (ok && mySeq === _measureSeq) break;
        if (mySeq === _measureSeq) break;
      }
    } finally {
      _measureRunning = false;
    }
  }

  async function measureOnce(mySeq: number): Promise<boolean> {
    if (!view || !bookFile) return false;

    const vw = view.clientWidth || window.innerWidth;
    const vh = view.clientHeight || window.innerHeight || 800;
    if (vw <= 0 || vh <= 0) return false;

    const host = document.createElement("div");
    host.id = "readr-measure-host";
    host.style.cssText =
      "position:fixed;left:-99999px;top:0;" +
      `width:${vw}px;height:${vh}px;` +
      "visibility:hidden;pointer-events:none;";
    document.body.appendChild(host);

    const t0 = Date.now();
    post("debug", {
      msg: `measure start seq=${mySeq} vw=${vw} vh=${vh} margin=${currentTheme.margin} marginV=${currentTheme.marginV} fs=${currentTheme.fontSize}`,
    });
    try {
      const mbook = await deps.makeBook(bookFile);
      if (mySeq !== _measureSeq) return false;
      if (!mbook.sections?.length) return true;

      const mview = document.createElement("foliate-view") as FoliateView;
      host.appendChild(mview);
      await mview.open(mbook);
      if (mySeq !== _measureSeq) return false;

      const r = mview.renderer;
      if (r) {
        r.setAttribute("flow", "paginated");
        r.setAttribute("gap", "0%");
        r.setAttribute("max-inline-size", "99999px");
        r.setAttribute("max-block-size", "99999px");
        r.setAttribute("margin", `${currentTheme.marginV ?? 24}px`);
        if (currentThemeCSS) r.setStyles?.(currentThemeCSS);
      }

      try { await document.fonts?.ready; } catch { /* ignore */ }

      const total = mbook.sections.length;
      const counts: number[] = new Array(total).fill(1);

      for (let i = 0; i < total; i++) {
        if (mySeq !== _measureSeq) return false;
        try {
          await mview.goTo(i);
        } catch (err) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          post("debug", { msg: `measure goTo ${i} failed: ${(err as any)?.message || err}` });
          continue;
        }

        try {
          const contents = mview.renderer?.getContents?.() ?? [];
          for (const c of contents) {
            if (c.doc?.fonts?.ready) await c.doc.fonts.ready;
          }
        } catch { /* ignore */ }

        let stable = mview.renderer?.pages ?? 0;
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise<void>((r2) => setTimeout(r2, 16));
          const cur = mview.renderer?.pages ?? 0;
          if (cur > 0 && cur === stable) break;
          stable = cur;
        }
        counts[i] = stable > 2 ? stable - 2 : 1;

        await new Promise<void>((r2) => setTimeout(r2, 0));
      }

      if (mySeq !== _measureSeq) return false;

      const next: Record<number, number> = {};
      let totalPages = 0;
      for (let i = 0; i < total; i++) {
        next[i] = counts[i];
        totalPages += counts[i];
      }
      sectionPageCounts = next;
      sectionPageCountsLocked = true;
      post("debug", {
        msg: `measure done seq=${mySeq}: ${total} sections, ${totalPages} pages in ${Date.now() - t0}ms`,
      });
      post("pagesComputed", { totalPages, measured: total, total });

      try {
        const last = view?.lastLocation;
        if (last) computeAndPostProgress(last);
      } catch { /* ignore */ }
      return true;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      post("debug", { msg: `measure failed: ${(err as any)?.message || err}` });
      return false;
    } finally {
      try { host.remove(); } catch { /* ignore */ }
    }
  }

  // ─── Search ──────────────────────────────────────────────────────────

  async function performSearch(query: string): Promise<void> {
    if (!book || !query || !book.search) return;
    try {
      const results: Array<{ cfi: string; excerpt: string; section: string }> = [];
      for await (const result of book.search(query)) {
        results.push({ cfi: result.cfi, excerpt: result.excerpt, section: result.label });
        if (results.length >= 100) break;
      }
      post("searchResults", { results, query });
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      post("searchResults", { results: [], query, error: (err as any)?.message });
    }
  }

  // ─── Clipboard fallback ──────────────────────────────────────────────

  function copyTextToClipboard(text: string): void {
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    };
    try {
      navigator.clipboard.writeText(text).catch(fallback);
    } catch {
      fallback();
    }
  }

  // ─── Dispatch (formerly handleRNMessage) ─────────────────────────────

  function handleMessage(data: ReaderMessage): void {
    if (!view) return;
    switch (data.type) {
      case "setTheme":
        applyTheme(data.payload);
        break;
      case "goToLocation":
        if (data.payload.cfi) view.goTo(data.payload.cfi);
        else if (data.payload.fraction != null) view.goToFraction(data.payload.fraction);
        break;
      case "goToChapter":
        if (data.payload.href) {
          try {
            view.goTo(data.payload.href);
          } catch {
            try { view.goTo({ href: data.payload.href }); } catch { /* ignore */ }
          }
        }
        break;
      case "prevPage":
        view.prev();
        break;
      case "nextPage":
        view.next();
        break;
      case "search":
        performSearch(data.payload.query);
        break;
      case "clearSearch":
        if (view.clearSearch) view.clearSearch();
        break;
      case "getPageText": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = (currentSectionDoc?.body as any)?.innerText?.trim() ?? "";
        post("pageText", { text });
        break;
      }
      case "copyToClipboard": {
        const text: string = data.payload.text || "";
        if (text) copyTextToClipboard(text);
        break;
      }
      case "addHighlight": {
        const cfi = data.payload.cfi || data.payload.cfiRange;
        if (!cfi) break;
        const color = data.payload.color || "yellow";
        highlightRegistry.set(cfi, color);
        if (view.addAnnotation) {
          try {
            view.addAnnotation({ value: cfi, color, kind: "highlight" });
          } catch (err) {
            post("highlightError", { cfi, error: String(err) });
          }
        }
        break;
      }
      case "removeHighlight": {
        const cfi = data.payload.cfi || data.payload.cfiRange;
        if (!cfi || !view.addAnnotation) break;
        highlightRegistry.delete(cfi);
        try {
          view.addAnnotation({ value: cfi }, true);
        } catch { /* ignore */ }
        break;
      }
      case "addNote": {
        const cfi: string | undefined = data.payload.cfi;
        const noteType: "typed" | "handwritten" =
          data.payload.noteType === "handwritten" ? "handwritten" : "typed";
        if (!cfi || !view.addAnnotation) break;
        try {
          view.addAnnotation({ value: cfi, kind: "note", noteType });
          noteCfis.set(cfi, noteType);
        } catch (err) {
          post("noteError", { cfi, error: String(err) });
        }
        break;
      }
      case "removeNote": {
        const cfi: string | undefined = data.payload.cfi;
        if (!cfi || !view.addAnnotation) break;
        try {
          view.addAnnotation({ value: cfi }, true);
          noteCfis.delete(cfi);
        } catch { /* ignore */ }
        break;
      }
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────

  async function init(bookUrl: string): Promise<void> {
    try {
      // Check `destroyed` after every await below: React can tear
      // the core down (user navigates away, format flips to pdf,
      // remoteUrl changes) while we're mid-load. Without these
      // guards, the init continues to run on a half-zombie core,
      // eventually hitting `view.addEventListener(...)` with `view`
      // null'd out by destroy() and throwing silently — harmless
      // because post() is a no-op on destroyed cores, but it
      // keeps pdfjs/foliate doing work for a dead screen and
      // attaches event listeners that outlive their intended scope.
      const blob = await deps.fetchBookFile(bookUrl);
      if (destroyed) return;
      const file = new File([blob], "book.epub", {
        type: blob.type || "application/epub+zip",
      });
      bookFile = file;

      book = await deps.makeBook(file);
      if (destroyed) return;

      view = document.createElement("foliate-view") as FoliateView;
      deps.container.appendChild(view);
      await view.open(book);
      if (destroyed) return;
      view.renderer?.setAttribute("flow", "paginated");
      view.renderer?.setAttribute("gap", "0%");
      view.renderer?.setAttribute("max-inline-size", "99999px");
      view.renderer?.setAttribute("max-block-size", "99999px");
      view.renderer?.setAttribute("margin", `${currentTheme.marginV ?? 24}px`);

      const attachedDocs = new WeakSet<Document>();

      function attachTapHandlers(doc: Document | null): void {
        if (!doc || attachedDocs.has(doc)) return;
        attachedDocs.add(doc);
        doc.addEventListener("click", handleTap);
        doc.addEventListener("touchmove", blockSwipe, {
          capture: true,
          passive: false,
        });
        // Suppress the native WebView long-press / right-click menu
        // when a selection exists — our ContextMenu is taking over
        // in that case. With no selection (right-clicking blank
        // space on web), fall through so the browser's default menu
        // still works.
        doc.addEventListener("contextmenu", (ev) => {
          const sel = doc!.getSelection?.();
          if (sel && !sel.isCollapsed && sel.toString().trim()) {
            ev.preventDefault();
            ev.stopPropagation();
            return false;
          }
        });
        let selDebounce: ReturnType<typeof setTimeout> | null = null;
        function checkSelection() {
          const sel = doc!.getSelection?.();
          if (sel && sel.toString().trim() && sel.rangeCount > 0 && !sel.isCollapsed) {
            let cfi = "";
            let rect: { x: number; y: number; w: number; h: number } | null = null;
            try {
              const range = sel.getRangeAt(0);
              const contents = view?.renderer?.getContents?.() ?? [];
              const content = contents.find((c) => c.doc.contains(range.startContainer));
              if (content && view?.getCFI) cfi = view.getCFI(content.index, range) ?? "";
              const r = range.getBoundingClientRect();
              let ox = 0, oy = 0;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let win: any = doc!.defaultView;
              while (win && win !== window && win.frameElement) {
                const fr = win.frameElement.getBoundingClientRect();
                ox += fr.left;
                oy += fr.top;
                win = win.parent;
              }
              rect = { x: r.left + ox, y: r.top + oy, w: r.width, h: r.height };
            } catch { /* ignore */ }
            post("selectionChanged", { text: sel.toString(), cfi, rect });
          } else {
            post("selectionCleared", {});
          }
        }
        doc.addEventListener("selectionchange", () => {
          if (selDebounce) clearTimeout(selDebounce);
          selDebounce = setTimeout(checkSelection, 200);
        });
        doc.addEventListener("pointerup", () => {
          setTimeout(checkSelection, 80);
        });
      }

      function ensureAllDocsAttached(): void {
        try {
          const contents = view?.renderer?.getContents?.() ?? [];
          for (const c of contents) attachTapHandlers(c.doc);
        } catch { /* ignore */ }
      }

      function blockSwipe(e: TouchEvent): void {
        if (swipeEnabled) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      }

      function handleTap(e: MouseEvent): void {
        // When the tap came from outside the reader container
        // (e.g. clicks on RN overlays rendered next to the container
        // on the web reader screen), leave it alone. The host page's
        // own buttons handle those clicks. Native WebView is a
        // closed DOM so this filter is a no-op there.
        const eventTarget = e.target as Node | null;
        if (eventTarget && !deps.container.contains(eventTarget)) {
          return;
        }

        try {
          const d = ((e.view as Window | null) || window).document ?? document;
          const sel = d.getSelection?.() ?? window.getSelection?.();
          if (sel && !sel.isCollapsed && sel.toString().trim()) {
            sel.removeAllRanges();
            post("selectionCleared", {});
            return;
          }
        } catch { /* ignore */ }

        // Use clientX (viewport-relative) for the tap-zone math,
        // not screenX. On web, the browser window can be offset
        // from the physical screen origin (secondary monitor, split
        // screen), so screenX is meaningless for "left 20% of the
        // viewport" — every tap would land in the right zone. On
        // native WebView the two are equivalent because the view
        // covers the whole screen. `??` wouldn't have saved us
        // here — both properties are always non-null numbers on a
        // real click event.
        const w = window.innerWidth || screen.width;
        const x = e.clientX;
        if (tapToTurn && view) {
          if (x < w * 0.2) { view.prev(); return; }
          if (x > w * 0.8) { view.next(); return; }
        }
        post("tapCenter", {});
      }
      view.addEventListener("click", handleTap as EventListener);
      // Track the host-doc listener so destroy() can pull it off. See the
      // `hostDocClickListener` declaration for why this matters on web.
      hostDocClickListener = handleTap as EventListener;
      document.addEventListener("click", hostDocClickListener);
      view.addEventListener("touchmove", blockSwipe as EventListener, {
        capture: true,
        passive: false,
      });

      view.addEventListener("relocate", (e) => {
        ensureAllDocsAttached();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        computeAndPostProgress((e as CustomEvent).detail as any);
      });

      view.addEventListener("draw-annotation", (e) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { draw, annotation } = (e as CustomEvent).detail ?? ({} as any);
        if (!draw || !annotation) return;
        if (annotation.kind === "note") {
          const eink = !!currentTheme?.isEink;
          if (annotation.noteType === "handwritten") {
            draw((deps.Overlayer as unknown as { underline: unknown }).underline, { color: eink ? "#000" : "#6366f1" });
          } else {
            draw((deps.Overlayer as unknown as { squiggly: unknown }).squiggly, { color: eink ? "#000" : "#d97706" });
          }
        } else {
          const color = annotation.color || "yellow";
          draw((deps.Overlayer as unknown as { highlight: unknown }).highlight, { color });
        }
      });

      view.addEventListener("show-annotation", (e) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ann = (e as CustomEvent).detail ?? ({} as any);

        let rect: { x: number; y: number; w: number; h: number } | null = null;
        try {
          const range: Range | undefined = ann.range;
          if (range) {
            const r = range.getBoundingClientRect();
            const doc = range.startContainer?.ownerDocument ?? null;
            let ox = 0, oy = 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let win: any = doc?.defaultView;
            while (win && win !== window && win.frameElement) {
              const fr = win.frameElement.getBoundingClientRect();
              ox += fr.left;
              oy += fr.top;
              win = win.parent;
            }
            rect = { x: r.left + ox, y: r.top + oy, w: r.width, h: r.height };
          }
        } catch { /* ignore */ }

        if (ann.value && noteCfis.has(ann.value)) {
          post("noteTapped", { cfi: ann.value, noteType: noteCfis.get(ann.value), rect });
        } else {
          post("showAnnotation", { value: ann.value, index: ann.index, rect });
        }
      });

      view.addEventListener("create-overlay", () => {
        if (!view?.addAnnotation) return;
        for (const [cfi, color] of highlightRegistry) {
          try {
            view.addAnnotation({ value: cfi, color, kind: "highlight" });
          } catch { /* ignore */ }
        }
        for (const [cfi, noteType] of noteCfis) {
          try {
            view.addAnnotation({ value: cfi, kind: "note", noteType });
          } catch { /* ignore */ }
        }
      });

      view.addEventListener("load", (e) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detail = (e as CustomEvent).detail as any;
        if (detail?.doc) {
          currentSectionDoc = detail.doc as Document;
          injectThemeIntoDoc(currentSectionDoc);
          attachTapHandlers(currentSectionDoc);
        }
      });

      view.addEventListener("external-link", (e) => {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detail = (e as CustomEvent).detail as any;
        post("externalLink", { href: detail.href });
      });

      try {
        await view.goTo(book.toc?.[0]?.href ?? book.sections?.[0]?.id ?? 0);
      } catch { /* ignore */ }
      if (destroyed) return;
      ensureAllDocsAttached();

      post("ready", {});

      if (book.toc) post("tocLoaded", { chapters: flattenToc(book.toc) });
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      post("error", { message: (err as any)?.message ?? String(err) });
      throw err;
    }
  }

  function destroy(): void {
    destroyed = true;
    // Pull the host-doc click listener we attached in init(). Other
    // listeners (on the <foliate-view> element and on section docs
    // inside its iframes) die with the view when we remove it from
    // the DOM, but this one is on the outer document and would
    // otherwise leak a handleTap closure per reader session.
    if (hostDocClickListener) {
      try {
        document.removeEventListener("click", hostDocClickListener);
      } catch { /* ignore */ }
      hostDocClickListener = null;
    }
    try {
      if (view && view.parentElement === deps.container) {
        deps.container.removeChild(view);
      }
    } catch { /* ignore */ }
    view = null;
    book = null;
    bookFile = null;
    currentSectionDoc = null;
    sectionPageCounts = {};
    sectionPageCountsLocked = false;
    currentThemeCSS = "";
    currentTheme = {};
    noteCfis.clear();
    highlightRegistry.clear();
    lastLayoutSig = null;
  }

  return {
    init,
    dispatch: handleMessage,
    destroy,
  };
}
