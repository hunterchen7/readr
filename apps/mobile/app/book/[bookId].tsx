import { useState, useEffect } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, Download, BookOpen, Check, Trash2 } from "lucide-react-native";
import { getBook, deleteBook } from "../../lib/api";
import { downloadBook, getDownloadedBook, deleteDownloadedBook } from "../../lib/book-cache";
import { getProgress } from "../../lib/local-db";
import { colors, spacing, fontSize } from "../../lib/theme";

export default function BookDetailScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
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

  function handleRead() {
    if (!bookId) return;
    if (!downloaded) {
      // Download first, then open
      handleDownload().then(() => router.push(`/reader/${bookId}`));
      return;
    }
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

  if (isLoading || !book) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" style={{ marginTop: 100 }} />
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

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.coverRow}>
          {book.coverUrl ? (
            <Image source={{ uri: book.coverUrl }} style={styles.cover} />
          ) : (
            <View style={[styles.cover, styles.coverPlaceholder]}>
              <Text style={styles.coverPlaceholderText}>{book.title ?? "?"}</Text>
            </View>
          )}

          <View style={styles.meta}>
            <Text style={styles.title}>{book.title ?? "Untitled"}</Text>
            <Text style={styles.author}>{book.author ?? "Unknown author"}</Text>

            <View style={styles.badges}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{book.format?.toUpperCase() ?? "EPUB"}</Text>
              </View>
              <View style={[styles.badge, status === "Finished" && styles.badgeFinished, status === "Reading" && styles.badgeReading]}>
                <Text style={[styles.badgeText, (status === "Finished" || status === "Reading") && styles.badgeTextActive]}>
                  {status}
                </Text>
              </View>
            </View>

            {progressPct > 0 ? (
              <View style={styles.progressRow}>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.min(100, progressPct)}%` }]} />
                </View>
                <Text style={styles.progressLabel}>{progressPct}%</Text>
              </View>
            ) : null}

            {book.language ? <Text style={styles.detail}>Language: {book.language}</Text> : null}
            {book.totalChapters ? <Text style={styles.detail}>Chapters: {book.totalChapters}</Text> : null}
          </View>
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <Pressable style={styles.primaryBtn} onPress={handleRead}>
            <BookOpen size={18} color={colors.primaryFg} />
            <Text style={styles.primaryBtnText}>
              {downloaded ? "Read" : "Download & Read"}
            </Text>
          </Pressable>

          {!downloaded ? (
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
            <View style={styles.downloadedRow}>
              <Check size={16} color="#16a34a" />
              <Text style={[styles.detail, { color: "#16a34a" }]}>Downloaded</Text>
            </View>
          )}
        </View>

        {/* Mark as finished / unread */}
        <View style={styles.statusActions}>
          {progressPct < 98 ? (
            <Pressable
              style={styles.textBtn}
              onPress={() => {
                // TODO: save status override to server + local
                setProgressPct(100);
                Alert.alert("Marked as finished");
              }}
            >
              <Text style={styles.textBtnText}>Mark as finished</Text>
            </Pressable>
          ) : (
            <Pressable
              style={styles.textBtn}
              onPress={() => {
                setProgressPct(0);
                Alert.alert("Marked as unread");
              }}
            >
              <Text style={styles.textBtnText}>Mark as unread</Text>
            </Pressable>
          )}

          <Pressable style={styles.textBtn} onPress={handleDelete}>
            <Trash2 size={14} color={colors.error} />
            <Text style={[styles.textBtnText, { color: colors.error }]}>Delete book</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  backBtn: { width: 40, height: 40, justifyContent: "center" },
  content: { paddingHorizontal: spacing.xl, paddingBottom: 40 },
  coverRow: { flexDirection: "row", gap: spacing.lg, marginBottom: spacing.xl },
  cover: { width: 120, height: 180, borderRadius: 8, backgroundColor: colors.backgroundSecondary },
  coverPlaceholder: { justifyContent: "center", alignItems: "center", padding: spacing.sm },
  coverPlaceholderText: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: "center" },
  meta: { flex: 1, gap: spacing.xs },
  title: { fontSize: fontSize.xl, fontWeight: "700", color: colors.text },
  author: { fontSize: fontSize.md, color: colors.textSecondary },
  badges: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: colors.backgroundSecondary,
  },
  badgeFinished: { backgroundColor: "#dcfce7" },
  badgeReading: { backgroundColor: colors.filterActive },
  badgeText: { fontSize: 11, fontWeight: "600", color: colors.textMuted, textTransform: "uppercase" },
  badgeTextActive: { color: colors.text },
  progressRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs },
  progressTrack: { flex: 1, height: 4, backgroundColor: colors.backgroundSecondary, borderRadius: 2 },
  progressFill: { height: 4, backgroundColor: colors.primary, borderRadius: 2 },
  progressLabel: { fontSize: fontSize.xs, color: colors.textMuted, minWidth: 32 },
  detail: { fontSize: fontSize.sm, color: colors.textMuted },
  actions: { gap: spacing.md, marginBottom: spacing.xl },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
  },
  primaryBtnText: { color: colors.primaryFg, fontSize: fontSize.lg, fontWeight: "600" },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 12,
  },
  secondaryBtnText: { fontSize: fontSize.md, color: colors.text },
  downloadedRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, justifyContent: "center" },
  statusActions: { gap: spacing.md },
  textBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  textBtnText: { fontSize: fontSize.md, color: colors.textSecondary },
});
