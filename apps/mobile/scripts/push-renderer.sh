#!/usr/bin/env bash
# Push the latest renderer bundle to a dev-accessible sdcard path. The
# WebView's HTML shell tries this path before falling back to the
# bundled android_asset copy, so you can iterate on webview-src without
# rebuilding the APK.
#
# Usage:
#   ./scripts/push-renderer.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Rebuild the bundle.
node scripts/bundle-webview-assets.mjs

# Ensure target dir exists on device.
adb shell 'mkdir -p /sdcard/readr' || true

# Push the bundle.
adb push assets/js/renderer-bundle.js /sdcard/readr/renderer-bundle.js

echo "✓ Pushed renderer-bundle.js to /sdcard/readr/"
echo "  Reload the app's reader to pick up the new bundle."
