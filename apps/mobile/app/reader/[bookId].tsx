import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { View, Text, ActivityIndicator, StyleSheet, Pressable, Alert } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BookPosition, Bookmark, HighlightColor } from "@readr/shared";
import { BookOpen, Settings, Bookmark as BookmarkIcon } from "lucide-react-native";
import { getBook, logReadingSession } from "../../lib/api";
import { getReaderHtml } from "../../components/reader/epub-html";
import { getPdfReaderHtml } from "../../components/reader/pdf-html";
import {
  ReaderControls,
  DEFAULT_THEME,
  EINK_THEME,
  type ReaderTheme,
} from "../../components/reader/ReaderControls";
import { useDisplay } from "../../contexts/DisplayContext";
import { ContextMenu } from "../../components/reader/ContextMenu";
import { NotesPanel } from "../../components/reader/NotesPanel";
import { GotoDialog } from "../../components/reader/GotoDialog";
import { TocDrawer } from "../../components/reader/TocDrawer";
import { SettingsDropdown } from "../../components/reader/SettingsDropdown";
import { TtsBar } from "../../components/reader/TtsBar";
import { useTtsStore } from "../../lib/tts-store";
import { TypedNoteEditor } from "../../components/notes/TypedNoteEditor";
import { HandwritingCanvas } from "../../components/notes/HandwritingCanvas";
import {
  upsertProgress,
  getProgress,
  getBookmarks,
  createBookmark,
  deleteBookmark,
  createHighlight,
  getHighlights,
  createNote,
  getNotes,
} from "../../lib/local-db";
import type { Highlight, Note } from "@readr/shared";
import { loadReaderPrefs, saveReaderPrefs } from "../../lib/reader-prefs";
import { getDownloadedBook } from "../../lib/book-cache";
import * as Brightness from "expo-brightness";
import { DEFAULT_LOOKUP_PROVIDERS } from "@readr/shared";
import * as Linking from "expo-linking";

interface TocItem {
  label: string;
  href: string;
  depth: number;
}

