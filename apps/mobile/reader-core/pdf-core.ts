/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Platform-agnostic PDF reader core, mirror of reader-core.ts but for
 * PDFs. Ports the stateful pieces of the native pdf-html.ts template
 * into a factory that takes its pdfjs module and host element via
 * `deps`, so the same file can drive the Expo Web reader screen.
 *
 * The native WebView still runs pdf-html.ts as an inline script (it
 * needs to boot without a bundler), but the event protocol and locator
 * format are identical so the RN host code doesn't care which reader
 * is underneath.
 *
 * Locator format: "pdf:<page>:<rectsJson>" — identical to pdf-html.ts.
 * RectsJson is an array of {x,y,w,h} in page-fractional coordinates.
 */

// ─── Pdfjs type slices ──────────────────────────────────────────────────
//
// We don't import pdfjs-dist types directly — the web path dynamically
// imports the ESM bundle and we just trust the runtime shape. These
// slices document the parts we touch.

interface PdfTextItem {
  str: string;
  transform: number[];
}
interface PdfViewport {
  width: number;
  height: number;
  transform: number[];
}
interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}
interface PdfPage {
  getViewport(opts: { scale: number }): PdfViewport;
  render(opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
  }): PdfRenderTask;
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}
interface PdfDocument {
  numPages: number;
  getPage(pageNum: number): Promise<PdfPage>;
}

export interface PdfjsLib {
  getDocument(src: string | { url: string } | { data: Uint8Array | ArrayBuffer }): {
    promise: Promise<PdfDocument>;
  };
  GlobalWorkerOptions: { workerSrc: string };
  Util: { transform(a: number[], b: number[]): number[] };
}

