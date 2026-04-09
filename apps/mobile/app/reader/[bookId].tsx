import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { View, Text, ActivityIndicator, StyleSheet, Pressable, FlatList, Alert } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BookPosition, Bookmark, HighlightColor } from "@readr/shared";
import { getBook } from "../../lib/api";
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
  // null = honor the system setting; we restore the device's brightness
  // on unmount either way.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { status } = await Brightness.requestPermissionsAsync();
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

  // When the book is downloaded locally, we avoid all the URL-scheme
  // pain (data: / file:// / null-origin / CORS) by injecting the book
  // bytes as a base64 string on window.__READR_BOOK__ via the WebView's
  // injectedJavaScriptBeforeContentLoaded prop. The reader HTML's
  // init() checks for that global first and uses it instead of
  // fetching BOOK_URL.
  const [bookBase64, setBookBase64] = useState<string | null>(null);
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    (async () => {
      const downloaded = await getDownloadedBook(bookId);
      if (!downloaded) {
        setBookBase64(null);
        return;
      }
      const FileSystem = await import("expo-file-system/legacy");
      const b64 = await FileSystem.readAsStringAsync(downloaded.localPath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (!cancelled) setBookBase64(b64);
    })();
    return () => {
      cancelled = true;
    };
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
              sendToWebView("nextPage", {});
              setTimeout(requestPageText, 250);
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
    const newHighlight = await createHighlight(
      bookId,
      selectionCfi,
      color,
      selectedText,
    );
    setHighlights((prev) => [newHighlight, ...prev]);
    sendToWebView("addHighlight", { cfi: selectionCfi, color });
    setContextMenuVisible(false);
  }

  async function handleBookmarkFromMenu() {
    if (!bookId || !currentPosition) return;
    const label = selectedText.slice(0, 60) || undefined;
    const bm = await createBookmark(bookId, currentPosition, label);
    setBookmarks((prev) => [bm, ...prev]);
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
    const n = await createNote(bookId, currentPosition, "typed", text);
    setNotes((prev) => [n, ...prev]);
    setShowTypedNote(false);
  }

  async function handleSaveHandwriting(strokes: import("@readr/shared").Stroke[], penConfig: import("@readr/shared").PenConfig) {
    if (!bookId || !currentPosition) return;
    const n = await createNote(bookId, currentPosition, "handwritten", undefined, strokes, penConfig);
    setNotes((prev) => [n, ...prev]);
    setShowHandwriting(false);
  }

  // ─── Bookmark handlers ────────────────────────────────────────────

  async function handleCreateBookmark() {
    if (!bookId || !currentPosition) return;
    const bm = await createBookmark(bookId, currentPosition);
    setBookmarks((prev) => [bm, ...prev]);
  }

  async function handleDeleteBookmark(bmId: string) {
    await deleteBookmark(bmId);
    setBookmarks((prev) => prev.filter((b) => b.id !== bmId));
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

  const format = book.format ?? "epub";
  // For downloaded books the presigned URL is unused; the reader HTML
  // picks up window.__READR_BOOK__ via the injected script.
  // For not-downloaded books, the HTML's fetch(BOOK_URL) still runs
  // against the server's presigned URL.
  const sourceUrl = book.downloadUrl ?? "";
  const readerHtml =
    format === "pdf" ? getPdfReaderHtml(sourceUrl) : getReaderHtml(sourceUrl);
  const injectedBookScript = bookBase64
    ? `window.__READR_BOOK_B64__ = ${JSON.stringify(bookBase64)}; window.__READR_BOOK_MIME__ = ${JSON.stringify(format === "pdf" ? "application/pdf" : "application/epub+zip")}; true;`
    : undefined;

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
        source={{ html: readerHtml }}
        injectedJavaScriptBeforeContentLoaded={injectedBookScript}
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
