import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { View, Text, StyleSheet, Pressable, Alert, PanResponder } from "react-native";
import { LoadingIndicator } from "../../components/LoadingIndicator";
import { ErrorFallback } from "../../components/ErrorFallback";
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
import { DictionarySheet } from "../../components/reader/DictionarySheet";
import { NotesPanel } from "../../components/reader/NotesPanel";
import { GotoDialog } from "../../components/reader/GotoDialog";
import { TocDrawer } from "../../components/reader/TocDrawer";
import { SettingsDropdown } from "../../components/reader/SettingsDropdown";
import { TtsBar } from "../../components/reader/TtsBar";
import { useTtsStore } from "../../lib/tts-store";
import { TypedNoteEditor } from "../../components/notes/TypedNoteEditor";
import { HandwritingCanvas } from "../../components/notes/HandwritingCanvas";
import { NoteViewer } from "../../components/notes/NoteViewer";
import { NoteChooser } from "../../components/notes/NoteChooser";
import {
  upsertProgress,
  getProgress,
  getBookmarks,
  createBookmark,
  deleteBookmark,
  createHighlight,
  deleteHighlight,
  getHighlights,
  createNote,
  getNotes,
  updateNote,
  deleteNote,
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
  const [currentChapterHref, setCurrentChapterHref] = useState<string | null>(null);

  // Context menu state
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [defineQuery, setDefineQuery] = useState<string | null>(null);
  const [selectionCfi, setSelectionCfi] = useState("");
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Notes state
  const [showTypedNote, setShowTypedNote] = useState(false);
  const [showDrawing, setShowDrawing] = useState(false);
  // When editing, the note being edited (so save goes to updateNote).
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  // Viewer stack: single note open, or a chooser when a tap hits several.
  const [viewingNote, setViewingNote] = useState<Note | null>(null);
  const [chooserNotes, setChooserNotes] = useState<Note[] | null>(null);

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

  // Scrubber drag state. While the user is touching the bottom
  // progress bar we render a local preview (not the live `progress`
  // from the WebView) so the dot tracks the finger 1:1, and only
  // commit the seek to foliate on release.
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  // Track geometry in screen-absolute coordinates, captured via
  // measureInWindow on layout. We use absolute pageX + width here
  // (rather than nativeEvent.locationX inside the touch handlers)
  // because PanResponder's locationX is sometimes reported relative
  // to a child of the responder element instead of the responder
  // itself, which makes the dot snap to 0 mid-drag.
  const trackRef = useRef<View>(null);
  const trackPageXRef = useRef(0);
  const trackWidthRef = useRef(0);
  // Latest fraction from the active touch — kept in a ref so the
  // release handler can read it without relying on stale closure
  // state from React.
  const lastDragFractionRef = useRef(0);
  // True while the user is actively touching the scrubber. Used by
  // the progressUpdated message handler to ignore foliate's
  // background relocate events mid-drag (otherwise the dot, page
  // number, chapter label, etc. flicker between the old position
  // and the user's drag position).
  const isDraggingRef = useRef(false);
  const fractionFromPageX = useCallback((pageX: number) => {
    const w = trackWidthRef.current;
    if (w <= 0) return 0;
    const x = pageX - trackPageXRef.current;
    return Math.max(0, Math.min(1, x / w));
  }, []);
  const measureTrack = useCallback(() => {
    trackRef.current?.measureInWindow((x, _y, w) => {
      trackPageXRef.current = x;
      trackWidthRef.current = w;
    });
  }, []);

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

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => getBook(bookId!),
    enabled: !!bookId,
  });

  // WebView-level load failures — the JS inside might crash or the
  // HTML source might fail to load entirely. Surfacing this as a
  // retryable error is the only way out since the WebView renders
  // nothing on its own when this happens.
  const [webViewError, setWebViewError] = useState<string | null>(null);


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
  // IMPORTANT: memoize on source+format ONLY — never on theme. The
  // WebView's `source` prop is compared by reference; if this string
  // changes react-native-webview tears down and rebuilds the entire
  // WebView, which loses the user's reading position. Theme colours
  // are applied post-mount via the `setTheme` message. The HTML only
  // sees the initial theme so the shell renders in the right colour
  // during the 100ms before the first setTheme lands.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const _readerHtml = useMemo(
    () =>
      _sourceUrl
        ? _format === "pdf"
          ? getPdfReaderHtml(_sourceUrl)
          : getReaderHtml(_sourceUrl, theme.bg, theme.fg)
        : "",
    // Only rebuild HTML when source/format change — NOT on theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [_sourceUrl, _format],
  );

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
        setProgress(savedProgress.position.percentage);
        setCurrentPosition(savedProgress.position);
      }
      setBookmarks(savedBookmarks);
      setHighlights(savedHighlights);
      setNotes(savedNotes);
      if (savedPrefs?.theme) {
        // Merge with defaults so newly-added fields get sane values when
        // loading prefs saved by an older version.
        const base = display.isEink ? EINK_THEME : DEFAULT_THEME;
        setTheme({ ...base, ...savedPrefs.theme });
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

  // Tap- and drag-to-seek on the bottom progress bar. We claim the
  // gesture on touchdown so a tap anywhere along the bar jumps
  // straight to that point; drag updates the live preview every
  // frame; release commits the seek and optimistically updates the
  // local progress so the dot doesn't flash back to the old
  // position before foliate's next relocate arrives.
  const scrubberPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: (_e, gs) => {
          // Re-measure once at the start of the gesture in case the
          // header / progress overlay shifted between mounts.
          measureTrack();
          isDraggingRef.current = true;
          const f = fractionFromPageX(gs.x0);
          lastDragFractionRef.current = f;
          setDragFraction(f);
        },
        onPanResponderMove: (_e, gs) => {
          const f = fractionFromPageX(gs.moveX);
          lastDragFractionRef.current = f;
          setDragFraction(f);
        },
        onPanResponderRelease: () => {
          const f = lastDragFractionRef.current;
          isDraggingRef.current = false;
          sendToWebView("goToLocation", { fraction: f });
          setProgress(f * 100);
          setDragFraction(null);
        },
        onPanResponderTerminate: () => {
          isDraggingRef.current = false;
          setDragFraction(null);
        },
      }),
    [fractionFromPageX, measureTrack, sendToWebView],
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
          if (typeof msg.payload?.totalPages === "number" && msg.payload.totalPages > 0) {
            setTotalPages(msg.payload.totalPages);
            setCurrentPage((page) => page ?? 1);
          }
          // Replay saved highlights so they're visible when reopening.
          // The WebView ignores any it's already drawn.
          for (const h of highlights) {
            sendToWebView("addHighlight", {
              cfi: h.cfiRange,
              color: h.color,
            });
          }
          // Replay note markers. Multiple notes on the same passage
          // share one marker — dedupe by cfi to avoid double-drawing.
          // If a passage has both a typed note and a drawing, the
          // drawing wins visually (more salient indigo underline).
          const seenNoteCfis = new Map<string, "typed" | "handwritten">();
          for (const n of notes) {
            const cfi = n.position.cfi;
            if (!cfi) continue;
            const existing = seenNoteCfis.get(cfi);
            if (existing === "handwritten") continue;
            seenNoteCfis.set(cfi, n.noteType);
          }
          for (const [cfi, noteType] of seenNoteCfis) {
            sendToWebView("addNote", { cfi, noteType });
          }
          // Restore saved position
          if (currentPosition?.cfi) {
            sendToWebView("goToLocation", { cfi: currentPosition.cfi });
          }
          break;
        case "progressUpdated": {
          // Ignore foliate's relocate stream while the user is
          // actively dragging the scrubber — otherwise the dot,
          // chapter label, and page number flicker between the
          // user's drag position and the old foliate position.
          if (isDraggingRef.current) break;
          const pct = msg.payload.percentage ?? 0;
          setProgress(pct);
          const position: BookPosition = {
            percentage: pct,
            cfi: msg.payload.cfi,
            chapter: msg.payload.chapter,
            page: msg.payload.currentPage ?? msg.payload.page,
          };
          setCurrentPosition(position);
          setCurrentChapterHref(msg.payload.chapterHref ?? null);
          const rawPage = msg.payload.currentPage;
          const rawTotal = msg.payload.totalPages;
          if (typeof rawPage === "number" && typeof rawTotal === "number" && rawTotal > 0) {
            setCurrentPage(Math.min(rawTotal, Math.max(1, Math.round(rawPage))));
            setTotalPages(rawTotal);
          } else {
            setCurrentPage(null);
            setTotalPages(null);
          }
          if (
            typeof msg.payload.pageInSection === "number" &&
            typeof msg.payload.pagesInSection === "number" &&
            msg.payload.pagesInSection > 0
          ) {
            const clampedPagesInSection = Math.max(1, Math.round(msg.payload.pagesInSection));
            setPagesInSection(clampedPagesInSection);
            setPageInSection(
              Math.min(
                clampedPagesInSection,
                Math.max(1, Math.round(msg.payload.pageInSection)),
              ),
            );
          } else {
            setPageInSection(null);
            setPagesInSection(null);
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
          setControlsVisible((v) => {
            if (v && controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
            return !v;
          });
          break;
        case "selectionChanged":
          if (msg.payload.text) {
            setSelectedText(msg.payload.text);
            setSelectionCfi(msg.payload.cfi ?? "");
            setSelectionRect(msg.payload.rect ?? null);
            setContextMenuVisible(true);
          }
          break;
        case "noteTapped":
          if (typeof msg.payload?.cfi === "string") {
            handleNoteTapped(msg.payload.cfi);
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

  function handleDefine() {
    if (!selectedText.trim()) return;
    setDefineQuery(selectedText);
    setContextMenuVisible(false);
  }

  // ─── Note handlers ─────────────────────────────────────────────────

  // Position a new note is saved to. We want the note to anchor to the
  // selected passage (so tapping the marker later jumps/opens here) —
  // fall back to the page-level position if somehow there's no selection.
  function noteAnchorPosition(): BookPosition | null {
    if (!currentPosition) return null;
    return selectionCfi ? { ...currentPosition, cfi: selectionCfi } : currentPosition;
  }

  // Redraw (or remove) the marker for a passage based on what notes
  // currently anchor to it. Drawings "win" over typed notes because the
  // indigo underline is more salient than the amber squiggle, and users
  // are more likely to care about a drawing existing on a passage.
  function refreshNoteMarker(cfi: string, fromNotes: Note[]) {
    const siblings = fromNotes.filter((n) => n.position.cfi === cfi);
    if (siblings.length === 0) {
      sendToWebView("removeNote", { cfi });
      return;
    }
    const noteType = siblings.some((n) => n.noteType === "handwritten")
      ? "handwritten"
      : "typed";
    // addAnnotation on an existing cfi replaces the prior annotation in
    // foliate, so this doubles as an update.
    sendToWebView("addNote", { cfi, noteType });
  }

  async function handleSaveTypedNote(text: string) {
    if (!bookId) return;
    try {
      if (editingNote) {
        await updateNote(editingNote.id, { textContent: text });
        const updated: Note = {
          ...editingNote,
          textContent: text,
          updatedAt: new Date().toISOString(),
        };
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
        setEditingNote(null);
      } else {
        const pos = noteAnchorPosition();
        if (!pos) return;
        const n = await createNote(bookId, pos, "typed", text);
        const next = [n, ...notes];
        setNotes(next);
        if (n.position.cfi) refreshNoteMarker(n.position.cfi, next);
      }
      setShowTypedNote(false);
    } catch {
      Alert.alert("Error", "Failed to save note");
    }
  }

  async function handleSaveDrawing(
    strokes: import("@readr/shared").Stroke[],
    penConfig: import("@readr/shared").PenConfig,
  ) {
    if (!bookId) return;
    try {
      if (editingNote) {
        await updateNote(editingNote.id, { strokes, penConfig });
        const updated: Note = {
          ...editingNote,
          strokes,
          penConfig,
          updatedAt: new Date().toISOString(),
        };
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
        setEditingNote(null);
      } else {
        const pos = noteAnchorPosition();
        if (!pos) return;
        const n = await createNote(bookId, pos, "handwritten", undefined, strokes, penConfig);
        const next = [n, ...notes];
        setNotes(next);
        if (n.position.cfi) refreshNoteMarker(n.position.cfi, next);
      }
      setShowDrawing(false);
    } catch {
      Alert.alert("Error", "Failed to save drawing");
    }
  }

  function handleDeleteNote(noteId: string) {
    const target = notes.find((n) => n.id === noteId);
    if (!target) return;
    // Notes can represent real effort (typed thoughts, sketched diagrams)
    // so require a confirmation before deleting — unlike bookmarks, which
    // are cheap to recreate.
    Alert.alert("Delete note", "This note will be removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteNote(noteId);
            const remaining = notes.filter((n) => n.id !== noteId);
            setNotes(remaining);
            if (target.position.cfi) refreshNoteMarker(target.position.cfi, remaining);
          } catch {
            Alert.alert("Error", "Failed to delete note");
          }
        },
      },
    ]);
  }

  // Called when a marker is tapped in the WebView. If exactly one note
  // anchors to this cfi, open it directly; otherwise surface a chooser
  // so the user can pick which overlapping note they meant.
  function handleNoteTapped(cfi: string) {
    const matches = notes.filter((n) => n.position.cfi === cfi);
    if (matches.length === 0) return;
    if (matches.length === 1) {
      setViewingNote(matches[0] ?? null);
    } else {
      setChooserNotes(matches);
    }
  }

  function openNoteForEdit(n: Note) {
    setViewingNote(null);
    setChooserNotes(null);
    setEditingNote(n);
    if (n.noteType === "typed") {
      setShowTypedNote(true);
    } else {
      setShowDrawing(true);
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

  async function handleDeleteHighlight(hlId: string) {
    const hl = highlights.find((h) => h.id === hlId);
    try {
      await deleteHighlight(hlId);
      setHighlights((prev) => prev.filter((h) => h.id !== hlId));
      // Remove visual annotation from WebView
      if (hl?.cfiRange) {
        sendToWebView("removeHighlight", { cfi: hl.cfiRange });
      }
    } catch {
      Alert.alert("Error", "Failed to delete highlight");
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

  // No separate memos — compute inline in JSX

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

  const format = book?.format ?? "epub";

  const lookupProviders = DEFAULT_LOOKUP_PROVIDERS.map((p) => ({
    name: p.name,
    icon: p.icon ?? "🔍",
    urlTemplate: p.urlTemplate,
  }));

  if (webViewError) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <ErrorFallback
          title="Reader crashed"
          message={webViewError}
          retryLabel="Reload"
          onRetry={() => {
            setWebViewError(null);
            webviewRef.current?.reload();
          }}
        />
      </View>
    );
  }

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
        onError={(e) => setWebViewError(e.nativeEvent?.description || "WebView failed to load")}
        onHttpError={(e) => setWebViewError(`HTTP ${e.nativeEvent?.statusCode ?? "?"}: failed to load book resource`)}
        onRenderProcessGone={() => setWebViewError("Reader process crashed — tap Reload to restart.")}
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

          <View
            style={[
              styles.progressOverlay,
              { backgroundColor: theme.bg, paddingBottom: Math.max(insets.bottom, 8) },
            ]}
          >
            {/* Scrubber track — drag to seek. Wrapped in a hit-slop
                area so the finger doesn't have to land precisely on
                the 4px line. E-ink uses solid theme.fg/bg since
                translucent grays collapse into ghost smudges. */}
            <View
              ref={trackRef}
              style={styles.progressTrackHitArea}
              onLayout={measureTrack}
              {...scrubberPanResponder.panHandlers}
            >
              <View
                style={[
                  styles.progressTrack,
                  display.isEink && { backgroundColor: theme.fg + "22", borderWidth: 1, borderColor: theme.fg },
                ]}
              >
                <View
                  style={[
                    styles.progressFill,
                    { width: `${dragFraction != null ? dragFraction * 100 : progress}%` },
                    display.isEink && { backgroundColor: theme.fg },
                  ]}
                />
                <View
                  style={[
                    styles.progressDot,
                    { left: `${dragFraction != null ? dragFraction * 100 : progress}%` },
                    dragFraction != null && styles.progressDotDragging,
                    display.isEink && { backgroundColor: theme.fg },
                  ]}
                />
              </View>
            </View>

            <Text
              style={[
                styles.progressLabel,
                { color: theme.fg, fontFamily: readerTextFontFamily(theme.fontFamily) },
                display.isEink && styles.progressLabelEink,
              ]}
              numberOfLines={1}
            >
              {currentPosition?.chapter ?? ""}
            </Text>
            <View style={styles.progressInfoRow}>
              <Text
                style={[
                  styles.progressLabel,
                  { color: theme.fg, fontFamily: readerTextFontFamily(theme.fontFamily) },
                  display.isEink && styles.progressLabelEink,
                ]}
              >
                {pageInSection != null && pagesInSection != null && pagesInSection > 0
                  ? `${pageInSection}/${pagesInSection}`
                  : ""}
              </Text>
              <Text
                style={[
                  styles.progressLabel,
                  { color: theme.fg, fontFamily: readerTextFontFamily(theme.fontFamily) },
                  display.isEink && styles.progressLabelEink,
                ]}
              >
                {currentPage != null && totalPages != null && totalPages > 0
                  ? `p. ${currentPage}/${totalPages}`
                  : ""}
              </Text>
            </View>
            <Text
              style={[
                styles.progressLabel,
                styles.progressPercent,
                { color: theme.fg, fontFamily: readerTextFontFamily(theme.fontFamily) },
                display.isEink && styles.progressLabelEink,
              ]}
            >
              {`${progress.toFixed(1)}%`}
            </Text>
          </View>
        </>
      ) : (
        /* Minimal progress bar always visible at bottom.
           E-ink uses solid fg/bg so the bar stays crisp — translucent
           tints smudge into the ~16 gray levels of an e-ink panel. */
        <View
          style={[
            styles.miniProgress,
            { backgroundColor: display.isEink ? theme.bg : theme.bg + "cc" },
          ]}
        >
          <View
            style={[
              styles.miniProgressFill,
              {
                width: `${progress}%`,
                backgroundColor: display.isEink ? theme.fg : theme.fg + "33",
              },
            ]}
          />
        </View>
      )}

      {theme.pageIndicator?.enabled && !controlsVisible && currentPage != null && totalPages != null && totalPages > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.pageIndicator,
            theme.pageIndicator.edge === "top"
              ? { top: insets.top + 4 }
              : { bottom: Math.max(insets.bottom, 4) + 6 },
            resolveIndicatorSide(theme.pageIndicator.side, currentPage) === "left"
              ? { left: 12 }
              : { right: 12 },
          ]}
        >
          <Text style={[styles.pageIndicatorText, { color: theme.fg, fontFamily: readerTextFontFamily(theme.fontFamily) }]}>
            {currentPage}
          </Text>
        </View>
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
        onGoToPage={() => setShowGotoDialog(true)}
        onJumpToBookmark={handleGoToBookmark}
        onDeleteBookmark={(id) => handleDeleteBookmark(id)}
        onJumpToNote={(n) => {
          if (n.position.cfi) sendToWebView("goToLocation", { cfi: n.position.cfi });
          else sendToWebView("goToLocation", { fraction: n.position.percentage / 100 });
        }}
        onDeleteNote={handleDeleteNote}
        onJumpToHighlight={(h) => {
          if (h.cfiRange) sendToWebView("goToLocation", { cfi: h.cfiRange });
        }}
        onDeleteHighlight={handleDeleteHighlight}
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
        anchorRect={selectionRect}
        onClose={() => setContextMenuVisible(false)}
        onHighlight={handleHighlight}
        onNote={handleNoteFromMenu}
        onDraw={handleDrawFromMenu}
        onCopy={handleCopy}
        onDefine={handleDefine}
        onLookup={handleLookup}
        lookupProviders={lookupProviders}
      />

      <DictionarySheet
        visible={defineQuery !== null}
        query={defineQuery ?? ""}
        onClose={() => setDefineQuery(null)}
      />

      <TypedNoteEditor
        visible={showTypedNote}
        initialText={editingNote?.noteType === "typed" ? (editingNote.textContent ?? "") : ""}
        onSave={handleSaveTypedNote}
        onCancel={() => {
          setShowTypedNote(false);
          setEditingNote(null);
        }}
      />

      <HandwritingCanvas
        visible={showDrawing}
        initialStrokes={editingNote?.noteType === "handwritten" ? (editingNote.strokes ?? []) : []}
        onSave={handleSaveDrawing}
        onCancel={() => {
          setShowDrawing(false);
          setEditingNote(null);
        }}
      />

      <NoteViewer
        note={viewingNote}
        onClose={() => setViewingNote(null)}
        onEdit={openNoteForEdit}
        onDelete={async (id) => {
          setViewingNote(null);
          await handleDeleteNote(id);
        }}
        onJumpTo={(cfi) => {
          setViewingNote(null);
          sendToWebView("goToLocation", { cfi });
        }}
      />

      <NoteChooser
        notes={chooserNotes}
        onPick={(n) => {
          setChooserNotes(null);
          setViewingNote(n);
        }}
        onClose={() => setChooserNotes(null)}
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
          if (format === "pdf") {
            sendToWebView("goToLocation", { page });
            return;
          }
          if (totalPages && totalPages > 0) {
            const fraction = totalPages > 1
              ? (page - 1) / (totalPages - 1)
              : 0;
            sendToWebView("goToLocation", { fraction });
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
  // 24px-tall transparent hit area so dragging is forgiving — the
  // visible track lives inside, vertically centered.
  progressTrackHitArea: {
    height: 24,
    justifyContent: "center",
    marginBottom: 4,
  },
  progressTrack: {
    height: 4,
    backgroundColor: "rgba(0,0,0,0.08)",
    borderRadius: 2,
    position: "relative",
  },
  progressFill: {
    height: 4,
    backgroundColor: "rgba(0,0,0,0.25)",
    borderRadius: 2,
  },
  progressDot: {
    position: "absolute",
    top: -6,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "rgba(0,0,0,0.4)",
    marginLeft: -8,
  },
  progressDotDragging: {
    width: 20,
    height: 20,
    borderRadius: 10,
    top: -8,
    marginLeft: -10,
    backgroundColor: "rgba(0,0,0,0.7)",
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
  // E-ink can't render faint text legibly — bump to full contrast and a
  // slightly larger size so the reading-progress line doesn't disappear
  // against the page background on the ~16-gray Supernote panel.
  progressLabelEink: { opacity: 1, fontSize: 12, fontWeight: "500" },
  progressPercent: { textAlign: "right", marginTop: 2 },
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
  pageIndicator: {
    position: "absolute",
    zIndex: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pageIndicatorText: {
    fontSize: 11,
    opacity: 0.45,
    fontVariant: ["tabular-nums"],
  },
});

function resolveIndicatorSide(
  side: "left" | "right" | "alternate",
  page: number,
): "left" | "right" {
  if (side === "alternate") return page % 2 === 0 ? "left" : "right";
  return side;
}

/**
 * Map the theme's CSS fontFamily string to an Android/iOS-native font name.
 * The theme's fontFamily is a CSS stack like `'Literata', serif` that only
 * works inside the WebView; RN Text needs a registered family name. We fall
 * back to the system serif/sans/monospace so the indicator at least matches
 * the broad typographic character of the book text.
 */
function readerTextFontFamily(cssFontFamily: string): string | undefined {
  if (!cssFontFamily) return undefined;
  const lower = cssFontFamily.toLowerCase();
  if (lower.includes("mono")) return "monospace";
  if (lower.includes("sans")) return "sans-serif";
  return "serif";
}
