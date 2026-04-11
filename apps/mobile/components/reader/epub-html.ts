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
    let sectionPageCountsLocked = false; // true after precompute finishes
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
              view.addAnnotation({ value: cfi, color: data.payload.color || 'yellow', kind: 'highlight' });
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
        case 'addNote': {
          // Notes share foliate's annotation machinery but render as a
          // squiggly/underline so they're distinguishable from highlights
          // and don't block the underlying text. The noteType controls
          // the visual style so typed notes and drawings look different.
          const cfi = data.payload.cfi;
          const noteType = data.payload.noteType === 'handwritten' ? 'handwritten' : 'typed';
          if (!cfi || !view.addAnnotation) break;
          try {
            view.addAnnotation({ value: cfi, kind: 'note', noteType });
            noteCfis.set(cfi, noteType);
          } catch (err) {
            post('noteError', { cfi, error: String(err) });
          }
          break;
        }
        case 'removeNote': {
          const cfi = data.payload.cfi;
          if (!cfi || !view.addAnnotation) break;
          try {
            view.addAnnotation({ value: cfi }, true);
            noteCfis.delete(cfi);
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
    // Map of note cfi → noteType ('typed' | 'handwritten'). Foliate's
    // show-annotation event drops custom fields, so we mirror the
    // classification here and consult it when routing a tap.
    const noteCfis = new Map();

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
        // Zero inner body margins; horizontal margin comes from host
        // paddingLeft/paddingRight and vertical from foliates grid
        // rows. Setting body padding here too would double-count.
        'body { margin: 0 !important; padding: 0 !important; }',
        // Images
        'img { max-width: 100% !important; height: auto !important; background-color: transparent !important; }',
        // Links
        'a, a:link, a:visited { text-decoration: underline; }',
        // E-ink extras — kill everything a slow panel can't handle. Books
        // embed their own stylesheets that can add fades, glows, and color
        // decorations; the !important wildcards win over them.
        eink
          ? [
              'img { filter: grayscale(100%) contrast(1.15); }',
              '* {',
              '  text-shadow: none !important;',
              '  box-shadow: none !important;',
              '  animation: none !important;',
              '  transition: none !important;',
              '  filter: none !important;',
              '}',
              // Re-apply the image grayscale filter after the wildcard reset.
              'img { filter: grayscale(100%) contrast(1.15) !important; }',
              // Links and emphasis stay readable: high-contrast black, no decoration tricks.
              'a, a:link, a:visited, a:hover { color: ' + fg + ' !important; text-decoration: underline; }',
              // Table borders — keep them crisp, not hairline gray.
              'table, th, td { border-color: ' + fg + ' !important; }',
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

      // Disable foliate's built-in content caps so margin=0 actually
      // reads as 0. By default the paginator reserves ~7% gap on each
      // side and caps content width at 720px/column and height at
      // 1440px, which shows up as phantom margins on wide screens.
      view.setAttribute('gap', '0');
      view.setAttribute('max-inline-size', '99999');
      view.setAttribute('max-block-size', '99999');

      // Horizontal margin: applied as padding on the foliate-view host
      // so content-box shrinks evenly on both sides, every page.
      if (theme.margin != null) {
        const m = String(theme.margin) + 'px';
        view.style.paddingLeft = m;
        view.style.paddingRight = m;
      }
      // Vertical margin: foliates "margin" attribute maps to its
      // --_margin CSS var which drives the top/bottom grid rows in
      // the paginator shadow DOM. Setting it here gives every page
      // (not just first/last) a real top AND bottom gutter.
      if (theme.marginV != null) {
        view.setAttribute('margin', theme.marginV + 'px');
        view.style.paddingTop = '0';
        view.style.paddingBottom = '0';
      }

      // Inject CSS into the current section document
      if (currentSectionDoc) injectThemeIntoDoc(currentSectionDoc);

      // After CSS changes reflow the columns — clear page counts and
      // re-precompute all sections. Wait for fonts to settle before
      // measuring so width calculations use the final glyph metrics.
      sectionPageCounts = {};
      sectionPageCountsLocked = false;
      (async () => {
        try { await document.fonts?.ready; } catch {}
        // Give foliate's paginator a moment to finish reflowing after CSS
        // mutation before we measure hidden containers with the same CSS.
        await new Promise(r => setTimeout(r, 150));
        await precomputeAllPages();
        if (view?.lastLocation) {
          view.dispatchEvent(new CustomEvent('relocate', { detail: view.lastLocation }));
        }
      })();
    }

    function remeasureCurrentSection() {
      // Never overwrite locked (precomputed) values — they're authoritative.
      if (sectionPageCountsLocked) return;
      if (!currentSectionDoc || !view) return;
      const vw = view.clientWidth || window.innerWidth;
      if (vw <= 0) return;
      try {
        const sw = currentSectionDoc.documentElement.scrollWidth
                 || currentSectionDoc.body?.scrollWidth || 0;
        if (sw > 0) {
          sectionPageCounts[currentSectionIndex] = Math.max(1, Math.ceil(sw / vw));
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

      // document.fonts.ready resolves immediately if no pending font is
      // actually in use. Explicitly force-load the theme font first so that
      // scrollWidth measurements use final glyph metrics, not fallback.
      const fs = currentTheme.fontSize || 16;
      const ff = currentTheme.fontFamily || 'serif';
      try {
        if (document.fonts?.load) {
          await document.fonts.load(fs + 'px "' + ff + '"');
        }
        await document.fonts?.ready;
      } catch {}

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
          // ceil matches foliate's expand(): pageCount = ceil(contentSize / size)
          sectionPageCounts[i] = Math.max(1, Math.ceil(sw / vw));
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
      sectionPageCountsLocked = true;
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

        // Docs we've already wired up (click + contextmenu + selection).
        // Each new section gets its own iframe document; we track them in a
        // WeakSet so attachTapHandlers can be called repeatedly without
        // stacking duplicate listeners.
        const attachedDocs = new WeakSet();
        function attachTapHandlers(doc) {
          if (!doc || attachedDocs.has(doc)) return;
          attachedDocs.add(doc);
          // Clicks inside foliate's section iframes don't bubble to the
          // parent document — attach directly so page-turn works from the
          // content area.
          doc.addEventListener('click', handleTap);
          // Suppress native Android context menu so our custom RN menu shows.
          doc.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            return false;
          });
          // Text selection — debounce selectionchange + pointerup.
          let selDebounce = null;
          function checkSelection() {
            const sel = doc.getSelection?.();
            if (sel && sel.toString().trim() && sel.rangeCount > 0 && !sel.isCollapsed) {
              let cfi = '';
              let rect = null;
              try {
                const range = sel.getRangeAt(0);
                const contents = view.renderer?.getContents?.() ?? [];
                const content = contents.find(c => c.doc.contains(range.startContainer));
                if (content) cfi = view.getCFI(content.index, range) ?? '';
                // Translate the range rect into top-window coordinates by
                // walking up frameElement chains — foliate nests the doc
                // inside one (or more) iframes.
                const r = range.getBoundingClientRect();
                let ox = 0, oy = 0;
                let win = doc.defaultView;
                while (win && win !== window && win.frameElement) {
                  const fr = win.frameElement.getBoundingClientRect();
                  ox += fr.left;
                  oy += fr.top;
                  win = win.parent;
                }
                rect = { x: r.left + ox, y: r.top + oy, w: r.width, h: r.height };
              } catch {}
              post('selectionChanged', { text: sel.toString(), cfi, rect });
            } else {
              post('selectionCleared', {});
            }
          }
          doc.addEventListener('selectionchange', () => {
            clearTimeout(selDebounce);
            selDebounce = setTimeout(checkSelection, 200);
          });
          doc.addEventListener('pointerup', () => {
            setTimeout(checkSelection, 80);
          });
        }

        // Attach tap handlers to every currently-rendered section doc.
        // Called from both 'load' and 'relocate' so we never miss a new
        // iframe, even if the 'load' event was missed due to listener
        // registration timing or foliate internals.
        function ensureAllDocsAttached() {
          try {
            const contents = view.renderer?.getContents?.() ?? [];
            for (const c of contents) attachTapHandlers(c.doc);
          } catch {}
        }

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

        // Relay location changes. Foliate emits d.section.current as the
        // current section index and d.fraction as the END fraction of the
        // current page (i.e., nextSize/sizeTotal — see foliate progress.js).
        view.addEventListener('relocate', (e) => {
          // Re-attach on every relocate as a safety net — idempotent via
          // the WeakSet, so this only does work for newly-rendered docs.
          ensureAllDocsAttached();
          const d = e.detail;
          const frac = d.fraction ?? 0;
          const totalSections = book?.sections?.length ?? 1;
          const secIdx = Math.max(0, Math.min(totalSections - 1, d.section?.current ?? 0));
          const sectionFractions = view.getSectionFractions?.() ?? [];

          // Prefer foliate's own paginator counts for the current section —
          // they're the exact column count foliate uses for navigation, so
          // pageInSection stays perfectly consistent with the visible page.
          // Scrollwidth-based precompute can drift ±1 from foliate's count,
          // so we overwrite the precomputed value with the authoritative one
          // whenever we actually render a section.
          let pagesInSection;
          let pageInSection;
          const rPages = view.renderer?.pages;
          const rPage = view.renderer?.page;
          if (typeof rPages === 'number' && rPages > 2 && typeof rPage === 'number') {
            pagesInSection = Math.max(1, rPages - 2);
            pageInSection = Math.max(1, Math.min(pagesInSection, rPage));
            sectionPageCounts[secIdx] = pagesInSection;
          } else {
            // Fallback path — renderer not ready. Use scrollwidth if we've
            // never seen this section, then derive page from the fraction.
            const vw = view.clientWidth || window.innerWidth;
            if (!sectionPageCountsLocked && !sectionPageCounts[secIdx] && currentSectionDoc && vw > 0) {
              try {
                const sw = currentSectionDoc.documentElement.scrollWidth || currentSectionDoc.body?.scrollWidth || 0;
                if (sw > 0) sectionPageCounts[secIdx] = Math.max(1, Math.ceil(sw / vw));
              } catch {}
            }
            pagesInSection = sectionPageCounts[secIdx] ?? 1;
            pageInSection = 1;
            if (pagesInSection > 1) {
              const sectionStart = sectionFractions[secIdx] ?? (secIdx / totalSections);
              const sectionEnd = sectionFractions[secIdx + 1] ?? ((secIdx + 1) / totalSections);
              const sectionSpan = Math.max(0, sectionEnd - sectionStart);
              const sectionFrac = sectionSpan > 0
                ? Math.min(1, Math.max(0, (frac - sectionStart) / sectionSpan))
                : 0;
              pageInSection = Math.max(1, Math.min(pagesInSection, Math.round(sectionFrac * pagesInSection) || 1));
            }
          }

          // Total pages — sum measured counts; estimate unmeasured ones as
          // the current section's page count (only used briefly during
          // initial load before precompute finishes).
          let totalPages = 0;
          let pagesBefore = 0;
          for (let i = 0; i < totalSections; i++) {
            const count = sectionPageCounts[i] ?? pagesInSection;
            if (i < secIdx) pagesBefore += count;
            totalPages += count;
          }
          totalPages = Math.max(1, totalPages);

          // Current page = sum of all prior sections' page counts + page in
          // current section. This is the only way to keep currentPage
          // consistent with pageInSection across non-uniform section sizes.
          const currentPage = Math.max(1, Math.min(totalPages, pagesBefore + pageInSection));

          post('progressUpdated', {
            percentage: Math.round(frac * 1000) / 10,
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
          if (!draw || !annotation) return;
          if (annotation.kind === 'note') {
            // Typed notes get a wavy amber underline; drawings get a
            // solid indigo underline so the two are visually distinct.
            // On e-ink both collapse to crisp black since the accent
            // colours otherwise ghost out.
            const eink = !!currentTheme?.isEink;
            if (annotation.noteType === 'handwritten') {
              draw(Overlayer.underline, { color: eink ? '#000' : '#6366f1' });
            } else {
              draw(Overlayer.squiggly, { color: eink ? '#000' : '#d97706' });
            }
          } else {
            const color = annotation.color || 'yellow';
            draw(Overlayer.highlight, { color });
          }
        });

        view.addEventListener('show-annotation', (e) => {
          const ann = e.detail ?? {};
          // Foliate strips custom annotation fields before dispatch, so
          // fall back to the noteCfis set to tell a note apart from a
          // highlight by value alone.
          if (ann.value && noteCfis.has(ann.value)) {
            post('noteTapped', { cfi: ann.value, noteType: noteCfis.get(ann.value) });
          } else {
            post('showAnnotation', ann);
          }
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

            attachTapHandlers(currentSectionDoc);
          }
        });

        // Handle text selection via the view's selection event
        view.addEventListener('external-link', (e) => {
          e.preventDefault();
          post('externalLink', { href: e.detail.href });
        });

        // Navigate to the first section so content renders immediately.
        // Must happen AFTER 'load'/'relocate' listeners are registered so
        // we don't miss the initial section's events.
        try { await view.goTo(book.toc?.[0]?.href ?? book.sections?.[0]?.id ?? 0); } catch {}
        ensureAllDocsAttached();

        // Report ready — RN will respond with setTheme, and applyTheme()
        // owns the precompute lifecycle from there (font-ready gated).
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
