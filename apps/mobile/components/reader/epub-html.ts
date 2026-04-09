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
    // Whether tap-on-left/right turns the page. Flipped from setTheme.
    let tapToTurn = true;

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
        case 'addHighlight': {
          // RN sends either { cfi } (live selection) or { cfiRange } (replay);
          // foliate's addAnnotation wants the CFI range as its first arg.
          const cfi = data.payload.cfi || data.payload.cfiRange;
          if (!cfi) break;
          if (view.addAnnotation) {
            try {
              view.addAnnotation(cfi, {
                type: 'highlight',
                color: data.payload.color || 'yellow',
              });
            } catch (err) {
              post('highlightError', { cfi, error: String(err) });
            }
          }
          break;
        }
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
      tapToTurn = theme.tapToTurn !== false;

      if (!view) return;

      // Page edge margin — foliate-js reads this attribute on the view element.
      if (theme.margin != null) {
        view.renderer?.setAttribute?.('margin', String(theme.margin) + 'px');
      }

      const eink = !!theme.isEink;
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
          'body { font-family: inherit; }',
          'p { line-height: inherit; }',
          'img { max-width: 100%; height: auto; }',
          // e-ink overrides: force full-contrast text everywhere and kill
          // grayscale-washed colored links/headings that become illegible
          // after the device-level daltonizer desaturates them.
          eink
            ? [
                'html, body, h1, h2, h3, h4, h5, h6, p, li, blockquote,',
                'th, td, strong, em, b, i, cite, span { color: #000 !important; }',
                'a, a:link, a:visited, a:hover, a:active { color: #000 !important; text-decoration: underline !important; }',
                'code, kbd, pre, samp { color: #000 !important; background: #eee !important; }',
                'blockquote { border-left: 3px solid #000 !important; }',
                'hr { border-color: #000 !important; }',
                // e-ink displays render images as grayscale anyway — force
                // a small contrast bump so they don\\'t muddy out.
                'img { filter: grayscale(100%) contrast(1.15); }',
                '* { text-shadow: none !important; box-shadow: none !important; }',
              ].join('\\n')
            : '',
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
        const { makeBook } = await import('https://cdn.jsdelivr.net/npm/foliate-js@1.0.1/view.js');

        const res = await fetch(BOOK_URL);
        if (!res.ok) throw new Error('Failed to download book');
        const blob = await res.blob();
        // foliate-js's makeBook() dispatches on file.name.endsWith() to pick
        // a parser (EPUB vs CBZ vs FB2 etc.), so a bare Blob (no .name) crashes.
        // Wrap it in a File with an explicit .epub name and mime.
        const file = new File([blob], 'book.epub', { type: 'application/epub+zip' });

        book = await makeBook(file);
        document.getElementById('loading').style.display = 'none';

        const viewer = document.getElementById('viewer');
        view = document.createElement('foliate-view');
        viewer.appendChild(view);

        // Configure pagination (CSS multi-column)
        view.setAttribute('flow', 'paginated');
        view.setAttribute('margin', '48px');

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

        view.addEventListener('show-annotation', (e) => {
          post('showAnnotation', e.detail);
        });

        view.addEventListener('external-link', (e) => {
          e.preventDefault();
          post('externalLink', { href: e.detail.href });
        });

        // Each section is loaded into its own iframe document. Foliate
        // emits a 'load' event with { doc, index } when that happens, so
        // we attach our selection + tap handlers to the REAL book
        // document (not the outer host) — otherwise selectionchange never
        // fires and CFIs can't be computed.
        view.addEventListener('load', (e) => {
          const { doc, index } = e.detail;
          if (!doc) return;

          // Selection → send CFI + text to RN so the custom menu can act on it.
          doc.addEventListener('selectionchange', () => {
            const sel = doc.getSelection();
            if (!sel || sel.isCollapsed) {
              post('selectionCleared', {});
              return;
            }
            const text = sel.toString().trim();
            if (!text) return;
            let cfi = '';
            try {
              cfi = view.getCFI(index, sel.getRangeAt(0));
            } catch {}
            post('selectionChanged', { text, cfi });
          });

          // Tap zones for page turns (honors the tapToTurn theme flag).
          doc.addEventListener('click', (ev) => {
            // If the user is mid-selection, let the browser handle it.
            const sel = doc.getSelection();
            if (sel && !sel.isCollapsed) return;
            const w = doc.documentElement.clientWidth || window.innerWidth;
            const x = ev.clientX;
            if (tapToTurn) {
              if (x < w * 0.3) { view.prev(); return; }
              if (x > w * 0.7) { view.next(); return; }
            }
            post('tapCenter', {});
          });
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
