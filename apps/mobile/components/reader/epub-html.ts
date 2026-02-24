/**
 * Generates the HTML for the EPUB reader WebView.
 * Uses foliate-js for EPUB rendering with full theme, pagination, TOC,
 * search, and text selection support.
 */
export function getReaderHtml(bookUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: var(--bg, #fff); color: var(--fg, #111); }
    #viewer { width: 100%; height: 100%; }
    foliate-view { width: 100%; height: 100%; }
    #loading, #error {
      display: flex; justify-content: center; align-items: center;
      height: 100%; font-family: system-ui, sans-serif; padding: 24px; text-align: center;
    }
    #loading { color: #666; }
    #error { display: none; color: #dc2626; }
  </style>
</head>
<body>
  <div id="loading">Loading book...</div>
  <div id="error"></div>
  <div id="viewer"></div>

  <script type="module">
    const BOOK_URL = ${JSON.stringify(bookUrl)};
    let view = null;
    let book = null;

    function post(type, payload) {
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
    }

    // Handle messages from React Native
    function handleRNMessage(data) {
      if (!view) return;
      switch (data.type) {
        case 'setTheme':
          applyTheme(data.payload);
          break;
        case 'goToLocation':
          if (data.payload.cfi) view.goTo(data.payload.cfi);
          else if (data.payload.fraction != null) view.goToFraction(data.payload.fraction);
          break;
        case 'goToChapter':
          if (data.payload.href) view.goTo(data.payload.href);
          break;
        case 'prevPage':
          view.prev();
          break;
        case 'nextPage':
          view.next();
          break;
        case 'search':
          performSearch(data.payload.query);
          break;
        case 'clearSearch':
          if (view.clearSearch) view.clearSearch();
          break;
        case 'addHighlight':
          if (view.addAnnotation) {
            view.addAnnotation(data.payload.cfiRange, {
              type: 'highlight',
              color: data.payload.color || 'yellow',
            });
          }
          break;
      }
    }

    // Listen for messages from RN
    window.addEventListener('message', (e) => {
      try { handleRNMessage(JSON.parse(e.data)); } catch {}
    });
    document.addEventListener('message', (e) => {
      try { handleRNMessage(JSON.parse(e.data)); } catch {}
    });

    function applyTheme(theme) {
      const root = document.documentElement;
      root.style.setProperty('--bg', theme.bg || '#fff');
      root.style.setProperty('--fg', theme.fg || '#111');
      document.body.style.background = theme.bg || '#fff';

      if (!view) return;
      view.renderer?.setStyles?.({
        style: [
          'html {',
          '  --bg: ' + (theme.bg || '#fff') + ';',
          '  --fg: ' + (theme.fg || '#111') + ';',
          '  background: var(--bg);',
          '  color: var(--fg);',
          '  font-size: ' + (theme.fontSize || 16) + 'px;',
          '  line-height: ' + (theme.lineHeight || 1.6) + ';',
          theme.fontFamily ? '  font-family: ' + theme.fontFamily + ';' : '',
          '}',
          'img { max-width: 100%; height: auto; }',
        ].join('\\n'),
      });
    }

    async function performSearch(query) {
      if (!book || !query) return;
      try {
        const results = [];
        for await (const result of book.search(query)) {
          results.push({
            cfi: result.cfi,
            excerpt: result.excerpt,
            section: result.label,
          });
          if (results.length >= 100) break;
        }
        post('searchResults', { results, query });
      } catch (err) {
        post('searchResults', { results: [], query, error: err.message });
      }
    }

    async function init() {
      try {
        const { makeBook } = await import('https://cdn.jsdelivr.net/npm/foliate-js@0.3/view.js');

        const res = await fetch(BOOK_URL);
        if (!res.ok) throw new Error('Failed to download book');
        const blob = await res.blob();

        book = await makeBook(blob);
        document.getElementById('loading').style.display = 'none';

        const viewer = document.getElementById('viewer');
        view = document.createElement('foliate-view');
        viewer.appendChild(view);

        // Configure pagination (CSS multi-column)
        view.setAttribute('flow', 'paginated');

        await view.open(book);

        // Relay location changes
        view.addEventListener('relocate', (e) => {
          const d = e.detail;
          post('progressUpdated', {
            percentage: Math.round((d.fraction ?? 0) * 100),
            cfi: d.cfi,
            chapter: d.tocItem?.label,
            chapterHref: d.tocItem?.href,
            sectionIndex: d.index,
          });
        });

        // Text selection
        view.addEventListener('draw-annotation', (e) => {
          // foliate-js annotation drawing
        });

        view.addEventListener('show-annotation', (e) => {
          post('showAnnotation', e.detail);
        });

        // Handle text selection via the view's selection event
        view.addEventListener('external-link', (e) => {
          e.preventDefault();
          post('externalLink', { href: e.detail.href });
        });

        // Custom selection handler
        const doc = view.renderer?.document ?? view.shadowRoot;
        if (doc) {
          doc.addEventListener('selectionchange', () => {
            const sel = doc.getSelection?.() ?? window.getSelection();
            if (sel && sel.toString().trim()) {
              post('selectionChanged', {
                text: sel.toString(),
                // CFI range will be computed when the user acts on the selection
              });
            } else {
              post('selectionCleared', {});
            }
          });
        }

        // Tap zones for page turns
        view.addEventListener('click', (e) => {
          const w = window.innerWidth;
          const x = e.clientX;
          if (x < w * 0.3) view.prev();
          else if (x > w * 0.7) view.next();
          else post('tapCenter', {});
        });

        // Report ready
        post('ready', {});

        // Report TOC
        if (book.toc) {
          post('tocLoaded', {
            chapters: flattenToc(book.toc),
          });
        }
      } catch (err) {
        document.getElementById('loading').style.display = 'none';
        const errorDiv = document.getElementById('error');
        errorDiv.style.display = 'flex';
        errorDiv.textContent = 'Failed to load book: ' + err.message;
        post('error', { message: err.message });
      }
    }

    function flattenToc(toc, depth = 0) {
      const items = [];
      for (const item of toc) {
        items.push({ label: item.label, href: item.href, depth });
        if (item.subitems) {
          items.push(...flattenToc(item.subitems, depth + 1));
        }
      }
      return items;
    }

    init();
  </script>
</body>
</html>`;
}
