#!/usr/bin/env node
/**
 * Bundle foliate-js into a single IIFE script for the WebView.
 * Output: android/app/src/main/assets/js/foliate-bundle.js
 * Also: assets/js/foliate-bundle.js (tracked in git)
 *
 * Run: node scripts/bundle-foliate.mjs
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Entry point that re-exports what we need
const entryCode = `
  export { makeBook } from 'foliate-js/view.js';
  export { Overlayer } from 'foliate-js/overlayer.js';
`;

const entryPath = join(root, ".foliate-entry.js");
writeFileSync(entryPath, entryCode);

const outDir = join(root, "assets", "js");
mkdirSync(outDir, { recursive: true });

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

// Also copy to android assets if directory exists
const androidOut = join(root, "android", "app", "src", "main", "assets", "js");
try {
  mkdirSync(androidOut, { recursive: true });
  const { copyFileSync } = await import("fs");
  copyFileSync(join(outDir, "foliate-bundle.js"), join(androidOut, "foliate-bundle.js"));
  console.log("✓ Copied to android assets");
} catch {}

console.log("✓ Built foliate-bundle.js");

// Clean up
import { unlinkSync } from "fs";
try { unlinkSync(entryPath); } catch {}
