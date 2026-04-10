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
const entryCode = `
  export { makeBook } from 'foliate-js/view.js';
  export { Overlayer } from 'foliate-js/overlayer.js';
`;
const entryPath = join(root, ".foliate-entry.js");
writeFileSync(entryPath, entryCode);

await build({
  entryPoints: [entryPath],
  bundle: true,
  format: "iife",
  globalName: "__foliate",
  outfile: join(outDir, "foliate-bundle.js"),
  platform: "browser",
  target: "es2020",
  minify: true,
});

try { unlinkSync(entryPath); } catch {}
console.log("✓ foliate-bundle.js");

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
  for (const f of ["foliate-bundle.js", "pdf.min.mjs", "pdf.worker.min.mjs"]) {
    copyFileSync(join(outDir, f), join(androidOut, f));
  }
  console.log("✓ Copied to android assets");
} catch {}
