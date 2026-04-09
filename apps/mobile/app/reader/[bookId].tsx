import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { View, Text, ActivityIndicator, StyleSheet, Pressable, FlatList, Alert } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BookPosition, Bookmark, HighlightColor } from "@readr/shared";
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
  const [showControls, setShowControls] = useState(false);
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
  const [showHandwriting, setShowHandwriting] = useState(false);

  // Bookmarks + highlights + notes state
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
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

  // Write reader HTML to a temp file so WebView loads from file:// origin,
  // allowing fetch("file://...") for locally downloaded books.
  const [readerHtmlUri, setReaderHtmlUri] = useState<string | null>(null);
  const readerHtmlRef = useRef("");  // updated below, used by the effect
  useEffect(() => {
    if (!localFileUrl && !data?.book?.downloadUrl) return;
    let cancelled = false;
    (async () => {
      const html = readerHtmlRef.current;
      if (!html) return;
      const FileSystem = await import("expo-file-system/legacy");
      const path = FileSystem.cacheDirectory + "reader.html";
      await FileSystem.writeAsStringAsync(path, html);
      if (!cancelled) setReaderHtmlUri(path);
    })();
    return () => { cancelled = true; };
  }, [localFileUrl, data?.book?.downloadUrl]);

  const book = data?.book;

  // Resolve the local file path for downloaded books so the WebView
  // fetches from disk (file://) rather than the network.
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
          if (typeof msg.payload.currentPage === "number") {
            setCurrentPage(msg.payload.currentPage);
          }
          if (typeof msg.payload.totalPages === "number") {
            setTotalPages(msg.payload.totalPages);
          }
          if (bookId) {
            upsertProgress(bookId, position);
          }
          break;
        }
        case "tocLoaded":
          setToc(msg.payload.chapters ?? []);
          break;
        case "tapCenter":
          setShowControls(true);
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

  async function handleSaveHandwriting(strokes: import("@readr/shared").Stroke[], penConfig: import("@readr/shared").PenConfig) {
    if (!bookId || !currentPosition) return;
    try {
      const n = await createNote(bookId, currentPosition, "handwritten", undefined, strokes, penConfig);
      setNotes((prev) => [n, ...prev]);
      setShowHandwriting(false);
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
    setShowBookmarks(false);
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
  const sourceUrl = localFileUrl ?? book?.downloadUrl ?? "";
  const readerHtml =
    format === "pdf" ? getPdfReaderHtml(sourceUrl) : getReaderHtml(sourceUrl);
  readerHtmlRef.current = readerHtml;

  const lookupProviders = DEFAULT_LOOKUP_PROVIDERS.map((p) => ({
    name: p.name,
    icon: p.icon ?? "🔍",
    urlTemplate: p.urlTemplate,
  }));

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View
        style={[
          styles.header,
          { backgroundColor: theme.bg, paddingTop: insets.top + 8 },
        ]}
      >
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, { color: theme.fg }]}>←</Text>
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.fg }]} numberOfLines={1}>
          {book.title ?? "Reading"}
        </Text>
        <View style={styles.headerActions}>
          <Pressable onPress={handleCreateBookmark} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, { color: theme.fg }]}>🔖</Text>
          </Pressable>
          <Pressable onPress={() => setShowBookmarks(true)} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, { color: theme.fg }]}>☰</Text>
          </Pressable>
          <Pressable onPress={() => setShowNotesPanel(true)} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, { color: theme.fg }]}>📝</Text>
          </Pressable>
          <Pressable
            onPress={ttsState === "idle" ? handleStartTts : handleStopTts}
            style={styles.headerButton}
          >
            <Text style={[styles.headerButtonText, { color: theme.fg }]}>
              {ttsState === "idle" ? "🔊" : "🔇"}
            </Text>
          </Pressable>
          <Pressable onPress={() => setShowControls(true)} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, { color: theme.fg }]}>⚙</Text>
          </Pressable>
        </View>
      </View>

      <WebView
        ref={webviewRef}
        style={styles.webview}
        originWhitelist={["*"]}
        source={readerHtmlUri ? { uri: readerHtmlUri } : { html: "<p>Loading reader...</p>" }}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        mixedContentMode="always"
      />

      <Pressable
        onPress={() => setShowGotoDialog(true)}
        style={[
          styles.progressBar,
          {
            backgroundColor: theme.bg,
            paddingBottom: Math.max(insets.bottom, 4),
          },
        ]}
      >
        <View style={[styles.progressFill, { width: `${progress}%` }]} />
        <Text style={[styles.progressText, { color: theme.fg }]}>
          {currentPage != null && totalPages != null
            ? `${currentPage} / ${totalPages}  ·  ${progress}%`
            : `${progress}%`}
        </Text>
      </Pressable>

      <ReaderControls
        visible={showControls}
        theme={theme}
        toc={toc}
        progress={progress}
        onClose={() => setShowControls(false)}
        onThemeChange={handleThemeChange}
        onGoToChapter={handleGoToChapter}
        onSearch={handleSearch}
        searchResults={searchResults}
        searchLoading={searchLoading}
        onJumpToResult={handleJumpToResult}
      />

      <ContextMenu
        visible={contextMenuVisible}
        selectedText={selectedText}
        onClose={() => setContextMenuVisible(false)}
        onHighlight={handleHighlight}
        onBookmark={handleBookmarkFromMenu}
        onNote={handleNoteFromMenu}
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
        visible={showHandwriting}
        onSave={handleSaveHandwriting}
        onCancel={() => setShowHandwriting(false)}
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

      {/* Bookmarks panel */}
      {showBookmarks ? (
        <View
          style={[
            styles.bookmarksPanel,
            { top: insets.top + 52 },
          ]}
        >
          <View style={styles.bookmarksPanelHeader}>
            <Text style={styles.bookmarksPanelTitle}>
              Bookmarks ({bookmarks.length})
            </Text>
            <Pressable onPress={() => setShowBookmarks(false)}>
              <Text style={styles.bookmarksPanelClose}>✕</Text>
            </Pressable>
          </View>
          {bookmarks.length === 0 ? (
            <Text style={styles.bookmarksEmpty}>
              No bookmarks yet. Tap 🔖 to add one.
            </Text>
          ) : (
            <FlatList
              data={bookmarks}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.bookmarkRow}
                  onPress={() => handleGoToBookmark(item)}
                  onLongPress={() => {
                    Alert.alert("Delete Bookmark?", item.label ?? "This bookmark", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () => handleDeleteBookmark(item.id),
                      },
                    ]);
                  }}
                >
                  <Text style={styles.bookmarkLabel} numberOfLines={1}>
                    {item.label ?? `Page ${item.position.page ?? Math.round(item.position.percentage)}%`}
                  </Text>
                  <Text style={styles.bookmarkMeta}>
                    {Math.round(item.position.percentage)}%
                  </Text>
                </Pressable>
              )}
            />
          )}
        </View>
      ) : null}
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
    // Top padding is applied inline at the call site via insets.top + 8.
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  headerButton: { width: 44, height: 44, justifyContent: "center", alignItems: "center" },
  headerButtonText: { fontSize: 20 },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "500" },
  headerActions: { flexDirection: "row" },
  webview: { flex: 1 },
  progressBar: {
    height: 20,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e0e0e0",
  },
  progressFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  progressText: { fontSize: 11, opacity: 0.5 },
  bookmarksPanel: {
    position: "absolute",
    // top is computed inline from insets.top + header height at the
    // call site so it slides in below the header on notched devices.
    right: 8,
    width: 280,
    maxHeight: 400,
    backgroundColor: "#fff",
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    padding: 12,
  },
  bookmarksPanelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  bookmarksPanelTitle: { fontSize: 15, fontWeight: "600" },
  bookmarksPanelClose: { fontSize: 18, padding: 4, color: "#666" },
  bookmarksEmpty: { color: "#999", textAlign: "center", paddingVertical: 16, fontSize: 13 },
  bookmarkRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  bookmarkLabel: { flex: 1, fontSize: 14, marginRight: 8 },
  bookmarkMeta: { fontSize: 12, color: "#999" },
});