export default function ReaderScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const webviewRef = useRef<WebView>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const display = useDisplay();
  const insets = useSafeAreaInsets();
  const [controlsVisible, setControlsVisible] = useState(false);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [showTocDrawer, setShowTocDrawer] = useState(false);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [theme, setTheme] = useState<ReaderTheme>(() =>
    display.isEink ? EINK_THEME : DEFAULT_THEME,
  );
  // Merged theme sent to the WebView — the base theme plus an isEink flag
  // so the injected EPUB stylesheet can force high-contrast black text.
  const themeForWebView = useMemo(
    () => ({ ...theme, isEink: display.isEink }) as Record<string, unknown>,
    [theme, display.isEink],
  );
  const [toc, setToc] = useState<TocItem[]>([]);
  const [progress, setProgress] = useState(0);
  const [currentPosition, setCurrentPosition] = useState<BookPosition | null>(null);

  // Context menu state
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [selectionCfi, setSelectionCfi] = useState("");

  // Notes state
  const [showTypedNote, setShowTypedNote] = useState(false);
  const [showDrawing, setShowDrawing] = useState(false);

  // Bookmarks + highlights + notes state
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [showNotesPanel, setShowNotesPanel] = useState(false);

  // In-book search state
  const [searchResults, setSearchResults] = useState<
    { cfi: string; excerpt: string; section?: string | null }[]
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Apply the theme's brightness override while the reader is mounted.
  // Only uses brightness if permission is already granted — never requests
  // on reader open (requestPermissionsAsync navigates to system settings
  // on Android, breaking the reader flow).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { status } = await Brightness.getPermissionsAsync();
        if (!active || status !== "granted") return;
        if (theme.brightness != null) {
          await Brightness.setBrightnessAsync(theme.brightness);
        } else {
          await Brightness.restoreSystemBrightnessAsync();
        }
      } catch {
        // No brightness permission (or no module on this platform) — silent.
      }
    })();
    return () => {
      active = false;
      Brightness.restoreSystemBrightnessAsync().catch(() => {});
    };
  }, [theme.brightness]);

  // Page count — foliate-js reports {current, total} on every relocate.
  // Null until the first page renders; stays null if the book has no
  // estimable page count (e.g. very short EPUBs).
  const [currentPage, setCurrentPage] = useState<number | null>(null);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [pageInSection, setPageInSection] = useState<number | null>(null);
  const [pagesInSection, setPagesInSection] = useState<number | null>(null);
  const [showGotoDialog, setShowGotoDialog] = useState(false);

  // Reading session tracking — we log a session to the server whenever
  // the user leaves the reader, so the stats screen has data to show.
  // The refs never trigger re-renders; only the unmount effect reads them.
  const sessionStartRef = useRef<{ at: number; pct: number }>({
    at: Date.now(),
    pct: 0,
  });
  const latestPctRef = useRef(0);
  useEffect(() => {
    sessionStartRef.current = { at: Date.now(), pct: progress };
    latestPctRef.current = progress;
  }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps
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
      }).catch(() => {
        // Non-fatal — we'd rather drop a session than crash on exit.
      });
    };
  }, [bookId]);

  // TTS — state lives in the zustand store; handlers below (after
  // sendToWebView is declared).
  const ttsState = useTtsStore((s) => s.state);
  const ttsSpeak = useTtsStore((s) => s.speak);
  const ttsStop = useTtsStore((s) => s.stop);

  const { data, isLoading, error } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => getBook(bookId!),
    enabled: !!bookId,
  });


  const book = data?.book;

  // Resolve the local file path for downloaded books.
  const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    (async () => {
      const downloaded = await getDownloadedBook(bookId);
      if (!cancelled) setLocalFileUrl(downloaded?.localPath ?? null);
    })();
    return () => { cancelled = true; };
  }, [bookId]);

  const _format = data?.book?.format ?? "epub";
  const _sourceUrl = localFileUrl ?? data?.book?.downloadUrl ?? "";
  const _readerHtml = _sourceUrl
    ? (_format === "pdf" ? getPdfReaderHtml(_sourceUrl) : getReaderHtml(_sourceUrl, theme.bg, theme.fg))
    : "";

  // Load saved progress, bookmarks, highlights, notes, and reader prefs on mount
  useEffect(() => {
    if (!bookId) return;
    async function load() {
      const [
        savedProgress,
        savedBookmarks,
        savedHighlights,
        savedNotes,
        savedPrefs,
      ] = await Promise.all([
        getProgress(bookId!),
        getBookmarks(bookId!),
        getHighlights(bookId!),
        getNotes(bookId!),
        loadReaderPrefs(),
      ]);
      if (savedProgress) {
        setProgress(Math.round(savedProgress.position.percentage));
        setCurrentPosition(savedProgress.position);
      }
      setBookmarks(savedBookmarks);
      setHighlights(savedHighlights);
      setNotes(savedNotes);
      if (savedPrefs?.theme) {
        setTheme(savedPrefs.theme);
      }
    }
    load();
  }, [bookId]);

  const sendToWebView = useCallback(
    (type: string, payload: Record<string, unknown>) => {
      webviewRef.current?.postMessage(JSON.stringify({ type, payload }));
    },
    [],
  );

  function handleThemeChange(newTheme: ReaderTheme) {
    setTheme(newTheme);
    sendToWebView("setTheme", { ...newTheme, isEink: display.isEink });
    // Fire-and-forget persistence — failure is non-fatal.
    saveReaderPrefs({ theme: newTheme });
  }

  function handleGoToChapter(href: string) {
    sendToWebView("goToChapter", { href });
  }

  function handleSearch(query: string) {
    if (!query.trim()) {
      setSearchResults([]);
      sendToWebView("clearSearch", {});
      return;
    }
    setSearchLoading(true);
    setSearchResults([]);
    sendToWebView("search", { query });
  }

  function handleJumpToResult(cfi: string) {
    sendToWebView("goToLocation", { cfi });
  }

  // TTS flow: tap 🔊 → request text → speak → on done, advance a
  // page → request next page text → speak → ...
  function requestPageText() {
    sendToWebView("getPageText", {});
  }
  function handleStartTts() {
    requestPageText();
  }
  function handleStopTts() {
    ttsStop();
  }
  function handleTtsAdvance() {
    sendToWebView("nextPage", {});
  }

  function handleMessage(event: { nativeEvent: { data: string } }) {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      switch (msg.type) {
        case "debug":
          console.log("[WebView]", msg.payload?.msg);
          break;
        case "error":
          console.error("[WebView Error]", msg.payload?.message);
          break;
        case "ready":
          sendToWebView("setTheme", themeForWebView);
          // Replay saved highlights so they're visible when reopening.
          // The WebView ignores any it's already drawn.
          for (const h of highlights) {
            sendToWebView("addHighlight", {
              cfi: h.cfiRange,
              color: h.color,
            });
          }
          // Restore saved position
          if (currentPosition?.cfi) {
            sendToWebView("goToLocation", { cfi: currentPosition.cfi });
          }
          break;
        case "progressUpdated": {
          const pct = msg.payload.percentage ?? 0;
          setProgress(pct);
          const position: BookPosition = {
            percentage: pct,
            cfi: msg.payload.cfi,
            chapter: msg.payload.chapter,
            page: msg.payload.currentPage ?? msg.payload.page,
          };
          setCurrentPosition(position);
          const rawPage = msg.payload.currentPage;
          const rawTotal = msg.payload.totalPages;
          if (typeof rawPage === "number" && typeof rawTotal === "number" && rawTotal > 0) {
            setCurrentPage(rawPage);
            setTotalPages(rawTotal);
          }
          if (typeof msg.payload.pageInSection === "number") setPageInSection(msg.payload.pageInSection);
          if (typeof msg.payload.pagesInSection === "number") setPagesInSection(msg.payload.pagesInSection);
          if (bookId) {
            upsertProgress(bookId, position);
          }
          break;
        }
        case "tocLoaded":
          setToc(msg.payload.chapters ?? []);
          break;
        case "tapCenter":
          setControlsVisible((v) => {
            if (v && controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
            return !v;
          });
          break;
        case "selectionChanged":
          if (msg.payload.text) {
            setSelectedText(msg.payload.text);
            setSelectionCfi(msg.payload.cfi ?? "");
            setContextMenuVisible(true);
          }
          break;
        case "searchResults":
          setSearchResults(msg.payload.results ?? []);
          setSearchLoading(false);
          break;
        case "pageText": {
          // TTS: speak what we got back from the WebView. When the
          // speech runs dry, auto-advance a page and request the
          // next chunk of text — gives a "read the whole book"
          // experience with no extra UI state.
          const text = msg.payload.text ?? "";
          if (!text) {
            ttsStop();
            break;
          }
          ttsSpeak(text, {
            onDone: () => {
              if (!mountedRef.current) return;
              sendToWebView("nextPage", {});
              setTimeout(() => { if (mountedRef.current) requestPageText(); }, 250);
            },
          });
          break;
        }
      }
    } catch {
      // Ignore non-JSON messages
    }
  }

  // ─── Context menu handlers ─────────────────────────────────────────

  async function handleHighlight(color: HighlightColor) {
    if (!bookId || !selectionCfi) return;
    try {
      const newHighlight = await createHighlight(
        bookId,
        selectionCfi,
        color,
        selectedText,
      );
      setHighlights((prev) => [newHighlight, ...prev]);
      sendToWebView("addHighlight", { cfi: selectionCfi, color });
    } catch {
      Alert.alert("Error", "Failed to save highlight");
    }
    setContextMenuVisible(false);
  }

  async function handleBookmarkFromMenu() {
    if (!bookId || !currentPosition) return;
    try {
      const label = selectedText.slice(0, 60) || undefined;
      const bm = await createBookmark(bookId, currentPosition, label);
      setBookmarks((prev) => [bm, ...prev]);
    } catch {
      Alert.alert("Error", "Failed to save bookmark");
    }
    setContextMenuVisible(false);
  }

  function handleNoteFromMenu() {
    setContextMenuVisible(false);
    setShowTypedNote(true);
  }

  function handleDrawFromMenu() {
    setContextMenuVisible(false);
    setShowDrawing(true);
  }

  function handleCopy() {
    if (selectedText) {
      // Use WebView to copy to clipboard
      sendToWebView("copyToClipboard", { text: selectedText });
    }
    setContextMenuVisible(false);
  }

  function handleLookup(url: string) {
    setContextMenuVisible(false);
    Linking.openURL(url);
  }

  // ─── Note handlers ─────────────────────────────────────────────────

  async function handleSaveTypedNote(text: string) {
    if (!bookId || !currentPosition) return;
    try {
      const n = await createNote(bookId, currentPosition, "typed", text);
      setNotes((prev) => [n, ...prev]);
      setShowTypedNote(false);
    } catch {
      Alert.alert("Error", "Failed to save note");
    }
  }


  // ─── Bookmark handlers ────────────────────────────────────────────

  async function handleCreateBookmark() {
    if (!bookId || !currentPosition) return;
    try {
      const bm = await createBookmark(bookId, currentPosition);
      setBookmarks((prev) => [bm, ...prev]);
    } catch {
      Alert.alert("Error", "Failed to save bookmark");
    }
  }

  async function handleDeleteBookmark(bmId: string) {
    try {
      await deleteBookmark(bmId);
      setBookmarks((prev) => prev.filter((b) => b.id !== bmId));
    } catch {
      Alert.alert("Error", "Failed to delete bookmark");
    }
  }

  function handleGoToBookmark(bm: Bookmark) {
    if (bm.position.cfi) {
      sendToWebView("goToLocation", { cfi: bm.position.cfi });
    } else if (bm.position.page != null) {
      sendToWebView("goToLocation", { page: bm.position.page });
    }
    setShowTocDrawer(false);
  }

  // ─── Bookmark toggle ───────────────────────────────────────────────

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
      await handleDeleteBookmark(existing.id);
    } else {
      await handleCreateBookmark();
    }
  }

  // ─── Render ────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error || !book) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error?.message ?? "Book not found"}</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.link}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const format = book?.format ?? "epub";

  const lookupProviders = DEFAULT_LOOKUP_PROVIDERS.map((p) => ({
    name: p.name,
    icon: p.icon ?? "🔍",
    urlTemplate: p.urlTemplate,
  }));

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <WebView
        ref={webviewRef}
        style={[styles.webview, { backgroundColor: theme.bg }]}
        originWhitelist={["*"]}
        source={{ html: _readerHtml || `<html style="background:${theme.bg}"><body style="background:${theme.bg}"><p style='text-align:center;padding:48px;color:${theme.fg}'>Loading...</p></body></html>`, baseUrl: localFileUrl ? localFileUrl.replace(/\/[^/]+$/, "/") : "" }}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        menuItems={[]}
      />

      {controlsVisible ? (
        <>
          <View
            style={[
              styles.header,
              styles.headerOverlay,
              { backgroundColor: theme.bg, paddingTop: insets.top + 8 },
            ]}
          >
            <Pressable onPress={() => setShowTocDrawer(true)} style={styles.headerButton} accessibilityLabel="Table of contents">
              <BookOpen size={20} color={theme.fg} />
            </Pressable>
            <Text style={[styles.headerTitle, { color: theme.fg }]} numberOfLines={1}>
              {book.title ?? "Reading"}
            </Text>
            <Pressable onPress={handleToggleBookmark} style={styles.headerButton} accessibilityLabel={isBookmarked ? "Remove bookmark" : "Add bookmark"}>
              <BookmarkIcon size={20} color={theme.fg} fill={isBookmarked ? theme.fg : "none"} />
            </Pressable>
            <Pressable onPress={() => setShowSettingsDropdown(true)} style={styles.headerButton} accessibilityLabel="Reader settings">
              <Settings size={20} color={theme.fg} />
            </Pressable>
          </View>

          <Pressable
            onPress={() => setShowGotoDialog(true)}
            style={[
              styles.progressOverlay,
              { backgroundColor: theme.bg, paddingBottom: Math.max(insets.bottom, 8) },
            ]}
          >
            {/* Scrubber track */}
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${progress}%` }]} />
              <View style={[styles.progressDot, { left: `${progress}%` }]} />
            </View>

            <Text style={[styles.progressLabel, { color: theme.fg }]} numberOfLines={1}>
              {currentPosition?.chapter ?? ""}
            </Text>
            <View style={styles.progressInfoRow}>
              <Text style={[styles.progressLabel, { color: theme.fg }]}>
                {pageInSection != null && pagesInSection != null && totalPages != null
                  ? `${pagesInSection - pageInSection}/${totalPages - (currentPage ?? 0)} left`
                  : ""}
              </Text>
              <Text style={[styles.progressLabel, { color: theme.fg }]}>
                {currentPage != null && totalPages != null && totalPages > 0
                  ? `p. ${currentPage}/${totalPages}  ·  ${progress}%`
                  : `${progress}%`}
              </Text>
            </View>
          </Pressable>
        </>
      ) : (
        /* Minimal progress bar always visible at bottom */
        <View style={[styles.miniProgress, { backgroundColor: theme.bg + "cc" }]}>
          <View style={[styles.miniProgressFill, { width: `${progress}%`, backgroundColor: theme.fg + "33" }]} />
        </View>
      )}

      <TocDrawer
        visible={showTocDrawer}
        onClose={() => setShowTocDrawer(false)}
        toc={toc}
        bookmarks={bookmarks}
        onGoToChapter={handleGoToChapter}
        onJumpToBookmark={handleGoToBookmark}
        onDeleteBookmark={(id) => handleDeleteBookmark(id)}
        theme={{ bg: theme.bg, fg: theme.fg }}
      />

      <SettingsDropdown
        visible={showSettingsDropdown}
        onClose={() => setShowSettingsDropdown(false)}
        theme={theme}
        onThemeChange={handleThemeChange}
      />

      <ContextMenu
        visible={contextMenuVisible}
        selectedText={selectedText}
        onClose={() => setContextMenuVisible(false)}
        onHighlight={handleHighlight}
        onBookmark={handleBookmarkFromMenu}
        onNote={handleNoteFromMenu}
        onDraw={handleDrawFromMenu}
        onCopy={handleCopy}
        onLookup={handleLookup}
        lookupProviders={lookupProviders}
      />

      <TypedNoteEditor
        visible={showTypedNote}
        onSave={handleSaveTypedNote}
        onCancel={() => setShowTypedNote(false)}
      />

      <HandwritingCanvas
        visible={showDrawing}
        onSave={async (strokes, penConfig) => {
          if (!bookId || !currentPosition) return;
          try {
            const n = await createNote(bookId, currentPosition, "handwritten", undefined, strokes, penConfig);
            setNotes((prev) => [n, ...prev]);
          } catch {}
          setShowDrawing(false);
        }}
        onCancel={() => setShowDrawing(false)}
      />

      <NotesPanel
        visible={showNotesPanel}
        bookTitle={book.title ?? "Untitled"}
        bookAuthor={book.author}
        notes={notes}
        highlights={highlights}
        bookmarks={bookmarks}
        onClose={() => setShowNotesPanel(false)}
        onJumpTo={(target) => {
          if ("cfi" in target && target.cfi) {
            sendToWebView("goToLocation", { cfi: target.cfi });
          } else if ("percentage" in target) {
            sendToWebView("goToLocation", { fraction: target.percentage / 100 });
          }
        }}
      />

      <GotoDialog
        visible={showGotoDialog}
        currentPage={currentPage}
        totalPages={totalPages}
        progressPct={progress}
        onClose={() => setShowGotoDialog(false)}
        onGoToPage={(page) => {
          if (totalPages && totalPages > 0) {
            sendToWebView("goToLocation", { fraction: page / totalPages });
          }
        }}
        onGoToFraction={(frac) => {
          sendToWebView("goToLocation", { fraction: frac });
        }}
      />

      <TtsBar
        onRequestPageText={requestPageText}
        onNextPage={handleTtsAdvance}
        onStop={handleStopTts}
      />

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  error: { color: "#dc2626", marginBottom: 12 },
  link: { color: "#111", fontWeight: "600" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  headerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  headerButton: { width: 44, height: 44, justifyContent: "center", alignItems: "center" },
  headerButtonText: { fontSize: 20 },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "500" },
  headerActions: { flexDirection: "row" },
  webview: { flex: 1 },
  progressOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  progressTrack: {
    height: 4,
    backgroundColor: "rgba(0,0,0,0.08)",
    borderRadius: 2,
    marginBottom: 8,
    position: "relative",
  },
  progressFill: {
    height: 4,
    backgroundColor: "rgba(0,0,0,0.25)",
    borderRadius: 2,
  },
  progressDot: {
    position: "absolute",
    top: -4,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.4)",
    marginLeft: -6,
  },
  progressChapter: {
    fontSize: 13,
    fontWeight: "500",
    opacity: 0.7,
    textAlign: "center",
    marginBottom: 4,
  },
  progressInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  progressLabel: { fontSize: 11, opacity: 0.5 },
  miniProgress: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    zIndex: 5,
  },
  miniProgressFill: {
    height: 3,
  },
});