export interface PdfTheme {
  bg?: string;
  fg?: string;
  margin?: number;
  marginV?: number;
  fontFamily?: string;
  isEink?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PdfReaderMessage = { type: string; payload?: any };

export interface PdfCoreDeps {
  pdfjsLib: PdfjsLib;
  container: HTMLElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEvent: (type: string, payload: any) => void;
  /** Used to pre-fetch the PDF bytes when the URL can't be handed
   *  directly to pdfjs (e.g. blob:, http that needs auth, etc). Web
   *  currently passes this through untouched so pdfjs can fetch. */
  fetchBookFile?: (url: string) => Promise<Blob>;
}

export interface PdfCoreHandle {
  init(bookUrl: string): Promise<void>;
  dispatch(msg: PdfReaderMessage): void;
  destroy(): void;
}

function parsePdfCfi(cfi: string): { pageNum: number; rects: { x: number; y: number; w: number; h: number }[] } | null {
  if (!cfi || !cfi.startsWith("pdf:")) return null;
  const match = cfi.match(/^pdf:(\d+):(.+)$/);
  if (!match) return null;
  try {
    return { pageNum: parseInt(match[1], 10), rects: JSON.parse(match[2]) };
  } catch {
    return null;
  }
}

function cssEscape(s: string): string {
  return String(s).replace(/["\\]/g, "\\$&");
}

export function createPdfCore(deps: PdfCoreDeps): PdfCoreHandle {
  const { pdfjsLib, container, onEvent } = deps;

  let pdfDoc: PdfDocument | null = null;
  let totalPages = 0;
  let currentPage = 1;
  let destroyed = false;
  const pageWraps = new Map<number, HTMLElement>();
  // Track the in-flight pdfjs render task so destroy() can cancel
  // it. pdfjs holds a reference to the canvas until the task
  // resolves, so leaking this would keep the whole page-worth of
  // pixel buffers alive until the next GC sweep.
  let currentRenderTask: PdfRenderTask | null = null;

  // Build the scroll host. We own the container's children during
  // the reader's lifetime and clean them up on destroy().
  container.innerHTML = "";
  const host = document.createElement("div");
  host.className = "pdf-scroll";
  host.style.cssText = [
    "position:absolute",
    "inset:0",
    "overflow-y:auto",
    "overflow-x:hidden",
    "-webkit-overflow-scrolling:touch",
    "background:var(--readr-pdf-bg, #f5f5f5)",
  ].join(";");
  container.appendChild(host);

  // Inject a scoped stylesheet once per core instance. We ship it as
  // a <style> tag inside the container so it gets cleaned up when
  // the core is destroyed.
  const style = document.createElement("style");
  style.textContent = `
    .pdf-scroll { font-family: system-ui, sans-serif; }
    .pdf-scroll .page-wrap {
      position: relative;
      display: block;
      margin: 0 auto;
      background: white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .pdf-scroll .page-wrap + .page-wrap { margin-top: 8px; }
    .pdf-scroll .page-canvas { display: block; }
    .pdf-scroll .text-layer {
      position: absolute;
      inset: 0;
      overflow: hidden;
      opacity: 1;
      line-height: 1;
      -webkit-user-select: text;
      user-select: text;
    }
    .pdf-scroll .text-layer > span {
      position: absolute;
      white-space: pre;
      color: transparent;
      transform-origin: 0% 0%;
      cursor: text;
    }
    .pdf-scroll .text-layer > span::selection { background: rgba(255, 235, 59, 0.5); }
    .pdf-scroll .highlight-layer { position: absolute; inset: 0; pointer-events: none; }
    .pdf-scroll .highlight-rect {
      position: absolute;
      background: rgba(255, 235, 59, 0.35);
      mix-blend-mode: multiply;
      border-radius: 1px;
    }
    .pdf-scroll .highlight-rect[data-color="green"] { background: rgba(76, 175, 80, 0.35); }
    .pdf-scroll .highlight-rect[data-color="blue"]  { background: rgba(33, 150, 243, 0.35); }
    .pdf-scroll .highlight-rect[data-color="pink"]  { background: rgba(233, 30, 99, 0.35); }
    .pdf-scroll .highlight-rect[data-color="purple"]{ background: rgba(156, 39, 176, 0.35); }
    .pdf-scroll .note-layer { position: absolute; inset: 0; pointer-events: none; }
    .pdf-scroll .note-rect {
      position: absolute;
      background: transparent;
      pointer-events: auto;
      cursor: pointer;
    }
    .pdf-scroll .note-rect[data-note-type="typed"] { border-bottom: 2px dashed #d97706; }
    .pdf-scroll .note-rect[data-note-type="handwritten"] { border-bottom: 2px dotted #6366f1; }
    .pdf-scroll.eink .page-wrap {
      box-shadow: none;
      border: 1px solid #000;
    }
    .pdf-scroll.eink .highlight-rect {
      background: transparent !important;
      mix-blend-mode: normal;
      border: 1.5px solid #000;
      border-radius: 0;
    }
    .pdf-scroll.eink .text-layer > span::selection { background: #000; color: #fff; }
  `;
  container.appendChild(style);

  function post(type: string, payload: unknown): void {
    if (destroyed) return;
    onEvent(type, payload);
  }

  function applyTheme(theme: PdfTheme): void {
    host.style.setProperty("--readr-pdf-bg", theme.bg || "#f5f5f5");
    host.style.setProperty("--readr-pdf-fg", theme.fg || "#111");
    host.style.background = theme.bg || "#f5f5f5";
    host.style.color = theme.fg || "#111";
    host.style.fontFamily = theme.fontFamily || "system-ui, sans-serif";
    host.style.paddingLeft = (theme.margin ?? 0) + "px";
    host.style.paddingRight = (theme.margin ?? 0) + "px";
    host.style.paddingTop = (theme.marginV ?? 0) + "px";
    host.style.paddingBottom = (theme.marginV ?? 0) + "px";
    host.classList.toggle("eink", !!theme.isEink);
  }

  function scrollToPage(pageNum: number): void {
    const wrap = pageWraps.get(pageNum);
    if (wrap) {
      const behavior: ScrollBehavior = host.classList.contains("eink") ? "auto" : "smooth";
      wrap.scrollIntoView({ behavior, block: "start" });
    }
    currentPage = pageNum;
  }

  function scrollToFraction(frac: number): void {
    host.scrollTop = (host.scrollHeight - host.clientHeight) * frac;
  }

  async function renderPage(pageNum: number): Promise<HTMLElement> {
    const page = await pdfDoc!.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });
    // Fit the page to the host width, capped so we don't render
    // enormous canvases on huge monitors. The 1200px cap is ~double
    // a column of body copy at readable size.
    const targetWidth = Math.min(1200, host.clientWidth || 800);
    const fitScale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale: fitScale });

    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.dataset.page = String(pageNum);
    wrap.style.width = viewport.width + "px";
    wrap.style.height = viewport.height + "px";

    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    wrap.appendChild(canvas);

    const textLayer = document.createElement("div");
    textLayer.className = "text-layer";
    textLayer.style.width = viewport.width + "px";
    textLayer.style.height = viewport.height + "px";
    wrap.appendChild(textLayer);

    const highlightLayer = document.createElement("div");
    highlightLayer.className = "highlight-layer";
    highlightLayer.dataset.page = String(pageNum);
    wrap.appendChild(highlightLayer);

