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
    /* Bundled fonts — loaded from android assets */
    @font-face { font-family: 'Literata'; src: url('file:///android_asset/fonts/Literata.ttf'); }
    @font-face { font-family: 'Lora'; src: url('file:///android_asset/fonts/Lora.ttf'); }
    @font-face { font-family: 'Merriweather'; src: url('file:///android_asset/fonts/Merriweather.ttf'); }
    @font-face { font-family: 'EB Garamond'; src: url('file:///android_asset/fonts/EBGaramond.ttf'); }
    @font-face { font-family: 'Source Serif 4'; src: url('file:///android_asset/fonts/SourceSerif4.ttf'); }
    @font-face { font-family: 'Noto Serif'; src: url('file:///android_asset/fonts/NotoSerif.ttf'); }
    @font-face { font-family: 'Crimson Text'; src: url('file:///android_asset/fonts/CrimsonText.ttf'); }
    @font-face { font-family: 'Libre Baskerville'; src: url('file:///android_asset/fonts/LibreBaskerville.ttf'); }
    @font-face { font-family: 'Playfair Display'; src: url('file:///android_asset/fonts/PlayfairDisplay.ttf'); }
    @font-face { font-family: 'PT Serif'; src: url('file:///android_asset/fonts/PTSerif.ttf'); }
    @font-face { font-family: 'Roboto Slab'; src: url('file:///android_asset/fonts/RobotoSlab.ttf'); }
    @font-face { font-family: 'Roboto'; src: url('file:///android_asset/fonts/Roboto.ttf'); }
    @font-face { font-family: 'Open Sans'; src: url('file:///android_asset/fonts/OpenSans.ttf'); }
    @font-face { font-family: 'Inter'; src: url('file:///android_asset/fonts/Inter.ttf'); }
    @font-face { font-family: 'Nunito'; src: url('file:///android_asset/fonts/Nunito.ttf'); }
    @font-face { font-family: 'Fira Mono'; src: url('file:///android_asset/fonts/FiraMono.ttf'); }
    @font-face { font-family: 'IBM Plex Mono'; src: url('file:///android_asset/fonts/IBMPlexMono.ttf'); }
  </style>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; border: none; outline: none; }
    html, body { height: 100%; overflow: hidden; background: var(--bg, #fff); color: var(--fg, #111); }
    #viewer { width: 100%; height: 100%; background: var(--bg, #fff); }
    foliate-view { width: 100%; height: 100%; background: var(--bg, #fff); }
    iframe { border: none !important; outline: none !important; }
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
    // The most recently-loaded section document (foliate loads each
    // EPUB section into its own iframe). Used by the getPageText
    // handler to scrape text for TTS playback.
    let currentSectionDoc = null;

    // Exact page counting — tracks column count per section
    let sectionPageCounts = {}; // { sectionIndex: pageCount }
    let currentSectionIndex = 0;
    let pageInCurrentSection = 1;
    let lastRelocateCfi = '';
    let lastRelocateSection = -1;

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
        case 'getPageText': {
          // Return the visible section's plain text for TTS. We fall
          // back to an empty string if the section hasn't loaded yet.
          const text = currentSectionDoc?.body?.innerText?.trim() ?? '';
          post('pageText', { text });
          break;
        }
        case 'addHighlight': {
          // RN sends either { cfi } (live selection) or { cfiRange } (replay).
          const cfi = data.payload.cfi || data.payload.cfiRange;
          if (!cfi) break;
          if (view.addAnnotation) {
            try {
              view.addAnnotation({ value: cfi, color: data.payload.color || 'yellow' });
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

    // Current theme CSS — injected into every section document
    let currentThemeCSS = '';
    let currentTheme = {};

    function buildThemeCSS(theme) {
      const eink = !!theme.isEink;
      const bg = theme.bg || '#fff';
      const fg = theme.fg || '#111';
      const fs = theme.fontSize || 16;
      const lh = theme.lineHeight || 1.6;
      const fw = theme.fontWeight || 400;
      const ff = theme.fontFamily || '';

      return [
        // Load bundled fonts in the section iframe via @font-face
        "@font-face{font-family:'Literata';src:url('file:///android_asset/fonts/Literata.ttf')}",
        "@font-face{font-family:'Lora';src:url('file:///android_asset/fonts/Lora.ttf')}",
        "@font-face{font-family:'Merriweather';src:url('file:///android_asset/fonts/Merriweather.ttf')}",
        "@font-face{font-family:'EB Garamond';src:url('file:///android_asset/fonts/EBGaramond.ttf')}",
        "@font-face{font-family:'Source Serif 4';src:url('file:///android_asset/fonts/SourceSerif4.ttf')}",
        "@font-face{font-family:'Noto Serif';src:url('file:///android_asset/fonts/NotoSerif.ttf')}",
        "@font-face{font-family:'Crimson Text';src:url('file:///android_asset/fonts/CrimsonText.ttf')}",
        "@font-face{font-family:'Libre Baskerville';src:url('file:///android_asset/fonts/LibreBaskerville.ttf')}",
        "@font-face{font-family:'Playfair Display';src:url('file:///android_asset/fonts/PlayfairDisplay.ttf')}",
        "@font-face{font-family:'PT Serif';src:url('file:///android_asset/fonts/PTSerif.ttf')}",
        "@font-face{font-family:'Roboto Slab';src:url('file:///android_asset/fonts/RobotoSlab.ttf')}",
        "@font-face{font-family:'Roboto';src:url('file:///android_asset/fonts/Roboto.ttf')}",
        "@font-face{font-family:'Open Sans';src:url('file:///android_asset/fonts/OpenSans.ttf')}",
        "@font-face{font-family:'Inter';src:url('file:///android_asset/fonts/Inter.ttf')}",
        "@font-face{font-family:'Nunito';src:url('file:///android_asset/fonts/Nunito.ttf')}",
        "@font-face{font-family:'Fira Mono';src:url('file:///android_asset/fonts/FiraMono.ttf')}",
        "@font-face{font-family:'IBM Plex Mono';src:url('file:///android_asset/fonts/IBMPlexMono.ttf')}",
        // Root styles
        'html { background: ' + bg + ' !important; }',
        // Force ALL elements: color, bg transparent, typography
        '* {',
        '  color: ' + fg + ' !important;',
        '  background-color: transparent !important;',
        '  line-height: ' + lh + ' !important;',
        '  font-weight: ' + fw + ' !important;',
        ff ? '  font-family: ' + ff + ' !important;' : '',
        '}',
        // Restore html bg (wildcard made it transparent)
        'html, body { background-color: ' + bg + ' !important; }',
        // Font size on root (em-based content scales from this)
        'html { font-size: ' + fs + 'px !important; }',
        // Margins — applied directly to the section body
        'body { padding-left: ' + (theme.margin ?? 48) + 'px !important; padding-right: ' + (theme.margin ?? 48) + 'px !important; padding-top: ' + (theme.marginV ?? 24) + 'px !important; padding-bottom: ' + (theme.marginV ?? 24) + 'px !important; }',
        // Images
        'img { max-width: 100% !important; height: auto !important; background-color: transparent !important; }',
        // Links
        'a, a:link, a:visited { text-decoration: underline; }',
        // E-ink extras
        eink
          ? [
              'img { filter: grayscale(100%) contrast(1.15); }',
              '* { text-shadow: none !important; box-shadow: none !important; }',
            ].join('\\n')
          : '',
      ].join('\\n');
    }

    function injectThemeIntoDoc(doc) {
      if (!doc || !currentThemeCSS) return;
      try {
        let style = doc.getElementById('readr-theme');
        if (!style) {
          style = doc.createElement('style');
          style.id = 'readr-theme';
          (doc.head || doc.documentElement).appendChild(style);
        }
        style.textContent = currentThemeCSS;
      } catch {}
    }

    function applyTheme(theme) {
      currentTheme = theme;
      const root = document.documentElement;
      root.style.setProperty('--bg', theme.bg || '#fff');
      root.style.setProperty('--fg', theme.fg || '#111');
      const bgColor = theme.bg || '#fff';
      // Force background on every element in the chain
      root.style.cssText = 'background:' + bgColor + '!important';
      document.body.style.cssText = 'background:' + bgColor + '!important;margin:0;padding:0';
      const viewer = document.getElementById('viewer');
      if (viewer) viewer.style.cssText = 'width:100%;height:100%;background:' + bgColor;
      if (view) {
        view.style.background = bgColor;
        // Force into shadow root (foliate uses mode:'open')
        try {
          const sr = view.shadowRoot;
          if (sr) {
            let srStyle = sr.getElementById('readr-sr-theme');
            if (!srStyle) {
              srStyle = document.createElement('style');
              srStyle.id = 'readr-sr-theme';
              sr.appendChild(srStyle);
            }
            srStyle.textContent = [
              ':host, *, div, iframe { background:' + bgColor + '!important; border-color:transparent!important; column-rule-color:transparent!important; }',
            ].join('');
          }
          // Also iterate direct children of shadow root
          if (sr) for (const el of sr.querySelectorAll('*')) {
            el.style.background = bgColor;
            el.style.borderColor = 'transparent';
          }
        } catch {}
      }
      tapToTurn = theme.tapToTurn !== false;

      currentThemeCSS = buildThemeCSS(theme);

      if (!view) return;

      // Margins — set attribute for foliate AND apply CSS directly
      if (theme.margin != null) {
        const m = String(theme.margin) + 'px';
        view.setAttribute('margin', m);
        view.style.paddingLeft = m;
        view.style.paddingRight = m;
      }
      if (theme.marginV != null) {
        view.style.paddingTop = theme.marginV + 'px';
        view.style.paddingBottom = theme.marginV + 'px';
      }

      // Inject CSS into the current section document
      if (currentSectionDoc) injectThemeIntoDoc(currentSectionDoc);
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

    function fetchFile(url) {
      // fetch() doesn't work with file:// on Android WebView.
      // XMLHttpRequest does when allowFileAccess is enabled.
      if (url.startsWith('file://')) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.responseType = 'blob';
          xhr.onload = () => xhr.status === 200 || xhr.status === 0
            ? resolve(xhr.response)
            : reject(new Error('XHR failed: ' + xhr.status));
          xhr.onerror = () => reject(new Error('XHR network error'));
          xhr.send();
        });
      }
      return fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); });
    }

    async function init() {
      try {
        const [{ makeBook }, { Overlayer }] = await Promise.all([
          import('https://cdn.jsdelivr.net/npm/foliate-js@1.0.1/view.js'),
          import('https://cdn.jsdelivr.net/npm/foliate-js@1.0.1/overlayer.js'),
        ]);

        const blob = await fetchFile(BOOK_URL);
        const file = new File([blob], 'book.epub', { type: blob.type || 'application/epub+zip' });

        book = await makeBook(file);
        document.getElementById('loading').style.display = 'none';

        const viewer = document.getElementById('viewer');
        view = document.createElement('foliate-view');
        viewer.appendChild(view);

        // Configure pagination (CSS multi-column)
        view.setAttribute('flow', 'paginated');
        view.setAttribute('margin', '48px');

        await view.open(book);

        // Navigate to the first section so content renders immediately.
        // Without this, foliate shows a blank page until the user navigates.
        try { await view.goTo(book.toc?.[0]?.href ?? book.sections?.[0]?.id ?? 0); } catch {};

        // Relay location changes. pageItem carries foliate's computed
        // {current, total} page count across the whole book — surface it
        // so the reader can render "12 / 345".
        view.addEventListener('relocate', (e) => {
          const d = e.detail;
          const frac = d.fraction ?? 0;
          const secIdx = d.index ?? 0;

          // Track page within section by counting turns
          let pagesInSection = sectionPageCounts[secIdx] ?? 1;
          try {
            if (currentSectionDoc) {
              const body = currentSectionDoc.body || currentSectionDoc.documentElement;
              const vw = currentSectionDoc.documentElement.clientWidth;
              if (body && vw > 0) {
                pagesInSection = Math.max(1, Math.round(body.scrollWidth / vw));
                sectionPageCounts[secIdx] = pagesInSection;
              }
            }
          } catch {}

          const cfi = d.cfi ?? '';
          if (secIdx !== lastRelocateSection) {
            // New section — start at page 1 (or last page if going backward)
            pageInCurrentSection = (cfi > lastRelocateCfi || !lastRelocateCfi) ? 1 : pagesInSection;
            lastRelocateSection = secIdx;
          } else if (cfi && cfi !== lastRelocateCfi) {
            // Same section, different position — determine direction from CFI
            if (cfi > lastRelocateCfi) {
              pageInCurrentSection = Math.min(pagesInSection, pageInCurrentSection + 1);
            } else {
              pageInCurrentSection = Math.max(1, pageInCurrentSection - 1);
            }
          }
          lastRelocateCfi = cfi;
          const pageInSection = pageInCurrentSection;

          // Sum pages from all measured sections for total, estimate unmeasured
          const totalSections = book?.sections?.length ?? 20;
          let measuredPages = 0;
          let measuredCount = 0;
          for (const k in sectionPageCounts) {
            measuredPages += sectionPageCounts[k];
            measuredCount++;
          }
          const avgPagesPerSection = measuredCount > 0 ? measuredPages / measuredCount : 5;
          const totalPages = Math.round(measuredPages + (totalSections - measuredCount) * avgPagesPerSection);

          // Pages before current section
          let pagesBefore = 0;
          for (let i = 0; i < secIdx; i++) {
            pagesBefore += sectionPageCounts[i] ?? Math.round(avgPagesPerSection);
          }
          const currentPage = pagesBefore + pageInSection;

          post('progressUpdated', {
            percentage: Math.round(frac * 100),
            cfi: d.cfi,
            chapter: d.tocItem?.label,
            chapterHref: d.tocItem?.href,
            sectionIndex: secIdx,
            currentPage,
            totalPages,
            pageInSection,
            pagesInSection,
          });
        });

        // Text selection
        view.addEventListener('draw-annotation', (e) => {
          const { draw, annotation } = e.detail ?? {};
          if (draw && annotation) {
            const color = annotation.color || 'yellow';
            draw(Overlayer.highlight, { color });
          }
        });

        view.addEventListener('show-annotation', (e) => {
          post('showAnnotation', e.detail);
        });

        // Remember the latest loaded section doc so the TTS handler
        // can scrape its text. Foliate fires 'load' with { doc, index }
        // for every newly-loaded section.
        view.addEventListener('load', (e) => {
          if (e.detail?.doc) {
            currentSectionDoc = e.detail.doc;
            injectThemeIntoDoc(currentSectionDoc);

            // Count pages (CSS columns) in this section after layout
            currentSectionIndex = e.detail.index;
            setTimeout(() => {
              try {
                const body = currentSectionDoc.body || currentSectionDoc.documentElement;
                const vw = currentSectionDoc.documentElement.clientWidth;
                if (body && vw > 0) {
                  sectionPageCounts[e.detail.index] = Math.max(1, Math.round(body.scrollWidth / vw));
                }
              } catch {}
            }, 200);

            // Clicks inside foliate's section iframes don't bubble to the
            // parent document.  Attach our tap handler directly so
            // page-turn and toggle-controls work from inside the content.
            currentSectionDoc.addEventListener('click', handleTap);

            // Suppress native Android context menu so our custom RN
            // menu (Highlight / Bookmark / Note / Copy / Lookup) shows.
            currentSectionDoc.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              e.stopPropagation();
              return false;
            });

            // Text selection — detect via selectionchange + pointerup.
            // selectionchange fires as the user drags handles; we debounce
            // and only post once the selection stabilises (pointerup or
            // after a short delay).
            let selDebounce = null;
            function checkSelection() {
              const sel = currentSectionDoc.getSelection?.();
              if (sel && sel.toString().trim() && sel.rangeCount > 0 && !sel.isCollapsed) {
                let cfi = '';
                try {
                  const range = sel.getRangeAt(0);
                  const contents = view.renderer?.getContents?.() ?? [];
                  const content = contents.find(c => c.doc.contains(range.startContainer));
                  if (content) cfi = view.getCFI(content.index, range) ?? '';
                } catch {}
                post('selectionChanged', { text: sel.toString(), cfi });
              } else {
                post('selectionCleared', {});
              }
            }
            currentSectionDoc.addEventListener('selectionchange', () => {
              clearTimeout(selDebounce);
              selDebounce = setTimeout(checkSelection, 200);
            });
            currentSectionDoc.addEventListener('pointerup', () => {
              setTimeout(checkSelection, 80);
            });
          }
        });

        // Handle text selection via the view's selection event
        view.addEventListener('external-link', (e) => {
          e.preventDefault();
          post('externalLink', { href: e.detail.href });
        });

        // Selection handling is now attached to each section doc
        // in the 'load' handler above (iframes don't bubble events).

        // Tap zones for page turns (honors the tapToTurn theme flag).
        function handleTap(e) {
          // If there's an active text selection, clear it on tap
          // instead of navigating. Next tap will navigate normally.
          try {
            const doc = (e.view || window).document ?? document;
            const sel = doc.getSelection?.() ?? window.getSelection?.();
            if (sel && !sel.isCollapsed && sel.toString().trim()) {
              sel.removeAllRanges();
              post('selectionCleared', {});
              return;
            }
          } catch {}

          // Use the parent window's innerWidth (reliable viewport width)
          // and screenX (absolute screen coordinate) for zone detection.
          const w = window.innerWidth || screen.width;
          const x = e.screenX ?? e.clientX;
          if (tapToTurn) {
            if (x < w * 0.2) { view.prev(); return; }
            if (x > w * 0.8) { view.next(); return; }
          }
          post('tapCenter', {});
        }
        view.addEventListener('click', handleTap);
        document.addEventListener('click', handleTap);

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
