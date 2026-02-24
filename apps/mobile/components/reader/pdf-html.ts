/**
 * Generates the HTML for the PDF reader WebView.
 * Uses pdf.js from CDN for rendering. Same postMessage bridge as EPUB.
 */
export function getPdfReaderHtml(bookUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: var(--bg, #f5f5f5); }
    #container {
      width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
    }
    .page-canvas {
      display: block;
      margin: 4px auto;
      background: white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
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

  <script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs" type="module"></script>
  <script type="module">
    const BOOK_URL = ${JSON.stringify(bookUrl)};
    let pdfDoc = null;
    let currentPage = 1;
    let totalPages = 0;
    let scale = 1;
    let rendering = false;

    function post(type, payload) {
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
    }

    // Handle messages from React Native
    function handleRNMessage(data) {
      switch (data.type) {
        case 'goToPage':
          if (data.payload.page >= 1 && data.payload.page <= totalPages) {
            scrollToPage(data.payload.page);
          }
          break;
        case 'setTheme':
          document.documentElement.style.setProperty('--bg', data.payload.bg || '#f5f5f5');
          break;
        case 'setScale':
          scale = data.payload.scale || 1;
          renderAllPages();
          break;
      }
    }

    window.addEventListener('message', (e) => {
      try { handleRNMessage(JSON.parse(e.data)); } catch {}
    });
    document.addEventListener('message', (e) => {
      try { handleRNMessage(JSON.parse(e.data)); } catch {}
    });

    function scrollToPage(pageNum) {
      const canvas = document.getElementById('page-' + pageNum);
      if (canvas) canvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
      currentPage = pageNum;
    }

    async function renderPage(pageNum) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: scale * (window.innerWidth / page.getViewport({ scale: 1 }).width) });

      const canvas = document.createElement('canvas');
      canvas.id = 'page-' + pageNum;
      canvas.className = 'page-canvas';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';

      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      return canvas;
    }

    async function renderAllPages() {
      if (rendering) return;
      rendering = true;

      const container = document.getElementById('container');
      container.innerHTML = '';

      for (let i = 1; i <= totalPages; i++) {
        const canvas = await renderPage(i);
        container.appendChild(canvas);
      }

      rendering = false;
    }

    // Track scroll position for progress
    function setupScrollTracking() {
      const container = document.getElementById('container');
      let ticking = false;

      container.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          const scrollFraction = container.scrollTop / (container.scrollHeight - container.clientHeight);
          const page = Math.ceil(scrollFraction * totalPages) || 1;
          if (page !== currentPage) {
            currentPage = page;
            post('progressUpdated', {
              page: currentPage,
              percentage: Math.round(scrollFraction * 100),
            });
          }
          ticking = false;
        });
      });
    }

    async function init() {
      try {
        const pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';

        const loadingTask = pdfjsLib.getDocument(BOOK_URL);
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;

        document.getElementById('loading').style.display = 'none';

        await renderAllPages();
        setupScrollTracking();

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
