/**
 * Generates the HTML shell for the EPUB reader WebView.
 *
 * The reader's runtime logic (parsing, rendering, theming, navigation,
 * selection, annotations) lives in `webview-src/renderer/` and is
 * bundled by `scripts/bundle-webview-assets.mjs` into
 * `assets/js/renderer-bundle.js`. This file just emits the outer HTML
 * document: static CSS, polyfills for old WebViews, and the `<script>`
 * tag that loads the renderer bundle. Runtime config (bookUrl) is
 * injected via `window.__READR_CONFIG` before the bundle runs.
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
// ships Chromium 96). Kept inline so it's the very first script in the
// document and runs before our bundle executes.
const POLYFILLS = `
(function () {
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

// The renderer bundle is inlined directly in the HTML document, not
// loaded from android_asset. That lets us iterate on webview-src
// without rebuilding + reinstalling the APK — `pnpm run
// build:webview-assets` regenerates the TS module and Metro's watch
// picks it up on next app reload.
import { RENDERER_BUNDLE } from "./renderer-bundle.generated";

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
    #viewer { width: 100%; height: 100%; background: ${bg}; }
    #loading, #error {
      display: flex; justify-content: center; align-items: center;
      height: 100%; font-family: system-ui, sans-serif; padding: 24px; text-align: center;
    }
    #loading { color: #666; }
    #error { display: none; color: #dc2626; }
  </style>
  <script>${POLYFILLS}</script>
</head>
<body>
  <div id="loading">Loading book...</div>
  <div id="error"></div>
  <div id="viewer"></div>
  <script>window.__READR_CONFIG = ${config};</script>
  <script>${RENDERER_BUNDLE}</script>
</body>
</html>`;
}
