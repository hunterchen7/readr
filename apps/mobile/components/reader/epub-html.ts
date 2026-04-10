/**
 * Generates the HTML for the EPUB reader WebView.
 * Uses foliate-js for EPUB rendering with full theme, pagination, TOC,
 * search, and text selection support.
 */
export function getReaderHtml(bookUrl: string, initialBg?: string, initialFg?: string): string {
  const bg = initialBg || '#fff';
  const fg = initialFg || '#111';
  return `<!DOCTYPE html>
<html style="background:${bg};color:${fg}">
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
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: ${bg}; color: ${fg}; }
    #viewer { width: 100%; height: 100%; background: ${bg}; }
    foliate-view { width: 100%; height: 100%; background: ${bg}; border: none; }
    iframe { border: none; }
  </style>
  <script src="file:///android_asset/js/foliate-bundle.js"></script>
  <style>
    #loading, #error {
      display: flex; justify-content: center; align-items: center;
      height: 100%; font-family: system-ui, sans-serif; padding: 24px; text-align: center;
    }
    #loading { color: #666; }
    #error { display: none; color: #dc2626; }
  </style>
  <style>
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

    // Page counting — measures CSS column widths per section
    let sectionPageCounts = {}; // { sectionIndex: pageCount }
    let currentSectionIndex = 0;

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
          if (data.payload.href) {
            try {
              view.goTo(data.payload.href);
            } catch {
              // Some hrefs need to be resolved against the book's base
              try { view.goTo({ href: data.payload.href }); } catch {}
            }
          }
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
        case 'copyToClipboard': {
          const text = data.payload.text || '';
          if (text) {
            try {
              navigator.clipboard.writeText(text).catch(() => {
                // Fallback for environments where clipboard API is blocked
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
              });
            } catch {
              const ta = document.createElement('textarea');
              ta.value = text;
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
        case 'addHighlight': {
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
        case 'removeHighlight': {
          const cfi = data.payload.cfi || data.payload.cfiRange;
          if (!cfi || !view.addAnnotation) break;
          try {
            // foliate: passing truthy 2nd arg removes the annotation
            view.addAnnotation({ value: cfi }, true);
          } catch {}
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
              sr.prepend(srStyle);
            }
            srStyle.textContent =
              ':host{background:' + bgColor + '!important}' +
              '*{background:' + bgColor + '!important;border-color:transparent!important;column-rule-color:transparent!important}' +
              'iframe{border:none!important}';
            // Also force inline on every existing element right now
            for (const el of sr.querySelectorAll('*')) {
              el.style.setProperty('background', bgColor, 'important');
              el.style.setProperty('border-color', 'transparent', 'important');
            }
            // Watch for new elements foliate adds dynamically
            if (!sr._readrObserver) {
              sr._readrObserver = new MutationObserver(() => {
                const bg = currentTheme?.bg || '#fff';
                for (const el of sr.querySelectorAll('*')) {
                  el.style.setProperty('background', bg, 'important');
                  el.style.setProperty('border-color', 'transparent', 'important');
                }
              });
              sr._readrObserver.observe(sr, { childList: true, subtree: true });
            }
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

      // After CSS changes reflow the columns — clear page counts and
      // re-precompute all sections, then re-post progress.
      sectionPageCounts = {};
      setTimeout(async () => {
        remeasureCurrentSection();
        await precomputeAllPages();
        if (view?.lastLocation) {
          view.dispatchEvent(new CustomEvent('relocate', { detail: view.lastLocation }));
        }
      }, 300);
    }

    function remeasureCurrentSection() {
      if (!currentSectionDoc || !view) return;
      const vw = view.clientWidth || window.innerWidth;
      if (vw <= 0) return;
      try {
        const sw = currentSectionDoc.documentElement.scrollWidth
                 || currentSectionDoc.body?.scrollWidth || 0;
        if (sw > 0) {
          sectionPageCounts[currentSectionIndex] = Math.max(1, Math.round(sw / vw));
        }
      } catch {}
    }

    // Measure page counts for ALL sections by loading each section's
    // document via createDocument(), injecting theme CSS, and measuring
    // scrollWidth in a hidden container. This gives exact page counts.
    let _precomputeRunning = false;
    async function precomputeAllPages() {
      if (_precomputeRunning || !book?.sections || !view) return;
      _precomputeRunning = true;

      const vw = view.clientWidth || window.innerWidth;
      const vh = view.clientHeight || window.innerHeight || 800;
      if (vw <= 0) { _precomputeRunning = false; return; }

      const total = book.sections.length;
      let measured = 0;

      for (let i = 0; i < total; i++) {
        if (sectionPageCounts[i]) { measured++; continue; }
        try {
          const section = book.sections[i];
          const doc = await section.createDocument();
          if (!doc || !doc.body) { sectionPageCounts[i] = 1; measured++; continue; }

          // Create a hidden measuring container with the same column layout
          const el = document.createElement('div');
          el.style.cssText =
            'position:fixed;left:-99999px;top:0;' +
            'width:' + vw + 'px;height:' + vh + 'px;' +
            'column-width:' + vw + 'px;column-fill:auto;' +
            'overflow:hidden;visibility:hidden;';
          // Apply current theme styles
          if (currentThemeCSS) {
            const style = document.createElement('style');
            style.textContent = currentThemeCSS;
            el.appendChild(style);
          }
          // Clone the section body content
          el.innerHTML += doc.body.innerHTML;
          document.body.appendChild(el);

          const sw = el.scrollWidth;
          sectionPageCounts[i] = Math.max(1, Math.round(sw / vw));
          measured++;

          document.body.removeChild(el);
        } catch (err) {
          post('debug', { msg: 'precompute section ' + i + ' failed: ' + (err?.message || err) });
          sectionPageCounts[i] = 1;
          measured++;
        }
      }

      _precomputeRunning = false;

      // Post the final total
      let totalPages = 0;
      for (let i = 0; i < total; i++) totalPages += sectionPageCounts[i] ?? 1;
      post('debug', { msg: 'precompute done: ' + measured + '/' + total + ' sections, ' + totalPages + ' pages' });
      post('pagesComputed', { totalPages, measured, total });
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
        // foliate-js is loaded via <script src="file:///android_asset/js/foliate-bundle.js">
        // which sets window.__foliate = { makeBook, Overlayer }
        const { makeBook, Overlayer } = window.__foliate;

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

          // After measuring current section, extrapolate all others
          precomputeAllPages();

          // Use page counts
          // Also measure current section live if not yet precomputed
          const vw = view.clientWidth || window.innerWidth;
          if (!sectionPageCounts[secIdx] && currentSectionDoc && vw > 0) {
            try {
              const sw = currentSectionDoc.documentElement.scrollWidth || currentSectionDoc.body?.scrollWidth || 0;
              if (sw > 0) sectionPageCounts[secIdx] = Math.max(1, Math.round(sw / vw));
            } catch {}
          }
          const pagesInSection = sectionPageCounts[secIdx] ?? 1;

          // Sum all section page counts for total
          const totalSections = book?.sections?.length ?? 1;
          let totalPages = 0;
          let allMeasured = true;
          for (let i = 0; i < totalSections; i++) {
            if (sectionPageCounts[i]) {
              totalPages += sectionPageCounts[i];
            } else {
              totalPages += pagesInSection; // use current section as estimate for unmeasured
              allMeasured = false;
            }
          }
          totalPages = Math.max(1, totalPages);

          // Current page = fraction * totalPages
          const currentPage = Math.max(1, Math.min(totalPages, Math.round(frac * totalPages)));

          // Page within section from fraction
          let pageInSection = 1;
          if (pagesInSection > 1) {
            // Pages before this section
            let pagesBefore = 0;
            for (let i = 0; i < secIdx; i++) {
              pagesBefore += sectionPageCounts[i] ?? pagesInSection;
            }
            pageInSection = Math.max(1, Math.min(pagesInSection, currentPage - pagesBefore));
          }

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
            setTimeout(() => remeasureCurrentSection(), 200);

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

        // Precompute all section page counts after first section renders
        setTimeout(() => precomputeAllPages(), 1000);

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
