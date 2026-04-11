import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
  Platform,
} from "react-native";
import { useLocalSearchParams, router, useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, Download, BookOpen, Check, Trash2, FileDown } from "lucide-react-native";
import { getBook, deleteBook } from "../../lib/api";
import { downloadBook, getDownloadedBook, deleteDownloadedBook } from "../../lib/book-cache";
import { getProgress } from "../../lib/local-db";
import { downloadFile } from "../../lib/download-file";
import { useSyncStatus } from "../../lib/sync-status";
import { colors, spacing, fontSize } from "../../lib/theme";
import { LoadingIndicator } from "../../components/LoadingIndicator";
import { ErrorFallback } from "../../components/ErrorFallback";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default function BookDetailScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const runSyncNow = useSyncStatus((s) => s.sync);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => getBook(bookId!),
    enabled: !!bookId,
  });

  const book = data?.book;

  const [downloaded, setDownloaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadPct, setDownloadPct] = useState(0);
  const [progressPct, setProgressPct] = useState(0);

  useEffect(() => {
    if (!bookId) return;
    (async () => {
      const dl = await getDownloadedBook(bookId);
      setDownloaded(!!dl);
      const p = await getProgress(bookId);
      setProgressPct(Math.round(p?.position.percentage ?? 0));
    })();
  }, [bookId]);

  // Fall back to server progress if local is 0
  useEffect(() => {
    if (progressPct === 0 && (book as any)?.progressPct > 0) {
      setProgressPct((book as any).progressPct);
    }
  }, [book, progressPct]);

  // Refetch on focus so coming back from the reader (or from another
  // device's edit landing via sync) reflects fresh metadata + the
  // current progress percentage. Pulls remote changes first so any
  // cross-device progress update lands in local SQLite before we
  // re-read it; failures are non-fatal (offline still renders the
  // cached value).
  useFocusEffect(
    useCallback(() => {
      if (!bookId) return;
      (async () => {
        try {
          await runSyncNow();
        } catch {
          /* non-fatal */
        }
        queryClient.invalidateQueries({ queryKey: ["book", bookId] });
        const p = await getProgress(bookId);
        if (p) setProgressPct(Math.round(p.position.percentage ?? 0));
      })();
    }, [bookId, queryClient, runSyncNow]),
  );

  async function handleDownload() {
    if (!bookId) return;
    setDownloading(true);
    setDownloadPct(0);
    try {
      await downloadBook(bookId, (frac) => setDownloadPct(Math.round(frac * 100)));
      setDownloaded(true);
    } catch (err) {
      Alert.alert("Download failed", err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  async function handleDownloadFile() {
    if (!book?.downloadUrl) {
      Alert.alert("Download failed", "This book has no downloadable file.");
      return;
    }
    // Build a sensible default filename — most browsers will ignore it
    // on cross-origin downloads (R2 is a different origin), but on the
    // off chance they honour it we want something better than
    // "book.epub" from the URL path.
    const safeTitle = (book.title ?? "book")
      .replace(/[^\w\s.-]+/g, "")
      .replace(/\s+/g, " ")
      .trim() || "book";
    const ext = book.format ?? "epub";
    try {
      await downloadFile(book.downloadUrl, `${safeTitle}.${ext}`);
    } catch (err) {
      Alert.alert(
        "Download failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function handleRead() {
    if (!bookId) return;
    // The reader falls back to the server downloadUrl when localPath
    // is null, so we can open it regardless of download state.
    router.push(`/reader/${bookId}`);
  }

  function handleDelete() {
    Alert.alert("Delete book", "Remove this book from your library?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            if (downloaded && bookId) await deleteDownloadedBook(bookId);
            await deleteBook(bookId!);
            queryClient.invalidateQueries({ queryKey: ["books"] });
            router.back();
          } catch (err) {
            Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete");
          }
        },
      },
    ]);
  }

  if (error) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <ErrorFallback
          title="Couldn't load book"
          message={error.message}
          onRetry={() => refetch()}
        />
      </View>
    );
  }

  if (isLoading || !book) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, alignItems: "center" }]}>
        <View style={{ marginTop: 100 }}>
          <LoadingIndicator size="large" />
        </View>
      </View>
    );
  }

  const status = progressPct >= 98 ? "Finished" : progressPct > 0 ? "Reading" : "Not started";

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityLabel="Go back" style={styles.backBtn}>
          <ArrowLeft size={22} color={colors.text} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <View style={styles.hero}>
            {book.coverUrl ? (
              <Image source={{ uri: book.coverUrl }} style={styles.cover} />
            ) : (
              <View style={[styles.cover, styles.coverPlaceholder]}>
                <Text style={styles.coverPlaceholderText}>{book.title ?? "?"}</Text>
              </View>
            )}

            <Text style={styles.title}>{book.title ?? "Untitled"}</Text>
            {book.author ? <Text style={styles.author}>{book.author}</Text> : null}

            <View style={styles.badges}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{book.format?.toUpperCase() ?? "EPUB"}</Text>
              </View>
              <View
                style={[
                  styles.badge,
                  status === "Finished" && styles.badgeFinished,
                  status === "Reading" && styles.badgeReading,
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    (status === "Finished" || status === "Reading") && styles.badgeTextActive,
                  ]}
                >
                  {status}
                </Text>
              </View>
            </View>
          </View>

          {progressPct > 0 ? (
            <View style={styles.progressBlock}>
              <View style={styles.progressHeader}>
                <Text style={styles.progressTitle}>Reading progress</Text>
                <Text style={styles.progressValue}>{progressPct}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.min(100, progressPct)}%` }]} />
              </View>
            </View>
          ) : null}

          {(() => {
            const rows: { label: string; value: string }[] = [];
            if (book.language) rows.push({ label: "Language", value: book.language });
            if (book.totalChapters)
              rows.push({ label: "Chapters", value: String(book.totalChapters) });
            if (typeof book.fileSize === "number" && book.fileSize > 0)
              rows.push({ label: "File size", value: formatFileSize(book.fileSize) });
            if (rows.length === 0) return null;
            return (
              <View style={styles.detailsCard}>
                {rows.map((row, i) => (
                  <View
                    key={row.label}
                    style={[styles.detailRow, i === rows.length - 1 && styles.detailRowLast]}
                  >
                    <Text style={styles.detailLabel}>{row.label}</Text>
                    <Text style={styles.detailValue}>{row.value}</Text>
                  </View>
                ))}
              </View>
            );
          })()}

          {/* Primary action */}
          <Pressable style={styles.primaryBtn} onPress={handleRead}>
            <BookOpen size={18} color={colors.primaryFg} />
            <Text style={styles.primaryBtnText}>
              {progressPct > 0 && progressPct < 98 ? "Continue reading" : "Read"}
            </Text>
          </Pressable>

          {/* Offline cache — native only. On web there's no on-device
              file store, so we drop this row entirely and let the
              "Download file" button below cover the "get the file"
              use case. */}
          {Platform.OS !== "web" ? (
            !downloaded ? (
              <Pressable
                style={[styles.secondaryBtn, downloading && { opacity: 0.5 }]}
                onPress={handleDownload}
                disabled={downloading}
              >
                {downloading ? (
                  <Text style={styles.secondaryBtnText}>Downloading {downloadPct}%</Text>
                ) : (
                  <>
                    <Download size={16} color={colors.text} />
                    <Text style={styles.secondaryBtnText}>Download for offline</Text>
                  </>
                )}
              </Pressable>
            ) : (
              <View style={styles.downloadedPill}>
                <Check size={14} color="#16a34a" />
                <Text style={styles.downloadedText}>Available offline</Text>
              </View>
            )
          ) : null}

          {/* Download the original EPUB/PDF file. Always available —
              on native it hands off to the OS via Linking, on web it
              triggers a browser download. */}
          <Pressable style={styles.secondaryBtn} onPress={handleDownloadFile}>
            <FileDown size={16} color={colors.text} />
            <Text style={styles.secondaryBtnText}>Download file</Text>
          </Pressable>

          {/* Secondary actions list */}
          <View style={styles.listCard}>
            {progressPct < 98 ? (
              <Pressable
                style={styles.listRow}
                onPress={() => {
                  // TODO: save status override to server + local
                  setProgressPct(100);
                  Alert.alert("Marked as finished");
                }}
              >
                <Check size={16} color={colors.textSecondary} />
                <Text style={styles.listRowText}>Mark as finished</Text>
              </Pressable>
            ) : (
              <Pressable
                style={styles.listRow}
                onPress={() => {
                  setProgressPct(0);
                  Alert.alert("Marked as unread");
                }}
              >
                <BookOpen size={16} color={colors.textSecondary} />
                <Text style={styles.listRowText}>Mark as unread</Text>
              </Pressable>
            )}

            <View style={styles.listDivider} />

            <Pressable style={styles.listRow} onPress={handleDelete}>
              <Trash2 size={16} color={colors.error} />
              <Text style={[styles.listRowText, { color: colors.error }]}>Delete book</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  backBtn: { width: 40, height: 40, justifyContent: "center" },
  scrollContent: { paddingBottom: 40, alignItems: "center" },
  content: {
    width: "100%",
    maxWidth: 480,
    paddingHorizontal: spacing.xl,
    gap: spacing.lg,
  },

  hero: { alignItems: "center", gap: spacing.sm, paddingTop: spacing.md, paddingBottom: spacing.sm },
  cover: {
    width: 160,
    height: 240,
    borderRadius: 10,
    backgroundColor: colors.backgroundSecondary,
    marginBottom: spacing.md,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
  },
  coverPlaceholder: { justifyContent: "center", alignItems: "center", padding: spacing.sm },
  coverPlaceholderText: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: "center" },

  title: {
    fontSize: fontSize.xxl,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
    lineHeight: 28,
  },
  author: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: "center" },

  badges: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.backgroundSecondary,
  },
  badgeFinished: { backgroundColor: "#dcfce7" },
  badgeReading: { backgroundColor: colors.filterActive },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  badgeTextActive: { color: colors.filterActiveText },

  progressBlock: { gap: spacing.sm },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  progressTitle: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: "500" },
  progressValue: { fontSize: fontSize.sm, color: colors.text, fontWeight: "600" },
  progressTrack: {
    height: 6,
    backgroundColor: colors.backgroundSecondary,
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: { height: 6, backgroundColor: colors.primary, borderRadius: 3 },

  detailsCard: {
    backgroundColor: colors.backgroundSecondary,
    borderRadius: 12,
    paddingHorizontal: spacing.lg,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  detailRowLast: { borderBottomWidth: 0 },
  detailLabel: { fontSize: fontSize.sm, color: colors.textSecondary },
  detailValue: { fontSize: fontSize.sm, color: colors.text, fontWeight: "500" },

  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: spacing.sm,
  },
  primaryBtnText: { color: colors.primaryFg, fontSize: fontSize.lg, fontWeight: "600" },

  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 14,
  },
  secondaryBtnText: { fontSize: fontSize.md, color: colors.text, fontWeight: "500" },

  downloadedPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  downloadedText: { fontSize: fontSize.sm, color: "#16a34a", fontWeight: "500" },

  listCard: {
    backgroundColor: colors.backgroundSecondary,
    borderRadius: 12,
    overflow: "hidden",
    marginTop: spacing.sm,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
  },
  listRowText: { fontSize: fontSize.md, color: colors.text },
  listDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.lg + 16 + spacing.md,
  },
});
