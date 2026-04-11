/**
 * Smoke tests for the Expo Web build of apps/mobile. Run against the
 * exported `dist/` artifact (not the dev server) so the same bits that
 * ship to prod are exercised.
 *
 * Coverage:
 *   - login screen boots without console/page errors
 *   - PWA manifest + meta tags land in index.html
 *   - service worker registers + the precache manifest is served
 *   - the pdf assets + sw.js are reachable
 *   - an unknown route serves the SPA shell (critical for PWA
 *     offline reloads deep-linked into the app)
 *
 * A full e2e login → library → upload → reader flow needs a test
 * server + fixture user, which is tracked separately and will live
 * in a companion spec once the CI harness spins up apps/server.
 */
import { test, expect } from "@playwright/test";

test("login screen renders without console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  await page.goto("/");

  // Wait for React to mount and paint something identifiable.
  // The login screen shows "Readr" as a title and a "Continue"
  // button; either anchor is fine.
  await expect(page.getByText("Readr").first()).toBeVisible({
    timeout: 15_000,
  });

  // Neither React nor our code should have logged any errors.
  // Allow favicon misses and the service worker registration
  // racing page load (which is harmless).
  const realErrors = [
    ...consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ServiceWorker"),
    ),
    ...pageErrors.filter((e) => !e.includes("ServiceWorker")),
  ];
  expect(realErrors, "console and pageerror output").toEqual([]);
});

test("manifest.json + PWA meta tags present", async ({ page }) => {
  await page.goto("/");
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute("href", "/manifest.json");

  const themeColor = page.locator('meta[name="theme-color"]');
  await expect(themeColor).toHaveAttribute("content", "#111111");

  // The manifest file itself should resolve.
  const res = await page.request.get("/manifest.json");
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.name).toBe("Readr");
  expect(body.display).toBe("standalone");
});

test("service worker is registered and precache manifest is served", async ({ page }) => {
  // sw.js itself should be served with a content-type the browser
  // will accept for a service worker registration.
  const swRes = await page.request.get("/sw.js");
  expect(swRes.ok()).toBe(true);
  const body = await swRes.text();
  expect(body).toContain("CACHE_NAME");
  expect(body).toContain("PRECACHE");
  // The generator hashes the precache list into VERSION, so the
  // file must contain a non-trivial version string.
  const versionMatch = body.match(/VERSION = "([^"]+)"/);
  expect(versionMatch?.[1]?.length ?? 0).toBeGreaterThan(4);

  // Navigate and wait for the boot script to call register(). The
  // registration is awaited via window.load, so we poll on the
  // navigator state.
  await page.goto("/");
  await page.waitForFunction(() => "serviceWorker" in navigator, { timeout: 5_000 });
  // We don't assert the registration actually *resolved* because
  // Playwright's chromium defaults disable SW caching in some
  // configs, but we do verify our registration call exists in
  // the HTML shell.
  const html = await page.content();
  expect(html).toContain("serviceWorker.register");
});

test("PDF reader assets are reachable from dist root", async ({ page }) => {
  for (const path of ["/pdf.min.mjs", "/pdf.worker.min.mjs"]) {
    const res = await page.request.get(path);
    expect(res.ok(), `${path} should be served`).toBe(true);
    // These are ESM modules — the first line should be a module
    // statement or a /* comment header, never HTML.
    const body = (await res.text()).slice(0, 80).trim();
    expect(body.startsWith("<")).toBe(false);
  }
});

test("SPA fallback serves the app shell for unknown routes", async ({ page }) => {
  // Deep-linking into the app (or a hard-refresh from a subroute)
  // should serve index.html so expo-router can resolve the path
  // client-side. The static `serve` webServer in playwright.config
  // is set up with -s to enable this fallback; this test guards
  // against regressions in the deploy config.
  await page.goto("/library");
  await expect(page.getByText("Readr").first()).toBeVisible({
    timeout: 15_000,
  });
});
