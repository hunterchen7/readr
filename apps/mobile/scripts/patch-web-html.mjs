#!/usr/bin/env node
/**
 * Post-process the Expo Web export's index.html.
 *
 * We run with `output: "single"` in app.config.js, which makes
 * Metro produce a fixed HTML shell that does NOT honour app/+html.tsx
 * (that only works in "static" output mode). To still inject the
 * PWA manifest link, theme-color, and a few standalone-mode meta
 * tags, patch the generated file here after the exporter finishes.
 *
 * Run as: node scripts/patch-web-html.mjs [dist-dir]
 * Default dist-dir is `dist`.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const distDir = process.argv[2] || "dist";
const indexPath = join(process.cwd(), distDir, "index.html");

const INJECT = `
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#111111" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="Readr" />
  <meta name="application-name" content="Readr" />
  <meta name="description" content="A self-hosted ebook reader for EPUB and PDF with cross-device sync." />
  <script>
    // Register the precache service worker (generated post-export
    // by scripts/generate-service-worker.mjs). Failing silently
    // degrades gracefully — the app still works, just without an
    // offline shell.
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("/sw.js").catch(function () {});
      });
    }
  </script>`;

let html;
try {
  html = readFileSync(indexPath, "utf8");
} catch (err) {
  console.error(`✗ could not read ${indexPath}: ${err.message}`);
  process.exit(1);
}

if (html.includes('rel="manifest"')) {
  console.log("✓ index.html already patched — skipping");
  process.exit(0);
}

// Insert just before </head>. The exact position doesn't matter
// for the tags we're adding, but keeping them grouped at the end
// of <head> is the conventional spot.
const patched = html.replace("</head>", `${INJECT}\n  </head>`);

if (patched === html) {
  console.error("✗ could not find </head> in index.html");
  process.exit(1);
}

writeFileSync(indexPath, patched);
console.log(`✓ patched ${indexPath}`);
