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
      padding: var(--margin, 0) 0;
    }
    .page-wrap {
      position: relative;
      display: block;
      margin: 4px auto;
      background: white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
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
      if (theme.margin != null) root.style.setProperty('--margin', theme.margin + 'px');
      if (theme.isEink) {
        document.body.classList.add('eink');
      } else {
        document.body.classList.remove('eink');
      }
    }

    function scrollToPage(pageNum) {
      const wrap = pageWraps.get(pageNum);
      if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
            percentage: Math.round(scrollFraction * 100),
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
        post('selectionChanged', { text, cfi, page: pageNum });
      });
    }

    function drawHighlight(payload) {
      const cfi = payload.cfi || payload.cfiRange;
      if (!cfi || !cfi.startsWith('pdf:')) return;
      const match = cfi.match(/^pdf:(\\d+):(.+)$/);
      if (!match) return;
      const pageNum = parseInt(match[1], 10);
      let rects;
      try { rects = JSON.parse(match[2]); } catch { return; }
      const wrap = pageWraps.get(pageNum);
      if (!wrap) return;
      const layer = wrap.querySelector('.highlight-layer');
      if (!layer) return;
      for (const r of rects) {
        const div = document.createElement('div');
        div.className = 'highlight-rect';
        if (payload.color) div.dataset.color = payload.color;
        div.style.left = (r.x * 100) + '%';
        div.style.top = (r.y * 100) + '%';
        div.style.width = (r.w * 100) + '%';
        div.style.height = (r.h * 100) + '%';
        layer.appendChild(div);
      }
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
        pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';

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