    const noteLayer = document.createElement("div");
    noteLayer.className = "note-layer";
    noteLayer.dataset.page = String(pageNum);
    wrap.appendChild(noteLayer);

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      const task = page.render({ canvasContext: ctx, viewport });
      currentRenderTask = task;
      try {
        await task.promise;
      } catch (err) {
        // Cancellation throws a RenderingCancelledException — swallow
        // it, since destroy() is the only legitimate caller. Anything
        // else re-throws.
        if (!destroyed) throw err;
      } finally {
        if (currentRenderTask === task) currentRenderTask = null;
      }
    }

    const textContent = await page.getTextContent();
    for (const item of textContent.items) {
      if (!item.str) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const span = document.createElement("span");
      span.textContent = item.str;
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const x = tx[4];
      const y = tx[5] - fontHeight;
      span.style.left = x + "px";
      span.style.top = y + "px";
      span.style.fontSize = fontHeight + "px";
      span.style.fontFamily = "serif";
      textLayer.appendChild(span);
    }

    pageWraps.set(pageNum, wrap);
    return wrap;
  }

  async function renderAllPages(): Promise<void> {
    host.innerHTML = "";
    pageWraps.clear();
    // Render pages sequentially so we stream them into the DOM in
    // reading order and the first page appears quickly. A batched
    // render would be faster for huge PDFs but users reading from
    // page 1 would sit on a blank screen.
    //
    // Check `destroyed` both before AND after each `await renderPage`:
    // the user might close the reader mid-render (each pdfjs render
    // can take 100+ms), and without the post-await check we'd keep
    // appending pages to a `host` that destroy() has already detached.
    for (let i = 1; i <= totalPages; i++) {
      if (destroyed) return;
      const wrap = await renderPage(i);
      if (destroyed) return;
      host.appendChild(wrap);
      if (i === 1) {
        // Fire a "first page painted" beat so the UI can drop its
        // loading indicator without waiting for the full render.
        post("firstPageRendered", { page: 1 });
      }
    }
  }

  let scrollTicking = false;
  function onScroll(): void {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      const max = host.scrollHeight - host.clientHeight;
      const fraction = max > 0 ? host.scrollTop / max : 0;
      // Find the first page whose top is below the viewport top —
      // that's the "current" page. Fraction math alone breaks on
      // variable-height pages.
      let page = 1;
      for (const [num, wrap] of pageWraps) {
        const top = wrap.offsetTop - host.scrollTop;
        if (top <= host.clientHeight / 3) page = num;
        else break;
      }
      if (page !== currentPage) currentPage = page;
      post("progressUpdated", {
        page: currentPage,
        currentPage: currentPage,
        totalPages,
        percentage: Math.round(fraction * 1000) / 10,
        fraction,
      });
      scrollTicking = false;
    });
  }

  function onSelectionChange(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;

    const range = sel.getRangeAt(0);
    let wrap: Node | null = range.startContainer;
    while (wrap && wrap.nodeType !== 1) wrap = wrap.parentNode;
    while (wrap && !(wrap as HTMLElement).classList?.contains("page-wrap")) {
      wrap = wrap.parentNode;
    }
    if (!wrap) return;
    // Only report selections that originated in *our* container.
    // Keeps clicks on the RN overlay chrome from getting confused
    // as reader selections.
    if (!container.contains(wrap)) return;

    const wrapEl = wrap as HTMLElement;
    const pageNum = parseInt(wrapEl.dataset.page || "0", 10);
    const wrapRect = wrapEl.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: (r.left - wrapRect.left) / wrapRect.width,
        y: (r.top - wrapRect.top) / wrapRect.height,
        w: r.width / wrapRect.width,
        h: r.height / wrapRect.height,
      }));
    if (rects.length === 0) return;

    const cfi = "pdf:" + pageNum + ":" + JSON.stringify(rects);
    const bbox = range.getBoundingClientRect();
    const rect = { x: bbox.left, y: bbox.top, w: bbox.width, h: bbox.height };
    post("selectionChanged", { text, cfi, page: pageNum, rect });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function drawHighlight(payload: any): void {
    const cfi = payload.cfi || payload.cfiRange;
    const parsed = parsePdfCfi(cfi);
    if (!parsed) return;
    const wrap = pageWraps.get(parsed.pageNum);
    if (!wrap) return;
    const layer = wrap.querySelector(".highlight-layer");
    if (!layer) return;
    for (const r of parsed.rects) {
      const div = document.createElement("div");
      div.className = "highlight-rect";
      div.dataset.cfi = cfi;
      if (payload.color) div.dataset.color = payload.color;
      div.style.left = r.x * 100 + "%";
      div.style.top = r.y * 100 + "%";
      div.style.width = r.w * 100 + "%";
      div.style.height = r.h * 100 + "%";
      layer.appendChild(div);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function drawNote(payload: any): void {
    const cfi = payload.cfi;
    const noteType = payload.noteType === "handwritten" ? "handwritten" : "typed";
    const parsed = parsePdfCfi(cfi);
    if (!parsed) return;
    const wrap = pageWraps.get(parsed.pageNum);
    if (!wrap) return;
    const layer = wrap.querySelector(".note-layer");
    if (!layer) return;
    if (layer.querySelector(`.note-rect[data-cfi="${cssEscape(cfi)}"]`)) return;
    for (const r of parsed.rects) {
      const div = document.createElement("div");
      div.className = "note-rect";
      div.dataset.cfi = cfi;
      div.dataset.noteType = noteType;
      div.style.left = r.x * 100 + "%";
      div.style.top = r.y * 100 + "%";
      div.style.width = r.w * 100 + "%";
      div.style.height = r.h * 100 + "%";
      div.addEventListener("click", (ev) => {
        ev.stopPropagation();
        post("noteTapped", { cfi, noteType });
      });
      layer.appendChild(div);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function removeAnnotationRects(payload: any, layerClass: string): void {
    const cfi = payload.cfi || payload.cfiRange;
    const parsed = parsePdfCfi(cfi);
    if (!parsed) return;
    const wrap = pageWraps.get(parsed.pageNum);
    if (!wrap) return;
    const layer = wrap.querySelector("." + layerClass);
    if (!layer) return;
    const els = layer.querySelectorAll(`[data-cfi="${cssEscape(cfi)}"]`);
    for (const el of els) el.remove();
  }

  async function performSearch(query: string): Promise<void> {
    if (!query || !pdfDoc) return;
    const results: { cfi: string; excerpt: string; section: string }[] = [];
    const needle = query.toLowerCase();
    for (let p = 1; p <= totalPages && results.length < 100; p++) {
      const page = await pdfDoc.getPage(p);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => it.str ?? "").join(" ");
      const idx = text.toLowerCase().indexOf(needle);
      if (idx >= 0) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(text.length, idx + needle.length + 60);
        results.push({
          cfi: "pdf:" + p + ":[]",
          excerpt: (start > 0 ? "…" : "") + text.slice(start, end) + "…",
          section: "Page " + p,
        });
      }
    }
    post("searchResults", { results, query });
  }

  // document-level selection listener; removed on destroy.
  document.addEventListener("selectionchange", onSelectionChange);

  async function init(bookUrl: string): Promise<void> {
    try {
      let src: string | { data: ArrayBuffer } = bookUrl;
      if (deps.fetchBookFile) {
        const blob = await deps.fetchBookFile(bookUrl);
        const buf = await blob.arrayBuffer();
        src = { data: buf };
      }

      const task = pdfjsLib.getDocument(src);
      pdfDoc = await task.promise;
      totalPages = pdfDoc.numPages;

      host.addEventListener("scroll", onScroll, { passive: true });
      await renderAllPages();

      post("ready", { totalPages });
      post("tocLoaded", {
        chapters: Array.from({ length: totalPages }, (_, i) => ({
          label: "Page " + (i + 1),
          href: String(i + 1),
          depth: 0,
        })),
      });
    } catch (err) {
      post("error", { message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  function dispatch(msg: PdfReaderMessage): void {
    if (destroyed) return;
    const data = msg.payload ?? {};
    switch (msg.type) {
      case "setTheme":
        applyTheme(data);
        break;
      case "goToLocation":
        if (data.page) scrollToPage(data.page);
        else if (data.fraction != null) scrollToFraction(data.fraction);
        else if (typeof data.cfi === "string") {
          const parsed = parsePdfCfi(data.cfi);
          if (parsed) scrollToPage(parsed.pageNum);
        }
        break;
      case "goToChapter":
        if (data.href) scrollToPage(parseInt(data.href, 10));
        break;
      case "nextPage":
        scrollToPage(Math.min(totalPages, currentPage + 1));
        break;
      case "prevPage":
        scrollToPage(Math.max(1, currentPage - 1));
        break;
      case "addHighlight":
        drawHighlight(data);
        break;
      case "removeHighlight":
        removeAnnotationRects(data, "highlight-layer");
        break;
      case "addNote":
        drawNote(data);
        break;
      case "removeNote":
        removeAnnotationRects(data, "note-layer");
        break;
      case "copyToClipboard":
        if (data.text) void navigator.clipboard?.writeText(data.text).catch(() => {});
        break;
      case "search":
        void performSearch(data.query ?? "");
        break;
    }
  }

  function destroy(): void {
    destroyed = true;
    // Cancel the in-flight pdfjs render task if any — pdfjs pins the
    // canvas + its pixel buffer until the task settles, so leaving
    // it running would keep the whole page-worth of bitmap alive
    // until the next GC cycle. The cancellation makes the awaited
    // promise reject with RenderingCancelledException, which
    // renderPage() swallows on the destroyed branch.
    if (currentRenderTask) {
      try { currentRenderTask.cancel(); } catch { /* ignore */ }
      currentRenderTask = null;
    }
    document.removeEventListener("selectionchange", onSelectionChange);
    host.removeEventListener("scroll", onScroll);
    container.innerHTML = "";
    pageWraps.clear();
    pdfDoc = null;
  }

  return { init, dispatch, destroy };
}
