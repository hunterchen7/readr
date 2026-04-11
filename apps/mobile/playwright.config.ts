/**
 * Playwright config for the Expo Web smoke tests.
 *
 * These specs live in `tests/web/` and are *not* wired into CI yet
 * (they need browser binaries installed, which adds ~500 MB to
 * every PR run). To run locally:
 *
 *   pnpm -C apps/mobile exec playwright install chromium
 *   pnpm -C apps/mobile web:build
 *   pnpm -C apps/mobile test:web
 *
 * The tests start a static server over the exported `dist/`
 * directory so they exercise the real production bundle, not the
 * dev-server variant.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/web",
  fullyParallel: true,
  retries: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Add firefox/webkit here when we're ready to run cross-browser
    // in CI. Locally they work via `playwright test --project=firefox`.
  ],
  webServer: {
    command: "pnpm exec serve -s dist -l 4173",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
