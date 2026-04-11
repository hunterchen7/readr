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
import { copyFileSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
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

// Patch foliate's paginator qr() (prev/next).
//
// Two bugs in the upstream body:
//   1. No try/finally around the navigation lock — if any inner await
//      throws, `un` stays set and ALL subsequent navigation (including
//      goTo via ToC links) silently no-ops.
//   2. On section transitions, the inner `await _s(...)` hangs
//      indefinitely — the iframe `load` event fires and the new section
//      renders, but the downstream `scrollToAnchor` promise never
//      resolves. Root cause still unknown; see TODO below.
//
// Mitigation: wrap the body in try/finally + a 300ms safety timeout
// that force-releases the lock. 300ms is imperceptible as a back-off
// after a chapter turn, keeps the reader self-healing, and preserves
// foliate's intended serialization for same-section taps (which
// complete in ~100ms and never hit the timeout).
//
// TODO: diagnose why `_s`'s scrollToAnchor hangs on section load. If
// it can be fixed upstream, the safety timeout can be dropped and
// only the try/finally kept.
{
  const bundlePath = join(outDir, "foliate-bundle.js");
  const src = readFileSync(bundlePath, "utf8");
  const needle = /(qr=async function\(t,n\)\{if\(l\(this,un\)\)return;I\(this,un,!0\);)(let s=t===-1,r=await\(s\?k\(this,F,uc\)\.call\(this,n\):k\(this,F,dc\)\.call\(this,n\)\);r&&await k\(this,F,_s\)\.call\(this,\{index:k\(this,F,ln\)\.call\(this,t\),anchor:s\?\(\)=>1:\(\)=>0\}\),\(r\|\|!this\.hasAttribute\("animated"\)\)&&await qh\(100\))(,I\(this,un,!1\)\})/;
  if (!needle.test(src)) {
    throw new Error("foliate qr() patch failed: pattern not found. Did foliate-js update?");
  }
  const patched = src.replace(
    needle,
    "$1let __readrUnlock=setTimeout(()=>I(this,un,!1),300);try{$2}finally{clearTimeout(__readrUnlock);I(this,un,!1)}}"
  );
  writeFileSync(bundlePath, patched);
  console.log("✓ patched foliate qr() navigation lock");
}

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

// Also copy pdfjs into public/ so the web build serves it as plain
// static assets at /pdf.min.mjs + /pdf.worker.min.mjs.
//
// Metro can't bundle pdfjs-dist directly: pdfjs's main entry contains
// a dynamic `import(this.workerSrc)` with a non-static argument, and
// Metro rejects that at parse time. The web reader side-loads pdfjs
// at runtime with a dodged import() (see app/reader/[bookId].web.tsx)
// against these public/ copies, bypassing Metro entirely.
const publicDir = join(root, "public");
mkdirSync(publicDir, { recursive: true });
copyFileSync(join(pdfjsDir, "pdf.min.mjs"), join(publicDir, "pdf.min.mjs"));
copyFileSync(join(pdfjsDir, "pdf.worker.min.mjs"), join(publicDir, "pdf.worker.min.mjs"));
console.log("✓ public/pdf.min.mjs + public/pdf.worker.min.mjs");

// ─── Copy to android assets if prebuild has run ────────────────────
const androidOut = join(root, "android", "app", "src", "main", "assets", "js");
try {
  mkdirSync(androidOut, { recursive: true });
  for (const f of ["foliate-bundle.js", "reader-bundle.js", "pdf.min.mjs", "pdf.worker.min.mjs"]) {
    copyFileSync(join(outDir, f), join(androidOut, f));
  }
  console.log("✓ Copied to android assets");
} catch {}
