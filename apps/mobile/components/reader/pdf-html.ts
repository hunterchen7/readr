/**
 * PDF reader WebView. Renders each page as a canvas + an invisible text
 * layer so the user can select, copy, highlight, and look up words the
 * same way the EPUB reader does. Highlights are stored as a list of
 * {page, rects} boxes and re-drawn on an overlay div on reopen.
 */
export function getPdfReaderHtml(bookUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      overflow: hidden;
      background: var(--bg, #f5f5f5);
      color: var(--fg, #111);
      font-family: var(--font-family, system-ui, sans-serif);
    }
    #container {
      width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      padding: var(--margin-v, 0) var(--margin-h, 0);
    }
    .page-wrap {
      position: relative;
      display: block;
      /* First/last pages sit flush with container padding; interior
         pages get a small visual gutter between them. */
      margin: 0 auto;
      background: white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .page-wrap + .page-wrap { margin-top: 8px; }
    .page-canvas { display: block; }
    .text-layer {
      position: absolute;
      inset: 0;
      overflow: hidden;
      opacity: 1;
      line-height: 1;
      -webkit-user-select: text;
      user-select: text;
    }
    .text-layer > span {
      position: absolute;
      white-space: pre;
      color: transparent;
      transform-origin: 0% 0%;
      cursor: text;
    }
    .text-layer > span::selection { background: rgba(255, 235, 59, 0.5); }
    .highlight-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .highlight-rect {
      position: absolute;
      background: rgba(255, 235, 59, 0.35);
      mix-blend-mode: multiply;
      border-radius: 1px;
    }
    .highlight-rect[data-color="green"] { background: rgba(76, 175, 80, 0.35); }
    .highlight-rect[data-color="blue"] { background: rgba(33, 150, 243, 0.35); }
    .highlight-rect[data-color="pink"] { background: rgba(233, 30, 99, 0.35); }
    .note-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .note-rect {
      position: absolute;
      background: transparent;
      pointer-events: auto;
      cursor: pointer;
    }
    .note-rect[data-note-type="typed"] { border-bottom: 2px dashed #d97706; }
    .note-rect[data-note-type="handwritten"] { border-bottom: 2px dotted #6366f1; }

    /* E-ink overrides — kill momentum scroll, transparency, animations, and
       shadows; render highlights as solid black outlines since semi-transparent
       colors collapse into ghost-gray on the A5X's ~16 gray levels. */
    body.eink #container {
      -webkit-overflow-scrolling: auto;
      scroll-behavior: auto;
    }
    body.eink * {
      animation: none !important;
      transition: none !important;
      box-shadow: none !important;
      text-shadow: none !important;
    }
    body.eink .page-wrap {
      box-shadow: none;
      border: 1px solid #000;
    }
    body.eink .highlight-rect,
    body.eink .highlight-rect[data-color="green"],
    body.eink .highlight-rect[data-color="blue"],
    body.eink .highlight-rect[data-color="pink"] {
      background: transparent;
      mix-blend-mode: normal;
      border: 1.5px solid #000;
      border-radius: 0;
    }
    body.eink .note-rect[data-note-type="typed"],
    body.eink .note-rect[data-note-type="handwritten"] {
      border-bottom-color: #000;
    }
    body.eink .text-layer > span::selection { background: #000; color: #fff; }
    #loading, #error {
      display: flex; justify-content: center; align-items: center;
      height: 100%; font-family: system-ui, sans-serif; padding: 24px; text-align: center;
    }
    #loading { color: #666; }
    #error { display: none; color: #dc2626; }
  </style>
</head>
<body>
  <div id="loading">Loading PDF...</div>
  <div id="error"></div>
  <div id="container"></div>

  <script type="module">
    const BOOK_URL = ${JSON.stringify(bookUrl)};
    let pdfDoc = null;
    let currentPage = 1;
    let totalPages = 0;
    let scale = 1;
    let rendering = false;
    // page number → wrap div ref (so we can attach highlight rects later)
    const pageWraps = new Map();

    function post(type, payload) {
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
    }

    function handleRNMessage(data) {
      switch (data.type) {
        case 'goToLocation':
          if (data.payload.page) scrollToPage(data.payload.page);
          else if (data.payload.fraction != null) scrollToFraction(data.payload.fraction);
          break;
        case 'goToChapter':
          // chapter href is a page number string for PDFs
          if (data.payload.href) scrollToPage(parseInt(data.payload.href, 10));
          break;
        case 'nextPage':
          scrollToPage(Math.min(totalPages, currentPage + 1));
          break;
        case 'prevPage':
          scrollToPage(Math.max(1, currentPage - 1));
          break;
        case 'setTheme':
          applyTheme(data.payload);
          break;
        case 'addHighlight':
          drawHighlight(data.payload);
          break;
        case 'removeHighlight':
          removeAnnotationRects(data.payload, 'highlight-layer', 'data-cfi');
          break;
        case 'addNote':
          drawNote(data.payload);
          break;
        case 'removeNote':
          removeAnnotationRects(data.payload, 'note-layer', 'data-cfi');
          break;
        case 'copyToClipboard': {
          const textToCopy = data.payload.text || '';
          if (textToCopy) {
            try {
              navigator.clipboard.writeText(textToCopy).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = textToCopy;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
              });
            } catch {
              const ta = document.createElement('textarea');
              ta.value = textToCopy;
              ta.style.position = 'fixed';
              ta.style.left = '-9999px';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
            }
          }
          break;
        }
        case 'search':
          performSearch(data.payload.query);
          break;
      }
    }

    window.addEventListener('message', (e) => {
      try { handleRNMessage(JSON.parse(e.data)); } catch {}
    });
    document.addEventListener('message', (e) => {
      try { handleRNMessage(JSON.parse(e.data)); } catch {}
    });

    function applyTheme(theme) {
      const root = document.documentElement;
      root.style.setProperty('--bg', theme.bg || '#f5f5f5');
      root.style.setProperty('--fg', theme.fg || '#111');
      if (theme.margin != null) root.style.setProperty('--margin-h', theme.margin + 'px');
      if (theme.marginV != null) root.style.setProperty('--margin-v', theme.marginV + 'px');
      if (theme.isEink) {
        document.body.classList.add('eink');
      } else {
        document.body.classList.remove('eink');
      }
    }

    function scrollToPage(pageNum) {
      const wrap = pageWraps.get(pageNum);
      if (wrap) {
        // smooth scroll causes a chain of partial refreshes on e-ink; snap instead.
        const behavior = document.body.classList.contains('eink') ? 'auto' : 'smooth';
        wrap.scrollIntoView({ behavior, block: 'start' });
      }
      currentPage = pageNum;
    }

    function scrollToFraction(frac) {
      const container = document.getElementById('container');
      container.scrollTop = (container.scrollHeight - container.clientHeight) * frac;
    }

    async function renderPage(pageNum) {
      const page = await pdfDoc.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const fitScale = scale * (window.innerWidth / baseViewport.width);
      const viewport = page.getViewport({ scale: fitScale });

      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.dataset.page = String(pageNum);
      wrap.style.width = viewport.width + 'px';
      wrap.style.height = viewport.height + 'px';

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      wrap.appendChild(canvas);

      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      textLayer.style.width = viewport.width + 'px';
      textLayer.style.height = viewport.height + 'px';
      wrap.appendChild(textLayer);

      const highlightLayer = document.createElement('div');
      highlightLayer.className = 'highlight-layer';
      highlightLayer.dataset.page = String(pageNum);
      wrap.appendChild(highlightLayer);

      const noteLayer = document.createElement('div');
      noteLayer.className = 'note-layer';
      noteLayer.dataset.page = String(pageNum);
      wrap.appendChild(noteLayer);

      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Text layer: absolutely-positioned spans per text item.
      const textContent = await page.getTextContent();
      for (const item of textContent.items) {
        if (!item.str) continue;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const span = document.createElement('span');
        span.textContent = item.str;
        const fontHeight = Math.hypot(tx[2], tx[3]);
        const x = tx[4];
        const y = tx[5] - fontHeight;
        span.style.left = x + 'px';
        span.style.top = y + 'px';
        span.style.fontSize = fontHeight + 'px';
        span.style.fontFamily = 'serif';
        textLayer.appendChild(span);
      }

      pageWraps.set(pageNum, wrap);
      return wrap;
    }

    async function renderAllPages() {
      if (rendering) return;
      rendering = true;
      const container = document.getElementById('container');
      container.innerHTML = '';
      pageWraps.clear();
      for (let i = 1; i <= totalPages; i++) {
        const wrap = await renderPage(i);
        container.appendChild(wrap);
      }
      rendering = false;
    }

    function setupScrollTracking() {
      const container = document.getElementById('container');
      let ticking = false;
      container.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          const scrollFraction = container.scrollTop / (container.scrollHeight - container.clientHeight);
          const page = Math.ceil(scrollFraction * totalPages) || 1;
          if (page !== currentPage) currentPage = page;
          post('progressUpdated', {
            page: currentPage,
            percentage: Math.round(scrollFraction * 1000) / 10,
          });
          ticking = false;
        });
      });
    }

    /**
     * Watch the document's text selection and post to RN whenever the
     * user drops a selection inside a text layer. The "cfi" we report
     * is a synthetic locator: "pdf:<page>:<rectJson>" where rectJson is
     * the array of per-line rects in the page's local coordinate system
     * (0..1 fractional so it survives scale/resize).
     */
    function setupSelectionTracking() {
      document.addEventListener('selectionchange', () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        if (!text) return;

        const range = sel.getRangeAt(0);
        // Find the containing page-wrap by walking up the DOM
        let wrap = range.startContainer;
        while (wrap && wrap.nodeType !== 1) wrap = wrap.parentNode;
        while (wrap && !wrap.classList?.contains?.('page-wrap')) wrap = wrap.parentNode;
        if (!wrap) return;

        const pageNum = parseInt(wrap.dataset.page, 10);
        const wrapRect = wrap.getBoundingClientRect();
        const rects = Array.from(range.getClientRects())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({
            x: (r.left - wrapRect.left) / wrapRect.width,
            y: (r.top - wrapRect.top) / wrapRect.height,
            w: r.width / wrapRect.width,
            h: r.height / wrapRect.height,
          }));
        if (rects.length === 0) return;

        // Locator used both as a "cfi" for highlight storage and as a
        // unique id for re-drawing on reopen.
        const cfi = 'pdf:' + pageNum + ':' + JSON.stringify(rects);
        // Viewport-space rect of the whole selection, used by RN to
        // anchor the context menu near the selected text.
        const bbox = range.getBoundingClientRect();
        const rect = { x: bbox.left, y: bbox.top, w: bbox.width, h: bbox.height };
        post('selectionChanged', { text, cfi, page: pageNum, rect });
      });
    }

    // Parse a 'pdf:<page>:<rectsJson>' locator into { pageNum, rects }.
    function parsePdfCfi(cfi) {
      if (!cfi || !cfi.startsWith('pdf:')) return null;
      const match = cfi.match(/^pdf:(\\d+):(.+)$/);
      if (!match) return null;
      let rects;
      try { rects = JSON.parse(match[2]); } catch { return null; }
      return { pageNum: parseInt(match[1], 10), rects };
    }

    function drawHighlight(payload) {
      const cfi = payload.cfi || payload.cfiRange;
      const parsed = parsePdfCfi(cfi);
      if (!parsed) return;
      const wrap = pageWraps.get(parsed.pageNum);
      if (!wrap) return;
      const layer = wrap.querySelector('.highlight-layer');
      if (!layer) return;
      for (const r of parsed.rects) {
        const div = document.createElement('div');
        div.className = 'highlight-rect';
        div.dataset.cfi = cfi;
        if (payload.color) div.dataset.color = payload.color;
        div.style.left = (r.x * 100) + '%';
        div.style.top = (r.y * 100) + '%';
        div.style.width = (r.w * 100) + '%';
        div.style.height = (r.h * 100) + '%';
        layer.appendChild(div);
      }
    }

    function drawNote(payload) {
      const cfi = payload.cfi;
      const noteType = payload.noteType === 'handwritten' ? 'handwritten' : 'typed';
      const parsed = parsePdfCfi(cfi);
      if (!parsed) return;
      const wrap = pageWraps.get(parsed.pageNum);
      if (!wrap) return;
      const layer = wrap.querySelector('.note-layer');
      if (!layer) return;
      // Skip if a marker for this cfi is already drawn (idempotent).
      if (layer.querySelector('.note-rect[data-cfi="' + cssEscape(cfi) + '"]')) return;
      for (const r of parsed.rects) {
        const div = document.createElement('div');
        div.className = 'note-rect';
        div.dataset.cfi = cfi;
        div.dataset.noteType = noteType;
        div.style.left = (r.x * 100) + '%';
        div.style.top = (r.y * 100) + '%';
        div.style.width = (r.w * 100) + '%';
        div.style.height = (r.h * 100) + '%';
        div.addEventListener('click', (ev) => {
          ev.stopPropagation();
          post('noteTapped', { cfi, noteType });
        });
        layer.appendChild(div);
      }
    }

    // Minimal attribute-selector escape — cfi strings contain brackets,
    // slashes and colons that would otherwise break querySelector.
    function cssEscape(s) {
      return String(s).replace(/["\\\\]/g, '\\\\$&');
    }

    function removeAnnotationRects(payload, layerClass, attr) {
      const cfi = payload.cfi || payload.cfiRange;
      const parsed = parsePdfCfi(cfi);
      if (!parsed) return;
      const wrap = pageWraps.get(parsed.pageNum);
      if (!wrap) return;
      const layer = wrap.querySelector('.' + layerClass);
      if (!layer) return;
      const sel = '[' + attr + '="' + cssEscape(cfi) + '"]';
      const els = layer.querySelectorAll(sel);
      for (const el of els) el.remove();
    }

    async function performSearch(query) {
      if (!query || !pdfDoc) return;
      const results = [];
      const needle = query.toLowerCase();
      for (let p = 1; p <= totalPages && results.length < 100; p++) {
        const page = await pdfDoc.getPage(p);
        const tc = await page.getTextContent();
        const text = tc.items.map((it) => it.str ?? '').join(' ');
        const idx = text.toLowerCase().indexOf(needle);
        if (idx >= 0) {
          const start = Math.max(0, idx - 30);
          const end = Math.min(text.length, idx + needle.length + 60);
          results.push({
            cfi: 'pdf:' + p + ':[]',
            excerpt: (start > 0 ? '…' : '') + text.slice(start, end) + '…',
            section: 'Page ' + p,
          });
        }
      }
      post('searchResults', { results, query });
    }

    let pdfjsLib;
    async function init() {
      try {
        pdfjsLib = await import('file:///android_asset/js/pdf.min.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'file:///android_asset/js/pdf.worker.min.mjs';

        const loadingTask = pdfjsLib.getDocument(BOOK_URL);
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;

        document.getElementById('loading').style.display = 'none';

        await renderAllPages();
        setupScrollTracking();
        setupSelectionTracking();

        post('ready', { totalPages });
        post('tocLoaded', {
          chapters: Array.from({ length: totalPages }, (_, i) => ({
            label: 'Page ' + (i + 1),
            href: String(i + 1),
            depth: 0,
          })),
        });
      } catch (err) {
        document.getElementById('loading').style.display = 'none';
        const errorDiv = document.getElementById('error');
        errorDiv.style.display = 'flex';
        errorDiv.textContent = 'Failed to load PDF: ' + err.message;
        post('error', { message: err.message });
      }
    }

    init();
  </script>
</body>
</html>`;
}
