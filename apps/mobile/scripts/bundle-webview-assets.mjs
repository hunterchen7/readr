#!/usr/bin/env node
/**
 * Build WebView assets from npm dependencies.
 *
 *   foliate-js  → IIFE bundle for the EPUB reader
 *   pdfjs-dist  → pdf.min.mjs + pdf.worker.min.mjs for the PDF reader
 *
 * Output: assets/js/  (loaded by the WebView via file:///android_asset/js/)
 * Run:    node scripts/bundle-webview-assets.mjs
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "assets", "js");
mkdirSync(outDir, { recursive: true });

// ─── foliate-js ────────────────────────────────────────────────────
// We use foliate's view.js / overlayer.js / epubcfi.js / progress.js
// as-is, but REPLACE paginator.js with our fork at
// webview-src/foliate/paginator.js. The fork carries:
//   1. qr()/turnPage nav-lock try/finally + safety timeout
//   2. docBackground null guard on the rAF read
//   3. Multi-section support in scrolled flow (continuous scroll
//      across section boundaries — the whole point of scroll mode)
// view.js does a dynamic `await import('./paginator.js')` — an
// esbuild resolve plugin redirects that to our fork.
const forkedPaginator = join(root, "webview-src", "foliate", "paginator.js");

const entryCode = `
  export { makeBook } from 'foliate-js/view.js';
  export { Overlayer } from 'foliate-js/overlayer.js';
  export * as CFI from 'foliate-js/epubcfi.js';
  export { SectionProgress, TOCProgress } from 'foliate-js/progress.js';
`;
const entryPath = join(root, ".foliate-entry.js");
writeFileSync(entryPath, entryCode);

const paginatorForkPlugin = {
  name: "foliate-paginator-fork",
  setup(build) {
    build.onResolve({ filter: /(^|\/)paginator\.js$/ }, (args) => {
      if (args.importer && args.importer.includes("foliate-js")) {
        return { path: forkedPaginator };
      }
    });
  },
};

await build({
  entryPoints: [entryPath],
  bundle: true,
  format: "iife",
  globalName: "__foliate",
  outfile: join(outDir, "foliate-bundle.js"),
  platform: "browser",
  target: "es2020",
  minify: true,
  plugins: [paginatorForkPlugin],
});

try { unlinkSync(entryPath); } catch {}

console.log("✓ foliate-bundle.js");

// ─── reader.ts → reader-bundle.js ──────────────────────────────────
// The reader client (theming, tap handling, paging, selection, etc)
// lives in webview-src/reader.ts as real TypeScript. We bundle it here
// so epub-html.ts can stay a thin HTML shell instead of a 700-line
// string template that doesn't type-check.
await build({
  entryPoints: [join(root, "webview-src", "reader.ts")],
  bundle: true,
  format: "iife",
  outfile: join(outDir, "reader-bundle.js"),
  platform: "browser",
  target: "es2020",
  minify: true,
});
console.log("✓ reader-bundle.js");

// ─── pdfjs-dist ────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const pdfjsDir = join(dirname(require.resolve("pdfjs-dist/package.json")), "build");

copyFileSync(join(pdfjsDir, "pdf.min.mjs"), join(outDir, "pdf.min.mjs"));
copyFileSync(join(pdfjsDir, "pdf.worker.min.mjs"), join(outDir, "pdf.worker.min.mjs"));
console.log("✓ pdf.min.mjs + pdf.worker.min.mjs");

// ─── Copy to android assets if prebuild has run ────────────────────
const androidOut = join(root, "android", "app", "src", "main", "assets", "js");
try {
  mkdirSync(androidOut, { recursive: true });
  for (const f of ["foliate-bundle.js", "reader-bundle.js", "pdf.min.mjs", "pdf.worker.min.mjs"]) {
    copyFileSync(join(outDir, f), join(androidOut, f));
  }
  console.log("✓ Copied to android assets");
} catch {}
