/**
 * Web reader screen.
 *
 * Mounts foliate-js directly into the host document instead of going
 * through a WebView. The same `reader-core/reader-core.ts` that the
 * native webview-src/reader.ts shim uses is instantiated here with
 * DOM-local dependencies: dynamically-imported foliate makeBook +
 * Overlayer, a plain div container, an event callback that drives
 * React state, and a fetch-based book fetcher.
 *
 * Scope for this first cut:
 *   - load + render an EPUB via foliate-js
 *   - keyboard + tap page turns
 *   - theme application (bg, fg, font, margins)
 *   - bookmarks, highlights via the IndexedDB local-db
 *   - TOC drawer jumping + current chapter highlight
 *   - progress saving + session logging
 *   - header bar / scrubber / back to library
 *
 * Deferred to follow-ups:
 *   - TTS UI (the store is wired but no bar)
 *   - handwriting / typed notes (reader-core supports them; UI TBD)
 *   - dictionary sheet, in-book search
 *   - PDF (pdf-html.ts extraction is a separate todo)
 */
import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Alert,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  BookPosition,
  Bookmark,
  Highlight,
  HighlightColor,
  Note,
} from "@readr/shared";
import { DEFAULT_LOOKUP_PROVIDERS } from "@readr/shared";
import { BookOpen, Settings, Bookmark as BookmarkIcon, ArrowLeft } from "lucide-react-native";
import { getBook, logReadingSession } from "../../lib/api";
import {
  createReaderCore,
  type ReaderCoreHandle,
  type FoliateBook,
  type FoliateOverlayer,
} from "../../reader-core/reader-core";
import {
  createPdfCore,
  type PdfCoreHandle,
  type PdfjsLib,
} from "../../reader-core/pdf-core";
import {
  upsertProgress,
  getProgress,
  getBookmarks,
  createBookmark,
  deleteBookmark,
  createHighlight,
  deleteHighlight,
  getHighlights,
  getNotes,
  deleteNote,
} from "../../lib/local-db";
import { loadReaderPrefs, saveReaderPrefs } from "../../lib/reader-prefs";
import { getDownloadedBook } from "../../lib/book-cache";
import {
  DEFAULT_THEME,
  type ReaderTheme,
} from "../../components/reader/ReaderControls";
import { ContextMenu } from "../../components/reader/ContextMenu";
import { TocDrawer } from "../../components/reader/TocDrawer";
import { LoadingIndicator } from "../../components/LoadingIndicator";
import { ErrorFallback } from "../../components/ErrorFallback";
import { spacing, fontSize } from "../../lib/theme";

interface TocItem {
  label: string;
  href: string;
  depth: number;
}

interface FoliateGlobals {
  makeBook: (f: File) => Promise<FoliateBook>;
  Overlayer: FoliateOverlayer;
}

/**
 * Dynamically import foliate-js and register its custom element.
 * Cached in a module-level promise so subsequent reader opens don't
 * re-evaluate the bundle. foliate-js is still ~200 KB — caching it
 * also avoids re-running its `customElements.define('foliate-view')`
 * which would throw on the second call.
 */
let foliatePromise: Promise<FoliateGlobals> | null = null;
function loadFoliate(): Promise<FoliateGlobals> {
  if (foliatePromise) return foliatePromise;
  foliatePromise = (async () => {
    // Dynamic imports so the library/upload screens don't pay
    // foliate's bundle size at initial load.
    const [viewMod, overlayerMod] = await Promise.all([
      // @ts-expect-error foliate-js ships without type declarations
      import("foliate-js/view.js"),
      // @ts-expect-error foliate-js ships without type declarations
      import("foliate-js/overlayer.js"),
    ]);
    return {
      makeBook: viewMod.makeBook as FoliateGlobals["makeBook"],
      Overlayer: overlayerMod.Overlayer as FoliateGlobals["Overlayer"],
    };
  })();
  return foliatePromise;
}

/**
 * Lazy-load pdfjs-dist at runtime from /pdf.min.mjs. We can't use
 * Metro's dynamic `import("pdfjs-dist")` here because pdfjs 4.x's
 * entry does `import(this.workerSrc)` with a non-literal — Metro
 * rejects that at parse time with "Invalid call at line 21:
 * import(this.workerSrc)".
 *
 * Sidestep: bundle-webview-assets.mjs copies pdf.min.mjs +
 * pdf.worker.min.mjs into public/ so they're served as plain static
 * assets in the exported bundle. Then we import them via a
 * `new Function(...)` shim that Metro doesn't try to resolve.
 */
