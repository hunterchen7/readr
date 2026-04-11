/**
 * Generates the HTML shell for the EPUB reader WebView.
 *
 * The reader's runtime logic (theming, tap handling, pagination,
 * selection, etc) lives in `webview-src/reader.ts` and is bundled by
 * `scripts/bundle-webview-assets.mjs` into
 * `assets/js/reader-bundle.js`. This file just emits the outer HTML
 * document: static CSS, polyfills for old WebViews, and `<script>`
 * tags that load foliate-js and the reader bundle. Runtime config
 * (bookUrl) is injected via `window.__READR_CONFIG` before the
 * reader bundle runs.
 */

const BUNDLED_FONTS = [
  'Literata', 'Lora', 'Merriweather', 'EB Garamond', 'Source Serif 4',
  'Noto Serif', 'Crimson Text', 'Libre Baskerville', 'Playfair Display',
  'PT Serif', 'Roboto Slab', 'Roboto', 'Open Sans', 'Inter', 'Nunito',
  'Fira Mono', 'IBM Plex Mono',
];

function fontFaceCss(): string {
  return BUNDLED_FONTS.map((f) => {
    const file = f.replace(/\s+/g, '');
    return `@font-face { font-family: '${f}'; src: url('file:///android_asset/fonts/${file}.ttf'); }`;
  }).join('\n    ');
}

// Polyfills for WebViews older than Chrome 117 (e.g. Supernote A5X
// ships Chromium 96). foliate-js uses Object.groupBy / Map.groupBy /
// findLast during EPUB metadata parsing; without these the book
// fails to load with "Object.groupBy is not a function". Kept inline
// so it's the very first script in the document.
const POLYFILLS = `
(function () {
  function groupBy(items, fn) {
    var out = Object.create(null);
    var i = 0;
    for (var it of items) {
      var k = fn(it, i++);
      (out[k] = out[k] || []).push(it);
    }
    return out;
  }
  if (typeof Object.groupBy !== 'function') Object.groupBy = groupBy;
  if (typeof Map.groupBy !== 'function') {
    Map.groupBy = function (items, fn) {
      var m = new Map();
      var i = 0;
      for (var it of items) {
        var k = fn(it, i++);
        var arr = m.get(k);
        if (!arr) { arr = []; m.set(k, arr); }
        arr.push(it);
      }
      return m;
    };
  }
  if (typeof Array.prototype.findLast !== 'function') {
    Array.prototype.findLast = function (fn, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) {
        if (fn.call(thisArg, this[i], i, this)) return this[i];
      }
      return undefined;
    };
  }
  if (typeof Array.prototype.findLastIndex !== 'function') {
    Array.prototype.findLastIndex = function (fn, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) {
        if (fn.call(thisArg, this[i], i, this)) return i;
      }
      return -1;
    };
  }
})();
`;

export function getReaderHtml(bookUrl: string, initialBg?: string, initialFg?: string): string {
  const bg = initialBg || '#fff';
  const fg = initialFg || '#111';
  const config = JSON.stringify({ bookUrl });
  return `<!DOCTYPE html>
<html style="background:${bg};color:${fg}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    ${fontFaceCss()}
  </style>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: ${bg}; color: ${fg}; }
    /* Hidden until RN restores (or explicitly reveals) the saved
       position — otherwise foliate's initial goTo(firstSection) flashes
       before the resume nav lands. Visibility (not display) so foliate
       can still measure for pagination while invisible. */
    #viewer { width: 100%; height: 100%; background: ${bg}; visibility: hidden; }
    foliate-view { width: 100%; height: 100%; background: ${bg}; border: none; }
    iframe { border: none; }
    #loading, #error {
      display: flex; justify-content: center; align-items: center;
      height: 100%; font-family: system-ui, sans-serif; padding: 24px; text-align: center;
    }
    #loading { color: #666; }
    #error { display: none; color: #dc2626; }
  </style>
  <script>${POLYFILLS}</script>
  <script src="file:///android_asset/js/foliate-bundle.js"></script>
</head>
<body>
  <div id="loading">Loading book...</div>
  <div id="error"></div>
  <div id="viewer"></div>
  <script>window.__READR_CONFIG = ${config};</script>
  <script src="file:///android_asset/js/reader-bundle.js"></script>
</body>
</html>`;
}
