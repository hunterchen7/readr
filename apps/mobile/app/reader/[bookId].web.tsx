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
  Note,
} from "@readr/shared";
import { BookOpen, Settings, Bookmark as BookmarkIcon, ArrowLeft } from "lucide-react-native";
import { getBook, logReadingSession } from "../../lib/api";
import {
  createReaderCore,
  type ReaderCoreHandle,
  type FoliateBook,
  type FoliateOverlayer,
} from "../../reader-core/reader-core";
import {
  upsertProgress,
  getProgress,
  getBookmarks,
  createBookmark,
  deleteBookmark,
  deleteHighlight,
  getHighlights,
  getNotes,
  deleteNote,
} from "../../lib/local-db";
import { loadReaderPrefs, saveReaderPrefs } from "../../lib/reader-prefs";
import {
  DEFAULT_THEME,
  type ReaderTheme,
} from "../../components/reader/ReaderControls";
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

  const containerRef = useRef<HTMLDivElement | null>(null);
  const coreRef = useRef<ReaderCoreHandle | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Guard initial-position restore so it only fires once per book open.
  const restoredRef = useRef(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => getBook(bookId!),
    enabled: !!bookId,
  });
  const book = data?.book;

  // Load persisted state on mount.
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
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
        setProgress(savedProgress.position.percentage);
        setCurrentPosition(savedProgress.position);
      }
      setBookmarks(savedBookmarks);
      setHighlights(savedHighlights);
      setNotes(savedNotes);
      if (savedPrefs?.theme) setTheme({ ...DEFAULT_THEME, ...savedPrefs.theme });
    })();
    return () => { cancelled = true; };
  }, [bookId]);

  // Reading session tracking — log duration when the reader unmounts.
  const sessionStartRef = useRef<{ at: number; pct: number }>({
    at: Date.now(),
    pct: 0,
  });
  const latestPctRef = useRef(0);
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
          break;
        case "tocLoaded":
          setToc(payload.chapters ?? []);
          break;
        case "progressUpdated": {
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
          if (bookId) void upsertProgress(bookId, position);
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
        // selectionChanged / showAnnotation / pageText / searchResults
        // aren't wired up yet — deferred to follow-ups.
        default:
          break;
      }
    },
    [bookId],
  );

  // Mount the reader core + foliate once the book metadata and the
  // container div are both ready.
  const bookUrl = book?.downloadUrl;
  useEffect(() => {
    if (!bookUrl || !containerRef.current) return;
    let cancelled = false;
    setCoreError(null);
    setCoreReady(false);
    restoredRef.current = false;

    const container = containerRef.current;
    let core: ReaderCoreHandle | null = null;

    (async () => {
      try {
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
        coreRef.current = core;
        await core.init(bookUrl);
      } catch (err) {
        if (cancelled) return;
        setCoreError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      try { core?.destroy(); } catch { /* ignore */ }
      coreRef.current = null;
    };
    // bookUrl is the only value that should retrigger the bootstrap.
    // Theme/state changes flow through core.dispatch() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookUrl]);

  // Replay theme whenever it changes and the core is live. Also
  // fires the first time the core reports ready, picking up the
  // hydrated prefs from the initial load.
  useEffect(() => {
    if (!coreReady || !coreRef.current) return;
    coreRef.current.dispatch({ type: "setTheme", payload: { ...theme } });
  }, [theme, coreReady]);

  // Replay saved highlights as foliate annotations once the core
  // is ready. Bookmarks don't map to annotations (CFI + label).
  useEffect(() => {
    if (!coreReady || !coreRef.current) return;
    for (const h of highlights) {
      coreRef.current.dispatch({
        type: "addHighlight",
        payload: { cfi: h.cfiRange, color: h.color },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coreReady]);

  // Restore saved position once after the reader reports ready.
  useEffect(() => {
    if (!coreReady || !coreRef.current) return;
    if (restoredRef.current) return;
    const cfi = currentPosition?.cfi;
    if (cfi) {
      coreRef.current.dispatch({ type: "goToLocation", payload: { cfi } });
      restoredRef.current = true;
    }
  }, [coreReady, currentPosition]);

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

  function handleScrub(next: number) {
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
    if (bm.position.cfi) {
      coreRef.current?.dispatch({
        type: "goToLocation",
        payload: { cfi: bm.position.cfi },
      });
    } else {
      coreRef.current?.dispatch({
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
    if (n.position.cfi) {
      coreRef.current?.dispatch({
        type: "goToLocation",
        payload: { cfi: n.position.cfi },
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
            restoredRef.current = false;
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
                : `${Math.round(progress)}%`}
            </Text>
            {/* Raw range input is the simplest cross-browser seek
                control. Polish deferred to the UX pass. */}
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round((progress / 100) * 1000)}
              onChange={(e) => handleScrub(Number(e.target.value) / 1000)}
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
