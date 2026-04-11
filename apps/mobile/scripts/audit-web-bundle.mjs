#!/usr/bin/env node
/**
 * Post-export audit for the Expo Web bundle.
 *
 * Runs after `expo export --platform web` and asserts:
 *   1. index.html exists and carries the PWA manifest link
 *   2. the main entry JS bundle does NOT contain references to
 *      native-only modules that were supposed to be shimmed out
 *      via .web.ts resolution (react-native-webview, expo-speech,
 *      expo-brightness, expo-av, expo-sharing)
 *
 * Runs as: node scripts/audit-web-bundle.mjs [dist-dir]
 * Default dist-dir is `dist`. Exits non-zero on any failure so
 * CI catches leaks.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

const distDir = process.argv[2] || "dist";
const root = join(process.cwd(), distDir);

if (!existsSync(root)) {
  console.error(`✗ dist dir not found: ${root}`);
  process.exit(1);
}

// ─── Check 1: index.html + manifest link ─────────────────────────────────
const indexPath = join(root, "index.html");
if (!existsSync(indexPath)) {
  console.error(`✗ missing index.html at ${indexPath}`);
  process.exit(1);
}
const indexHtml = readFileSync(indexPath, "utf8");
if (!indexHtml.includes('rel="manifest"')) {
  console.error("✗ index.html is missing the <link rel=\"manifest\"> tag");
  process.exit(1);
}
console.log("✓ index.html has manifest link");

const manifestPath = join(root, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`✗ missing manifest.json at ${manifestPath}`);
  process.exit(1);
}
console.log("✓ manifest.json exists");

// ─── Check 2: no native-only modules in the main entry bundle ───────────
//
// These are RN libraries that we shimmed away via .web.ts variants
// or behind Platform.OS guards. If one of them shows up here, a new
// import slipped past the platform resolution and the user will hit
// an undefined/crash at runtime.
const FORBIDDEN_PATTERNS = [
  // react-native-webview ships a "WebView" component referenced by
  // name; the native reader screen uses it but the web reader
  // doesn't, and the .web.tsx stub should keep it out.
  { name: "react-native-webview", pattern: /RNCWebView|react-native-webview/ },
  // expo-speech imports a native module via `requireNativeModule`.
  { name: "expo-speech", pattern: /requireNativeModule\(["']ExponentSpeech["']\)|ExpoSpeechModule/ },
  // expo-brightness — same idea.
  { name: "expo-brightness", pattern: /requireNativeModule\(["']ExpoBrightness["']\)|ExpoBrightnessModule/ },
  // expo-av (audio) — not used by any web code path.
  { name: "expo-av", pattern: /requireNativeModule\(["']ExponentAV["']\)|ExpoAVModule/ },
  // expo-sharing — the web export-annotations uses Blob + <a download>.
  { name: "expo-sharing", pattern: /requireNativeModule\(["']ExpoSharing["']\)|ExpoSharingModule/ },
  // expo-sqlite — native path only. Web uses IndexedDB via web-idb.ts.
  { name: "expo-sqlite", pattern: /requireNativeModule\(["']ExpoSQLite["']\)|ExpoSQLiteNext/ },
  // expo-file-system — native path only. Web uses OPFS via book-cache.web.ts.
  { name: "expo-file-system", pattern: /requireNativeModule\(["']ExponentFileSystem["']\)|ExpoFileSystemNext/ },
  // expo-secure-store — native path only. Web uses localStorage via storage.web.ts.
  { name: "expo-secure-store", pattern: /requireNativeModule\(["']ExpoSecureStore["']\)/ },
];

const jsDir = join(root, "_expo", "static", "js", "web");
if (!existsSync(jsDir)) {
  console.error(`✗ JS dir not found: ${jsDir}`);
  process.exit(1);
}

const entryFiles = readdirSync(jsDir)
  .filter((f) => f.startsWith("entry-") && f.endsWith(".js"))
  .map((f) => join(jsDir, f));

if (entryFiles.length === 0) {
  console.error("✗ no entry-*.js bundle found — expo export didn't run?");
  process.exit(1);
}

let hasLeak = false;
for (const entry of entryFiles) {
  const size = statSync(entry).size;
  const sizeMb = (size / (1024 * 1024)).toFixed(2);
  console.log(`• ${entry.replace(root, distDir)} (${sizeMb} MB)`);
  const body = readFileSync(entry, "utf8");
  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(body)) {
      console.error(`  ✗ leaked module: ${name}`);
      hasLeak = true;
    }
  }
}

if (hasLeak) {
  console.error("\n✗ web bundle contains native-only modules — check .web.ts shims");
  process.exit(1);
}

console.log("\n✓ web bundle audit passed");
