/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * EPUB reader client — runs inside the Android WebView. Now a thin
 * shim around `reader-core/reader-core.ts`: the core owns all the
 * foliate + theming + paging + selection logic, and we just wire it
 * up to the WebView's globals and postMessage bridge.
 *
 * The same core file is imported by the Expo Web reader screen,
 * which instantiates it with dynamically-loaded foliate-js and a
 * DOM container instead of this IIFE bundle. Keeping the transport
 * glue here — not in the core — means web's foliate import doesn't
 * pull in the Android asset paths, and native keeps its file://
 * XHR fetcher.
 */

import {
  createReaderCore,
  type FoliateBook,
  type FoliateOverlayer,
  type ReaderMessage,
} from "../reader-core/reader-core";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
    __foliate?: {
      makeBook: (f: File) => Promise<FoliateBook>;
      Overlayer: FoliateOverlayer;
    };
    __READR_CONFIG?: { bookUrl: string };
  }
}

// file:// URLs don't work with fetch() on Android WebView even with
// allowFileAccess enabled, but XMLHttpRequest does.
function fetchFile(url: string): Promise<Blob> {
  if (url.startsWith("file://")) {
    return new Promise<Blob>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "blob";
      xhr.onload = () =>
        xhr.status === 200 || xhr.status === 0
          ? resolve(xhr.response)
          : reject(new Error("XHR failed: " + xhr.status));
      xhr.onerror = () => reject(new Error("XHR network error"));
      xhr.send();
    });
  }
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.blob();
  });
}

function showError(msg: string): void {
  const loading = document.getElementById("loading");
  if (loading) loading.style.display = "none";
  const errorDiv = document.getElementById("error");
  if (errorDiv) {
    errorDiv.style.display = "flex";
    errorDiv.textContent = msg;
  }
}

function postToHost(type: string, payload: unknown): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type, payload }));
}

async function bootstrap(): Promise<void> {
  const config = window.__READR_CONFIG;
  if (!config?.bookUrl) {
    showError("Missing __READR_CONFIG.bookUrl");
    return;
  }
  const foliate = window.__foliate;
  if (!foliate) {
    showError("foliate-bundle not loaded");
    return;
  }
  const viewer = document.getElementById("viewer");
  if (!viewer) {
    showError("#viewer element missing");
    return;
  }

  const core = createReaderCore({
    makeBook: foliate.makeBook,
    Overlayer: foliate.Overlayer,
    container: viewer,
    onEvent: postToHost,
    fetchBookFile: fetchFile,
    fontBaseUrl: "file:///android_asset/fonts",
    // Native HTML shell paints <html>/<body>/#viewer itself so theme
    // transitions never show a frame of the old bg. Mirror the native
    // file's pre-refactor behaviour of updating those at runtime.
    onThemeChange: (bg) => {
      const root = document.documentElement;
      root.style.cssText = `background:${bg}!important`;
      document.body.style.cssText = `background:${bg}!important;margin:0;padding:0`;
      viewer.style.cssText = `width:100%;height:100%;background:${bg}`;
    },
  });

  try {
    await core.init(config.bookUrl);
    const loading = document.getElementById("loading");
    if (loading) loading.style.display = "none";
  } catch (err) {
    showError(
      "Failed to load book: " +
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((err as any)?.message ?? String(err)),
    );
    return;
  }

  // Wire up incoming RN messages. postMessage from RN injects a
  // MessageEvent with JSON.stringify'd payload in data.
  function forward(raw: string): void {
    try {
      core.dispatch(JSON.parse(raw) as ReaderMessage);
    } catch {
      /* ignore */
    }
  }
  window.addEventListener("message", (e: MessageEvent) => forward(e.data));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  document.addEventListener("message" as any, (e: any) => forward(e.data));
}

bootstrap();
