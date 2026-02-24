/**
 * Generates the HTML for the EPUB reader WebView.
 * Uses foliate-js loaded from unpkg CDN.
 * In production, foliate-js should be bundled as a local asset.
 */
export function getReaderHtml(bookUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    #viewer {
      width: 100%;
      height: 100%;
    }
    #loading {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
      font-family: system-ui, sans-serif;
      color: #666;
    }
    #error {
      display: none;
      justify-content: center;
      align-items: center;
      height: 100%;
      font-family: system-ui, sans-serif;
      color: #dc2626;
      padding: 24px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="loading">Loading book...</div>
  <div id="error"></div>
  <div id="viewer"></div>

  <script type="module">
    // Minimal EPUB viewer using foliate-js
    // For Phase 1, we load the EPUB via fetch and render with foliate-js
    const BOOK_URL = ${JSON.stringify(bookUrl)};

    function postMessage(type, payload) {
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
    }

    async function init() {
      try {
        // Import foliate-js from CDN
        const { makeBook } = await import('https://cdn.jsdelivr.net/npm/foliate-js@0.3/view.js');
        const { EPUB } = await import('https://cdn.jsdelivr.net/npm/foliate-js@0.3/epub.js');

        // Fetch the EPUB file
        const res = await fetch(BOOK_URL);
        if (!res.ok) throw new Error('Failed to download book');
        const blob = await res.blob();

        // Open the book
        const book = await makeBook(blob);

        document.getElementById('loading').style.display = 'none';

        // Create reader view
        const viewer = document.getElementById('viewer');
        const view = document.createElement('foliate-view');
        viewer.appendChild(view);
        view.style.width = '100%';
        view.style.height = '100%';

        await view.open(book);

        // Listen for location changes
        view.addEventListener('relocate', (e) => {
          const { fraction, tocItem, cfi } = e.detail;
          postMessage('progressUpdated', {
            percentage: Math.round(fraction * 100),
            cfi,
            chapter: tocItem?.label,
          });
        });

        // Report ready
        postMessage('ready', {});

        // Report TOC
        if (book.toc) {
          postMessage('tocLoaded', { chapters: book.toc });
        }
      } catch (err) {
        document.getElementById('loading').style.display = 'none';
        const errorDiv = document.getElementById('error');
        errorDiv.style.display = 'flex';
        errorDiv.textContent = 'Failed to load book: ' + err.message;
        postMessage('error', { message: err.message });
      }
    }

    init();
  </script>
</body>
</html>`;
}
