/**
 * First-load smoke test for the Expo Web build of apps/mobile.
 *
 * Goal: catch the big regressions — bundle fails to boot, root
 * component throws, zustand selectors trigger an update-depth
 * loop, a native-only import slipped into the web chunk. Uses
 * the exported `dist/` artifact (not the dev server) so it runs
 * against the same bits that ship.
 *
 * To extend: once we have a test server with a fixture user + a
 * known book, add flows for login -> library -> upload -> reader.
 * See #13 for the full cross-browser + e2e plan.
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
    timeout: 10_000,
  });

  // Neither React nor our code should have logged any errors.
  // Allow the common "failed to load resource" that hits when a
  // favicon is missing or similar non-fatal misses.
  const realErrors = [
    ...consoleErrors.filter((e) => !e.includes("favicon")),
    ...pageErrors,
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