let pdfjsPromise: Promise<PdfjsLib> | null = null;
function loadPdfjs(): Promise<PdfjsLib> {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const dyn = new Function("url", "return import(url)") as (
      url: string,
    ) => Promise<Record<string, unknown>>;
    const mod = await dyn("/pdf.min.mjs");
    const pdfjs = ((mod as { default?: PdfjsLib }).default ?? (mod as unknown)) as PdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    return pdfjs;
  })();
  return pdfjsPromise;
}

export default function WebReaderScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const insets = useSafeAreaInsets();

  const [theme, setTheme] = useState<ReaderTheme>(DEFAULT_THEME);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [showTocDrawer, setShowTocDrawer] = useState(false);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [progress, setProgress] = useState(0);
  const [currentPosition, setCurrentPosition] = useState<BookPosition | null>(null);
  const [currentChapterHref, setCurrentChapterHref] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number | null>(null);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [coreReady, setCoreReady] = useState(false);
  // Epoch bumped on retry to force the bootstrap useEffect to
  // re-fire when nothing in the query data has changed. Without it,
  // clicking "Retry" on a coreError would just toggle coreError
  // without re-creating the core, and the user would be stuck on
  // the loading spinner forever.
  const [coreEpoch, setCoreEpoch] = useState(0);
  const [selectedText, setSelectedText] = useState("");
  const [selectionCfi, setSelectionCfi] = useState<string | null>(null);
  const [selectionRect, setSelectionRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [contextMenuVisible, setContextMenuVisible] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Either an EPUB ReaderCoreHandle or a PDF core handle; both
  // expose the same {init, dispatch, destroy} surface so the React
  // glue can stay format-agnostic.
  const coreRef = useRef<ReaderCoreHandle | PdfCoreHandle | null>(null);
  // Local drag state for the progress scrubber. While the user is
  // actively dragging the range input, `scrubValue` holds the
  // in-progress fraction so the thumb follows the pointer smoothly,
  // and `isDraggingRef` blocks incoming progressUpdated events from
  // overwriting `progress` state (which would flicker the thumb
  // back to the old position mid-drag). On release we dispatch a
  // single goToLocation with the final fraction — matching native
  // PanResponder-driven behaviour on RN.
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const isDraggingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Initial-position handling. Mirrors the native reader
  // (f3e1cd8 + 395cba9):
  //   - savedPositionRef pins the DB-loaded position so the restore
  //     effect doesn't read the live `currentPosition` state, which
  //     gets clobbered by the first progressUpdated event.
  //   - hasLoadedSavedRef says "DB load finished".
  //   - hasRestoredRef gates progressUpdated persistence — foliate
  //     fires a relocate at pct=0 before the restore runs, and
  //     persisting it would clobber the real saved row.
  //   - pendingReadyRestoreRef buffers a "ready" that arrived
  //     before the DB load finished, so we don't skip the restore.
  //   - replayedAnnotationsRef is the same idea for highlight/note
  //     replay: we want to replay exactly once, after BOTH the core
  //     is ready AND the DB load has finished. With a `[coreReady]`
  //     dep only, a warm-foliate fast boot beats a slow IDB read
  //     and the effect fires with an empty `highlights` closure,
  //     silently skipping the replay.
  const savedPositionRef = useRef<BookPosition | null>(null);
  const hasLoadedSavedRef = useRef(false);
  const hasRestoredRef = useRef(false);
  const pendingReadyRestoreRef = useRef(false);
  const replayedAnnotationsRef = useRef(false);

  // Reading session tracking — log duration when the reader
  // unmounts. The refs are declared here (above the DB load effect)
  // so that effect can anchor sessionStartRef.pct to the real saved
  // position when it loads, instead of leaving it at 0.
  const sessionStartRef = useRef<{ at: number; pct: number }>({
    at: Date.now(),
    pct: 0,
  });
  const latestPctRef = useRef(0);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => getBook(bookId!),
    enabled: !!bookId,
  });
  const book = data?.book;

  // Issue the initial restore navigation once the saved position is
  // loaded AND the core reports ready. Prefer `fraction` over `cfi`
  // because CFIs embed structural indices that can land on the wrong
  // paragraph when the resuming device paginates differently than
  // the writing one — fraction is stable across layout differences.
  // Mirrors native applySavedRestore() in f3e1cd8.
  const applySavedRestore = useCallback(() => {
    const saved = savedPositionRef.current;
    const core = coreRef.current;
    if (core && saved) {
      const pct = saved.percentage;
      if (typeof pct === "number" && pct > 0) {
        core.dispatch({ type: "goToLocation", payload: { fraction: pct / 100 } });
      } else if (saved.cfi) {
        core.dispatch({ type: "goToLocation", payload: { cfi: saved.cfi } });
      }
    }
    hasRestoredRef.current = true;
  }, []);

  // Load persisted state on mount.
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    savedPositionRef.current = null;
    hasLoadedSavedRef.current = false;
    hasRestoredRef.current = false;
    pendingReadyRestoreRef.current = false;
    replayedAnnotationsRef.current = false;
    (async () => {
      const [savedProgress, savedBookmarks, savedHighlights, savedNotes, savedPrefs] = await Promise.all([
        getProgress(bookId),
        getBookmarks(bookId),
        getHighlights(bookId),
        getNotes(bookId),
        loadReaderPrefs(),
      ]);
      if (cancelled) return;
      if (savedProgress) {
        savedPositionRef.current = savedProgress.position;
        setProgress(savedProgress.position.percentage);
        setCurrentPosition(savedProgress.position);
        // Anchor the session-start pct to the real saved position
        // instead of 0. The session-tracking effect fires on bookId
        // change and captures the current `progress` state, which is
        // still 0 at that moment (the DB load hasn't run yet). Without
        // this fixup, the reading-sessions log reports startPercentage
        // as 0 for every resumed book, inflating the apparent session
        // delta by whatever had already been read.
        sessionStartRef.current = {
          at: sessionStartRef.current.at,
          pct: savedProgress.position.percentage,
        };
        latestPctRef.current = savedProgress.position.percentage;
      }
      hasLoadedSavedRef.current = true;
      setBookmarks(savedBookmarks);
      setHighlights(savedHighlights);
      setNotes(savedNotes);
      if (savedPrefs?.theme) setTheme({ ...DEFAULT_THEME, ...savedPrefs.theme });
      // If the core already fired `ready` while we were waiting on
      // the DB load, run the buffered restore now.
      if (pendingReadyRestoreRef.current) {
        pendingReadyRestoreRef.current = false;
        applySavedRestore();
      }
    })();
    return () => { cancelled = true; };
  }, [bookId, applySavedRestore]);

  // Session tracking effects. The refs themselves are declared
  // earlier (so the DB load effect can seed them with the real
  // saved position); these effects keep them up to date and fire
  // the unmount log.
  //
  // The "start" timestamp resets on bookId change. The pct seed
  // comes from whichever resolves first — the DB load anchoring it
  // to savedProgress, or this effect defaulting it to `progress`
  // (which is 0 until the DB load runs). Either way, unmount logs
  // the correct start→end delta.
  useEffect(() => {
    sessionStartRef.current = { at: Date.now(), pct: progress };
    latestPctRef.current = progress;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);
  useEffect(() => {
    latestPctRef.current = progress;
  }, [progress]);
  useEffect(() => {
    return () => {
      const start = sessionStartRef.current;
      const durationMs = Date.now() - start.at;
      const durationMinutes = Math.round(durationMs / 60_000);
      if (!bookId || durationMinutes < 1) return;
      logReadingSession({
        bookId,
        startedAt: new Date(start.at).toISOString(),
        endedAt: new Date().toISOString(),
        durationMinutes,
        startPercentage: Math.round(start.pct),
        endPercentage: Math.round(latestPctRef.current),
      }).catch(() => {});
    };
  }, [bookId]);

  // Core → React glue. Mirrors the handleMessage switch in the
  // native reader screen.
  const handleCoreEvent = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (type: string, payload: any) => {
      if (!mountedRef.current) return;
      switch (type) {
        case "ready":
          setCoreReady(true);
          // If the DB load already finished, apply the restore now;
          // otherwise buffer the intent and let the DB-load effect
          // fire it once savedPositionRef is populated. Either way,
          // `hasRestoredRef` won't flip until the actual dispatch
          // runs, so progressUpdated persistence stays blocked.
          if (hasLoadedSavedRef.current) {
            applySavedRestore();
          } else {
            pendingReadyRestoreRef.current = true;
          }
          break;
        case "tocLoaded":
          setToc(payload.chapters ?? []);
          break;
        case "progressUpdated": {
          // While the user is actively dragging the scrubber, any
          // relocate events from mid-navigation would flicker the
          // thumb back to the pre-drag position. Mirrors the
          // isDraggingRef gate in the native reader's relocate
          // handler.
          if (isDraggingRef.current) break;
          const pct = payload.percentage ?? 0;
          setProgress(pct);
          const position: BookPosition = {
            percentage: pct,
            cfi: payload.cfi,
            chapter: payload.chapter,
            page: payload.currentPage ?? payload.page,
          };
          setCurrentPosition(position);
          setCurrentChapterHref(payload.chapterHref ?? null);
          const rawPage = payload.currentPage;
          const rawTotal = payload.totalPages;
          if (typeof rawPage === "number" && typeof rawTotal === "number" && rawTotal > 0) {
            setCurrentPage(Math.min(rawTotal, Math.max(1, Math.round(rawPage))));
            setTotalPages(rawTotal);
          } else {
            setCurrentPage(null);
            setTotalPages(null);
          }
          // Don't persist until the initial restore has run — the very
          // first relocate from foliate fires at pct=0 and would
          // otherwise clobber the saved position. Mirrors the native
          // reader's hasRestoredRef gate.
          if (bookId && hasRestoredRef.current) {
            void upsertProgress(bookId, position);
          }
          break;
        }
        case "tapCenter":
          setControlsVisible((v) => !v);
          break;
        case "error":
          setCoreError(payload?.message ?? "Reader failed");
          break;
        case "externalLink":
          try { window.open(payload.href, "_blank", "noopener"); } catch { /* ignore */ }
          break;
        case "selectionChanged":
          if (payload?.text) {
            setSelectedText(payload.text);
            setSelectionCfi(payload.cfi ?? "");
            setSelectionRect(payload.rect ?? null);
            setContextMenuVisible(true);
          }
          break;
        case "selectionCleared":
          // Don't auto-close the menu — the user might be picking
          // a color. They close it explicitly via the overlay.
          break;
        default:
          break;
      }
    },
    [bookId],
  );

  // Mount the reader core once book metadata and container are
  // ready. Branch on format: EPUB uses foliate via reader-core,
  // PDF uses pdf-core with dynamically-loaded pdfjs-dist. Either
  // way we prefer an OPFS-cached copy over the remote URL so
  // offline reading works and re-opens are instant.
  const remoteUrl = book?.downloadUrl;
  const format = book?.format ?? "epub";
  useEffect(() => {
    if (!bookId || !remoteUrl || !containerRef.current) return;
    let cancelled = false;
    setCoreError(null);
    setCoreReady(false);
    // Reset the restore + annotation-replay gates for this fresh
    // reader mount. The DB-load effect (keyed on bookId) resets the
    // other refs separately, but these two are keyed on the core
    // lifecycle — we want them to reset even if, say, a retry from
    // the error fallback re-fires the bootstrap effect without a
    // bookId change.
    hasRestoredRef.current = false;
    pendingReadyRestoreRef.current = false;
    replayedAnnotationsRef.current = false;

    const container = containerRef.current;
    let core: ReaderCoreHandle | PdfCoreHandle | null = null;
    let blobUrlToRevoke: string | null = null;

    (async () => {
      try {
        // Check OPFS first. If we have the book cached, pass its
        // blob URL to the core and skip the network round trip.
        // getDownloadedBook creates a blob URL via createObjectURL;
        // we own it from here on and must revoke whether or not we
        // end up using it, otherwise a cancellation race leaks it.
        let effectiveUrl = remoteUrl;
        try {
          const cached = await getDownloadedBook(bookId);
          if (cached) {
            if (cancelled) {
              // Core is being torn down before we got a chance to
              // hand this URL off — revoke directly and bail.
              try { URL.revokeObjectURL(cached.localPath); } catch { /* ignore */ }
              return;
            }
            effectiveUrl = cached.localPath;
            blobUrlToRevoke = cached.localPath;
          }
        } catch {
          // Cache miss / OPFS unavailable — fall back to network.
        }

        if (format === "pdf") {
          const pdfjs = await loadPdfjs();
          if (cancelled) return;
          core = createPdfCore({
            pdfjsLib: pdfjs,
            container,
            onEvent: handleCoreEvent,
            // pdfjs handles its own fetching for http(s) and blob:
            // URLs, no pre-fetch helper needed on web.
            fetchBookFile: undefined,
          });
        } else {
          const foliate = await loadFoliate();
          if (cancelled) return;
          core = createReaderCore({
            makeBook: foliate.makeBook,
            Overlayer: foliate.Overlayer,
            container,
            fetchBookFile: (url) => fetch(url).then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.blob();
            }),
            fontBaseUrl: null, // web doesn't ship the bundled Android fonts yet
            onEvent: handleCoreEvent,
            onThemeChange: (bg) => {
              // Keep the container bg in sync; deliberately avoid
              // touching <html>/<body> so other routes stay clean.
              container.style.background = bg;
            },
          });
        }
        coreRef.current = core;
        await core.init(effectiveUrl);
      } catch (err) {
        if (cancelled) return;
        setCoreError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      try { core?.destroy(); } catch { /* ignore */ }
      coreRef.current = null;
      if (blobUrlToRevoke) {
        try { URL.revokeObjectURL(blobUrlToRevoke); } catch { /* ignore */ }
      }
    };
    // Retrigger bootstrap when the remote URL, format, bookId, or
    // coreEpoch (manual retry) changes. Theme/state updates flow
    // through core.dispatch() without re-firing this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteUrl, bookId, format, coreEpoch]);

  // Replay theme whenever it changes and the core is live. Also
  // fires the first time the core reports ready, picking up the
  // hydrated prefs from the initial load.
  useEffect(() => {
    if (!coreReady || !coreRef.current) return;
    coreRef.current.dispatch({ type: "setTheme", payload: { ...theme } });
  }, [theme, coreReady]);

  // Replay saved highlights + notes as foliate annotations once BOTH
  // the core is ready AND the DB load has finished. Gated by the
  // `replayedAnnotationsRef` so it fires exactly once per book open.
  //
  // The deps list includes `highlights` and `notes` on purpose: if
  // coreReady flips true before the DB load resolves, this effect
  // runs once (bails on hasLoadedSavedRef), then re-runs when
  // setHighlights/setNotes fire and does the actual replay. Without
  // that re-run, a warm-foliate fast boot could beat IDB and the
  // replay would silently drop. Mirrors the native reader's
  // approach of running replay inside the `ready` message handler,
  // but via React's state model instead of closure snapshots.
  //
  // Bookmarks are not annotations (they're just position markers in
  // the TOC drawer) so they don't participate here.
  useEffect(() => {
    if (!coreReady || !coreRef.current) return;
    if (!hasLoadedSavedRef.current) return;
    if (replayedAnnotationsRef.current) return;
    replayedAnnotationsRef.current = true;

    for (const h of highlights) {
      coreRef.current.dispatch({
        type: "addHighlight",
        payload: { cfi: h.cfiRange, color: h.color },
      });
    }

    // Multiple notes on the same passage share one marker — dedupe
    // by cfi to avoid double-drawing. Handwritten wins over typed
    // because the indigo underline is more salient than the amber
    // squiggle, and users are more likely to care about a drawing
    // existing on a passage. Mirrors the native replay logic.
    const seenNoteCfis = new Map<string, "typed" | "handwritten">();
    for (const n of notes) {
      const cfi = n.position.cfi;
      if (!cfi) continue;
      const existing = seenNoteCfis.get(cfi);
      if (existing === "handwritten") continue;
      seenNoteCfis.set(cfi, n.noteType);
    }
    for (const [cfi, noteType] of seenNoteCfis) {
      coreRef.current.dispatch({
        type: "addNote",
        payload: { cfi, noteType },
      });
    }
  }, [coreReady, highlights, notes]);

  // NOTE: initial position restore is handled by applySavedRestore
  // above, triggered either from the `ready` event or (if the DB load
  // hasn't finished yet) from the DB-load effect via
  // pendingReadyRestoreRef. Keeping it out of a useEffect avoids
  // racing with the very first `progressUpdated` that setState would
  // have clobbered savedPositionRef's source otherwise.

  // Sync the browser document title to the current book title.
  // Keeps the browser history dropdown and tab label useful when
  // multiple books are open in different tabs.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.title;
    if (book?.title) document.title = `${book.title} — Readr`;
    return () => { document.title = prev; };
  }, [book?.title]);

  // Keyboard shortcuts. Arrow/space advance, Esc closes overlays,
  // Home/End jump to start/end.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if (!coreRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      switch (e.key) {
        case "ArrowRight":
        case " ":
        case "PageDown":
          e.preventDefault();
          coreRef.current.dispatch({ type: "nextPage", payload: {} });
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          coreRef.current.dispatch({ type: "prevPage", payload: {} });
          break;
        case "Escape":
          e.preventDefault();
          if (showTocDrawer) setShowTocDrawer(false);
          else router.back();
          break;
        case "Home":
          e.preventDefault();
          coreRef.current.dispatch({ type: "goToLocation", payload: { fraction: 0 } });
          break;
        case "End":
          e.preventDefault();
          coreRef.current.dispatch({ type: "goToLocation", payload: { fraction: 1 } });
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showTocDrawer]);

  // Drag-scrub handlers for the progress bar. The pointerdown /
  // input / pointerup cycle mirrors how the native PanResponder
  // drives the scrubber — update local display state on every
  // input, only dispatch a goToLocation to the reader core on
  // pointerup, and keep isDraggingRef true throughout so
  // progressUpdated events get swallowed while the user is
  // actively seeking.
  function handleScrubStart() {
    isDraggingRef.current = true;
  }
  function handleScrubInput(next: number) {
    setScrubValue(next);
  }
  function handleScrubEnd(next: number) {
    isDraggingRef.current = false;
    setScrubValue(null);
    setProgress(next * 100);
    coreRef.current?.dispatch({ type: "goToLocation", payload: { fraction: next } });
  }

  // ── Bookmark handlers ───────────────────────────────────────────────

  const isBookmarked = useMemo(() => {
    if (!currentPosition) return false;
    return bookmarks.some(
      (b) => Math.abs(b.position.percentage - currentPosition.percentage) < 1,
    );
  }, [bookmarks, currentPosition]);

  async function handleToggleBookmark() {
    if (!bookId || !currentPosition) return;
    const existing = bookmarks.find(
      (b) => Math.abs(b.position.percentage - currentPosition.percentage) < 1,
    );
    if (existing) {
      await deleteBookmark(existing.id);
      setBookmarks((prev) => prev.filter((b) => b.id !== existing.id));
      return;
    }
    try {
      const bm = await createBookmark(bookId, currentPosition);
      setBookmarks((prev) => [bm, ...prev]);
    } catch {
      Alert.alert("Error", "Failed to save bookmark");
    }
  }

  async function handleDeleteBookmark(id: string) {
    try {
      await deleteBookmark(id);
      setBookmarks((prev) => prev.filter((b) => b.id !== id));
    } catch {
      Alert.alert("Error", "Failed to delete bookmark");
    }
  }

  function handleGoToBookmark(bm: Bookmark) {
    // Prefer the most precise locator the current core actually
    // knows how to resolve:
    //   - EPUB (reader-core): cfi → fraction. The EPUB goToLocation
    //     handler only accepts cfi + fraction; dispatching `page`
    //     here is a silent no-op.
    //   - PDF (pdf-core): cfi → page → fraction. PDF bookmarks
    //     synced from the native app set position.page but leave
    //     cfi null, and pdf-core's scrollToPage is exact while
    //     fraction is an approximation.
    const core = coreRef.current;
    if (!core) return;
    if (bm.position.cfi) {
      core.dispatch({ type: "goToLocation", payload: { cfi: bm.position.cfi } });
    } else if (format === "pdf" && bm.position.page != null) {
      core.dispatch({ type: "goToLocation", payload: { page: bm.position.page } });
    } else {
      core.dispatch({
        type: "goToLocation",
        payload: { fraction: bm.position.percentage / 100 },
      });
    }
    setShowTocDrawer(false);
  }

  async function handleDeleteHighlight(hid: string) {
    const hl = highlights.find((h) => h.id === hid);
    try {
      await deleteHighlight(hid);
      setHighlights((prev) => prev.filter((h) => h.id !== hid));
      if (hl?.cfiRange) {
        coreRef.current?.dispatch({
          type: "removeHighlight",
          payload: { cfi: hl.cfiRange },
        });
      }
    } catch {
      Alert.alert("Error", "Failed to delete highlight");
    }
  }

  function handleJumpToHighlight(h: Highlight) {
    coreRef.current?.dispatch({
      type: "goToLocation",
      payload: { cfi: h.cfiRange },
    });
    setShowTocDrawer(false);
  }

  function handleDeleteNote(id: string) {
    Alert.alert("Delete note", "This note will be removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteNote(id);
            setNotes((prev) => prev.filter((n) => n.id !== id));
          } catch {
            Alert.alert("Error", "Failed to delete note");
          }
        },
      },
    ]);
  }

  function handleJumpToNote(n: Note) {
    // Prefer CFI for in-note-page jumps, fall back to fraction so
    // notes with no CFI (older rows from the web reader before
    // selectionChanged landed) still navigate somewhere useful
    // instead of silently no-op'ing. Mirrors native.
    if (n.position.cfi) {
      coreRef.current?.dispatch({
        type: "goToLocation",
        payload: { cfi: n.position.cfi },
      });
    } else {
      coreRef.current?.dispatch({
        type: "goToLocation",
        payload: { fraction: n.position.percentage / 100 },
      });
    }
    setShowTocDrawer(false);
  }

  function handleGoToChapter(href: string) {
    coreRef.current?.dispatch({ type: "goToChapter", payload: { href } });
  }

  function handleThemeChange(next: ReaderTheme) {
    setTheme(next);
    saveReaderPrefs({ theme: next });
  }

  // ── Context menu handlers ──────────────────────────────────────────

  async function handleHighlightFromMenu(color: HighlightColor) {
    if (!bookId || !selectionCfi) {
      setContextMenuVisible(false);
      return;
    }
    try {
      const chapterLabel =
        toc.find((t) => t.href === currentChapterHref)?.label ?? null;
      const hl = await createHighlight(
        bookId,
        selectionCfi,
        color,
        selectedText,
        chapterLabel,
        currentPosition?.percentage ?? null,
      );
      setHighlights((prev) => [hl, ...prev]);
      coreRef.current?.dispatch({
        type: "addHighlight",
        payload: { cfi: selectionCfi, color },
      });
    } catch {
      Alert.alert("Error", "Failed to save highlight");
    }
    setContextMenuVisible(false);
    window.getSelection()?.removeAllRanges();
  }

  function handleCopyFromMenu() {
    if (selectedText) {
      try {
        void navigator.clipboard?.writeText(selectedText).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    setContextMenuVisible(false);
    window.getSelection()?.removeAllRanges();
  }

  function handleLookupFromMenu(url: string) {
    setContextMenuVisible(false);
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      /* ignore */
    }
  }

  const lookupProviders = useMemo(
    () =>
      DEFAULT_LOOKUP_PROVIDERS.map((p) => ({
        name: p.name,
        icon: p.icon ?? "🔍",
        urlTemplate: p.urlTemplate,
      })),
    [],
  );

  // ── Render ──────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View style={styles.center}>
        <LoadingIndicator size="large" />
      </View>
    );
  }

  if (error || !book) {
    return (
      <ErrorFallback
        title={error ? "Couldn't load book" : "Book not found"}
        message={error?.message}
        onRetry={() => refetch()}
      />
    );
  }

  if (coreError) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <ErrorFallback
          title="Reader failed"
          message={coreError}
          retryLabel="Retry"
          onRetry={() => {
            setCoreError(null);
            setCoreReady(false);
            hasRestoredRef.current = false;
            pendingReadyRestoreRef.current = false;
            // Bump the epoch so the bootstrap effect actually
            // re-runs. Clearing coreError + coreReady alone would
            // only re-render into the loading branch without
            // re-creating the core.
            setCoreEpoch((e) => e + 1);
          }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* Reader surface — a plain host div that foliate mounts into.
          react-native-web renders <View> as a div so a nested <div>
          ref works for the DOM surface without breaking layout. */}
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          background: theme.bg,
        }}
      />

      {controlsVisible ? (
        <>
          <View
            style={[
              styles.header,
              { backgroundColor: theme.bg, paddingTop: insets.top + 8 },
            ]}
          >
            <Pressable
              onPress={() => router.back()}
              style={styles.headerButton}
              accessibilityLabel="Back to library"
            >
              <ArrowLeft size={20} color={theme.fg} />
            </Pressable>
            <Pressable
              onPress={() => setShowTocDrawer(true)}
              style={styles.headerButton}
              accessibilityLabel="Table of contents"
            >
              <BookOpen size={20} color={theme.fg} />
            </Pressable>
            <Text
              style={[styles.headerTitle, { color: theme.fg }]}
              numberOfLines={1}
            >
              {book.title ?? "Reading"}
            </Text>
            <Pressable
              onPress={handleToggleBookmark}
              style={styles.headerButton}
              accessibilityLabel={isBookmarked ? "Remove bookmark" : "Add bookmark"}
            >
              <BookmarkIcon
                size={20}
                color={theme.fg}
                fill={isBookmarked ? theme.fg : "none"}
              />
            </Pressable>
            <Pressable
              onPress={() =>
                handleThemeChange({
                  ...theme,
                  bg: theme.bg === "#ffffff" ? "#1a1a2e" : "#ffffff",
                  fg: theme.bg === "#ffffff" ? "#e0e0e0" : "#111111",
                })
              }
              style={styles.headerButton}
              accessibilityLabel="Toggle theme"
            >
              <Settings size={20} color={theme.fg} />
            </Pressable>
          </View>

          <View
            style={[
              styles.progressBar,
              { backgroundColor: theme.bg, paddingBottom: Math.max(insets.bottom, 8) },
            ]}
          >
            <Text style={[styles.progressText, { color: theme.fg }]}>
              {currentPage != null && totalPages != null
                ? `${currentPage} / ${totalPages}`
                : `${Math.round((scrubValue ?? progress / 100) * 100)}%`}
            </Text>
            {/* Raw range input driven by pointer lifecycle events so
                we only commit the seek on release — intermediate
                input events update scrubValue locally without firing
                goToLocation. Without this, every drag tick spammed
                foliate with reflows and the thumb flickered. */}
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round((scrubValue ?? progress / 100) * 1000)}
              onPointerDown={handleScrubStart}
              onPointerUp={(e) =>
                handleScrubEnd(Number((e.target as HTMLInputElement).value) / 1000)
              }
              onPointerCancel={(e) =>
                handleScrubEnd(Number((e.target as HTMLInputElement).value) / 1000)
              }
              onKeyDown={handleScrubStart}
              onKeyUp={(e) =>
                handleScrubEnd(Number((e.target as HTMLInputElement).value) / 1000)
              }
              onChange={(e) =>
                handleScrubInput(Number(e.target.value) / 1000)
              }
              style={{
                flex: 1,
                marginLeft: 12,
                marginRight: 12,
                accentColor: theme.fg,
              }}
            />
          </View>
        </>
      ) : null}

      <ContextMenu
        visible={contextMenuVisible}
        selectedText={selectedText}
        anchorRect={selectionRect}
        onClose={() => {
          setContextMenuVisible(false);
          window.getSelection()?.removeAllRanges();
        }}
        onHighlight={handleHighlightFromMenu}
        onNote={() => {
          // Typed/handwritten note UIs aren't wired on web yet.
          setContextMenuVisible(false);
        }}
        onDraw={() => {
          setContextMenuVisible(false);
        }}
        onCopy={handleCopyFromMenu}
        onDefine={() => {
          // No dictionary sheet on web yet — send the user to the
          // first lookup provider instead.
          const p = lookupProviders[0];
          if (p) {
            const url = p.urlTemplate.replace(
              "{{query}}",
              encodeURIComponent(selectedText),
            );
            handleLookupFromMenu(url);
            return;
          }
          setContextMenuVisible(false);
        }}
        onLookup={handleLookupFromMenu}
        lookupProviders={lookupProviders}
      />

      <TocDrawer
        visible={showTocDrawer}
        onClose={() => setShowTocDrawer(false)}
        toc={toc}
        bookmarks={bookmarks}
        notes={notes}
        highlights={highlights}
        currentChapterHref={currentChapterHref}
        onGoToChapter={handleGoToChapter}
        onGoToPage={() => setShowTocDrawer(false)}
        onJumpToBookmark={handleGoToBookmark}
        onDeleteBookmark={handleDeleteBookmark}
        onJumpToNote={handleJumpToNote}
        onDeleteNote={handleDeleteNote}
        onJumpToHighlight={handleJumpToHighlight}
        onDeleteHighlight={handleDeleteHighlight}
        theme={{ bg: theme.bg, fg: theme.fg }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: "relative",
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  header: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    zIndex: 10,
  },
  headerButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: "600",
    textAlign: "center",
  },
  progressBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    zIndex: 10,
  },
  progressText: {
    fontSize: fontSize.xs,
    fontVariant: ["tabular-nums"],
    minWidth: 60,
  },
});
