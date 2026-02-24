import { useState, useRef, useCallback } from "react";
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { WebView } from "react-native-webview";
import { getBook } from "../../lib/api";
import { getReaderHtml } from "../../components/reader/epub-html";
import { getPdfReaderHtml } from "../../components/reader/pdf-html";
import {
  ReaderControls,
  DEFAULT_THEME,
  type ReaderTheme,
} from "../../components/reader/ReaderControls";

interface TocItem {
  label: string;
  href: string;
  depth: number;
}

export default function ReaderScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const webviewRef = useRef<WebView>(null);
  const [showControls, setShowControls] = useState(false);
  const [theme, setTheme] = useState<ReaderTheme>(DEFAULT_THEME);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [progress, setProgress] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => getBook(bookId!),
    enabled: !!bookId,
  });

  const book = data?.book;

  const sendToWebView = useCallback(
    (type: string, payload: Record<string, unknown>) => {
      webviewRef.current?.postMessage(JSON.stringify({ type, payload }));
    },
    [],
  );

  function handleThemeChange(newTheme: ReaderTheme) {
    setTheme(newTheme);
    sendToWebView("setTheme", newTheme as unknown as Record<string, unknown>);
  }

  function handleGoToChapter(href: string) {
    sendToWebView("goToChapter", { href });
  }

  function handleSearch(query: string) {
    sendToWebView("search", { query });
  }

  function handleMessage(event: { nativeEvent: { data: string } }) {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      switch (msg.type) {
        case "ready":
          sendToWebView("setTheme", theme as unknown as Record<string, unknown>);
          break;
        case "progressUpdated":
          setProgress(msg.payload.percentage ?? 0);
          break;
        case "tocLoaded":
          setToc(msg.payload.chapters ?? []);
          break;
        case "tapCenter":
          setShowControls(true);
          break;
        case "selectionChanged":
          // Will be used by context menu in Phase 2.4
          break;
      }
    } catch {
      // Ignore non-JSON messages
    }
  }

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
  const readerHtml = format === "pdf"
    ? getPdfReaderHtml(book.downloadUrl!)
    : getReaderHtml(book.downloadUrl!);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.bg }]}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, { color: theme.fg }]}>←</Text>
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.fg }]} numberOfLines={1}>
          {book.title ?? "Reading"}
        </Text>
        <Pressable onPress={() => setShowControls(true)} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, { color: theme.fg }]}>⚙</Text>
        </Pressable>
      </View>

      <WebView
        ref={webviewRef}
        style={styles.webview}
        originWhitelist={["*"]}
        source={{ html: readerHtml }}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        mixedContentMode="always"
      />

      <View style={[styles.progressBar, { backgroundColor: theme.bg }]}>
        <View style={[styles.progressFill, { width: `${progress}%` }]} />
        <Text style={[styles.progressText, { color: theme.fg }]}>{progress}%</Text>
      </View>

      <ReaderControls
        visible={showControls}
        theme={theme}
        toc={toc}
        progress={progress}
        onClose={() => setShowControls(false)}
        onThemeChange={handleThemeChange}
        onGoToChapter={handleGoToChapter}
        onSearch={handleSearch}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  error: { color: "#dc2626", marginBottom: 12 },
  muted: { color: "#666", marginBottom: 12 },
  link: { color: "#111", fontWeight: "600" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingTop: 48,
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  headerButton: { width: 44, height: 44, justifyContent: "center", alignItems: "center" },
  headerButtonText: { fontSize: 20 },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "500" },
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
});
