import { useEffect, useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Image,
  RefreshControl,
  Alert,
  ActivityIndicator,
  TextInput,
  ScrollView,
  Platform,
  useWindowDimensions,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { listBooks, uploadBook } from "../../lib/api";
import { getAllProgress } from "../../lib/local-db";
import { downloadBook, getDownloadedBookIds } from "../../lib/book-cache";
import { useSyncStatus } from "../../lib/sync-status";
import { useLibraryPrefs } from "../../lib/library-prefs";
import { colors, spacing, fontSize } from "../../lib/theme";
import { Search, X, LayoutGrid, List, RefreshCw, Plus, Cloud, ArrowUpDown } from "lucide-react-native";
import type { Book } from "@readr/shared";

type BookWithProgress = Book & {
  progressPct: number;
  downloaded: boolean;
  /** 0..1 when a download is in flight, null when idle or done. */
  downloadProgress: number | null;
};

type SortKey = "recent" | "lastRead" | "title" | "author";
type FilterKey = "all" | "reading" | "unread" | "finished" | "downloaded";

const SORT_LABELS: Record<SortKey, string> = {
  recent: "Recently added",
  lastRead: "Last read",
  title: "Title A–Z",
  author: "Author A–Z",
};

const FILTER_LABELS: Record<FilterKey, string> = {
  all: "All",
  reading: "Reading",
  unread: "Unread",
  finished: "Finished",
  downloaded: "Downloaded",
};

function formatRelative(ts: number): string {
  const ago = Math.max(0, Date.now() - ts);
  const mins = Math.floor(ago / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function LibraryScreen() {
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  // Persisted UI prefs (sort, filter, view mode, last search)
  const sort = useLibraryPrefs((s) => s.sort);
  const filter = useLibraryPrefs((s) => s.filter);
  const view = useLibraryPrefs((s) => s.view);
  const setSort = useLibraryPrefs((s) => s.setSort);
  const setFilter = useLibraryPrefs((s) => s.setFilter);
  const setView = useLibraryPrefs((s) => s.setView);

  const { width: screenWidth } = useWindowDimensions();
  const numColumns = Math.max(2, Math.floor(screenWidth / 180));

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const { data, isLoading, error, isRefetching } = useQuery({
    queryKey: ["books", sort],
    queryFn: () => listBooks(sort),
  });

  const rawBooks = data?.books ?? [];
  const [booksWithProgress, setBooksWithProgress] = useState<BookWithProgress[]>([]);

  const syncPhase = useSyncStatus((s) => s.phase);
  const syncLastAt = useSyncStatus((s) => s.lastSyncAt);
  const syncLastError = useSyncStatus((s) => s.lastError);
  const runSyncNow = useSyncStatus((s) => s.sync);

  // Re-hydrate download/progress status when screen regains focus
  // (e.g. after downloading a book in the detail screen).
  const [focusCount, setFocusCount] = useState(0);
  useFocusEffect(useCallback(() => {
    setFocusCount((c) => c + 1);
  }, []));

  // Hydrate each book with its locally-stored progress percentage and
  // downloaded status. Runs whenever the server list or focus changes.
  useEffect(() => {
    if (rawBooks.length === 0) {
      setBooksWithProgress([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [downloadedSet, progressMap] = await Promise.all([
        getDownloadedBookIds(),
        getAllProgress(),
      ]);
      const results: BookWithProgress[] = rawBooks.map((b) => {
        const p = progressMap.get(b.id);
        // Use local progress if available, fall back to server's progressPct
        const localPct = p ? Math.round(p.position.percentage ?? 0) : null;
        const serverPct = (b as any).progressPct ?? 0;
        return {
          ...b,
          progressPct: localPct ?? serverPct,
          downloaded: downloadedSet.has(b.id),
          downloadProgress: null,
        };
      });
      if (!cancelled) setBooksWithProgress(results);
    })();
    return () => {
      cancelled = true;
    };
  }, [rawBooks, focusCount]);

  // Apply filter + client-side search on top of the server-sorted list.
  const visibleBooks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return booksWithProgress.filter((b) => {
      // Read-status filter
      switch (filter) {
        case "reading":
          if (!(b.progressPct > 0 && b.progressPct < 98)) return false;
          break;
        case "unread":
          if (b.progressPct > 0) return false;
          break;
        case "finished":
          if (b.progressPct < 98) return false;
          break;
        case "downloaded":
          if (!b.downloaded) return false;
          break;
      }
      // Text search
      if (needle) {
        const hay = `${b.title ?? ""} ${b.author ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [booksWithProgress, filter, search]);

  async function handleDownload(bookId: string) {
    setBooksWithProgress((prev) =>
      prev.map((b) => (b.id === bookId ? { ...b, downloadProgress: 0 } : b)),
    );
    try {
      await downloadBook(bookId, (frac) => {
        setBooksWithProgress((prev) =>
          prev.map((b) => (b.id === bookId ? { ...b, downloadProgress: frac } : b)),
        );
      });
      setBooksWithProgress((prev) =>
        prev.map((b) =>
          b.id === bookId ? { ...b, downloaded: true, downloadProgress: null } : b,
        ),
      );
    } catch (err) {
      setBooksWithProgress((prev) =>
        prev.map((b) => (b.id === bookId ? { ...b, downloadProgress: null } : b)),
      );
      Alert.alert(
        "Download failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function handleBookPress(book: BookWithProgress) {
    router.push(`/book/${book.id}`);
  }

  async function handleUpload() {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["application/epub+zip", "application/pdf", ".epub", ".pdf"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets[0]) return;
      const asset = picked.assets[0];
      setUploading(true);
      await uploadBook({
        uri: asset.uri,
        name: asset.name,
        type: asset.mimeType ?? "application/octet-stream",
      });
      await queryClient.invalidateQueries({ queryKey: ["books"] });
    } catch (err) {
      Alert.alert("Upload failed", err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function cycleSort() {
    const order: SortKey[] = ["recent", "lastRead", "title", "author"];
    const next = order[(order.indexOf(sort) + 1) % order.length];
    setSort(next);
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error.message}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.heading}>Library</Text>
        <View style={styles.topBarActions}>
          <Pressable
            style={styles.iconButton}
            onPress={() => setSearchOpen((o) => !o)}
            accessibilityLabel={searchOpen ? "Close search" : "Search library"}
          >
            {searchOpen ? <X size={20} color={colors.text} /> : <Search size={20} color={colors.text} />}
          </Pressable>
          <Pressable
            style={styles.iconButton}
            onPress={() => setView(view === "grid" ? "list" : "grid")}
            accessibilityLabel={view === "grid" ? "Switch to list view" : "Switch to grid view"}
          >
            {view === "grid" ? <List size={20} color={colors.text} /> : <LayoutGrid size={20} color={colors.text} />}
          </Pressable>
          <Pressable
            style={styles.syncChip}
            onPress={async () => {
              await runSyncNow();
              queryClient.invalidateQueries({ queryKey: ["books"] });
            }}
            accessibilityLabel="Sync library"
          >
            {syncPhase === "running" ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <RefreshCw size={14} color={syncLastError ? colors.syncError : colors.syncIcon} />
                <Text style={styles.syncChipText}>
                  {syncLastError
                    ? "Error"
                    : syncLastAt
                      ? formatRelative(syncLastAt)
                      : "Sync"}
                </Text>
              </View>
            )}
          </Pressable>
          <Pressable
            style={[styles.uploadButton, uploading && styles.uploadButtonDisabled]}
            onPress={handleUpload}
            disabled={uploading}
            accessibilityLabel="Upload book"
          >
            {uploading ? (
              <ActivityIndicator color={colors.primaryFg} />
            ) : (
              <Plus size={20} color={colors.primaryFg} />
            )}
          </Pressable>
        </View>
      </View>

      {searchOpen ? (
        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search by title or author…"
            placeholderTextColor={colors.textMuted}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {search ? (
            <Pressable onPress={() => setSearch("")}>
              <X size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
        style={{ flexGrow: 0 }}
      >
        <Pressable style={styles.sortPill} onPress={cycleSort}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <ArrowUpDown size={12} color={colors.primaryFg} />
            <Text style={styles.sortPillText}>{SORT_LABELS[sort]}</Text>
          </View>
        </Pressable>
        {(Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => (
          <Pressable
            key={key}
            onPress={() => setFilter(key)}
            style={[
              styles.filterPill,
              filter === key && styles.filterPillActive,
            ]}
          >
            <Text
              style={[
                styles.filterPillText,
                filter === key && styles.filterPillTextActive,
              ]}
            >
              {FILTER_LABELS[key]}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.textMuted} />
          <Text style={[styles.muted, { marginTop: spacing.md }]}>Loading library...</Text>
        </View>
      ) : booksWithProgress.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.muted}>No books yet.</Text>
          <Text style={styles.muted}>Tap + to add an EPUB or PDF.</Text>
        </View>
      ) : visibleBooks.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.muted}>No books match.</Text>
          <Pressable
            onPress={() => {
              setSearch("");
              setFilter("all");
            }}
          >
            <Text style={styles.clearFilterLink}>Clear filters</Text>
          </Pressable>
        </View>
      ) : view === "grid" ? (
        <FlatList
          data={visibleBooks}
          numColumns={numColumns}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          key={`grid-${numColumns}`}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() =>
                queryClient.invalidateQueries({ queryKey: ["books"] })
              }
            />
          }
          renderItem={({ item }) => renderCard(item, handleBookPress)}
        />
      ) : (
        <FlatList
          data={visibleBooks}
          keyExtractor={(item) => item.id}
          key="list"
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() =>
                queryClient.invalidateQueries({ queryKey: ["books"] })
              }
            />
          }
          renderItem={({ item }) => renderRow(item, handleBookPress)}
        />
      )}
    </View>
  );
}

function renderCard(
  item: BookWithProgress,
  onPress: (b: BookWithProgress) => void,
) {
  const downloading = item.downloadProgress !== null;
  return (
    <Pressable style={styles.card} onPress={() => onPress(item)}>
      <View style={[styles.cover, !item.downloaded && styles.coverDimmed]}>
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.coverImage} />
        ) : (
          <Text style={styles.coverText} numberOfLines={3}>
            {item.title ?? "Untitled"}
          </Text>
        )}
        {item.downloaded ? (
          item.progressPct > 0 ? (
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(100, item.progressPct)}%` },
                ]}
              />
            </View>
          ) : null
        ) : downloading ? (
          <View style={styles.downloadOverlay}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.downloadOverlayText}>
              {Math.round((item.downloadProgress ?? 0) * 100)}%
            </Text>
          </View>
        ) : (
          <View style={styles.cloudBadge}>
            <Text style={styles.cloudBadgeText}>☁ Not downloaded</Text>
          </View>
        )}
      </View>
      <Text style={styles.bookTitle} numberOfLines={1}>
        {item.title ?? "Untitled"}
      </Text>
      <Text style={styles.bookAuthor} numberOfLines={1}>
        {item.author ?? "Unknown"}
      </Text>
    </Pressable>
  );
}

function renderRow(
  item: BookWithProgress,
  onPress: (b: BookWithProgress) => void,
) {
  const downloading = item.downloadProgress !== null;
  return (
    <Pressable style={styles.rowCard} onPress={() => onPress(item)}>
      <View style={[styles.rowCover, !item.downloaded && styles.coverDimmed]}>
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.coverImage} />
        ) : null}
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.title ?? "Untitled"}
        </Text>
        <Text style={styles.rowAuthor} numberOfLines={1}>
          {item.author ?? "Unknown"}
        </Text>
        <Text style={styles.rowStatus}>
          {!item.downloaded
            ? downloading
              ? `Downloading ${Math.round((item.downloadProgress ?? 0) * 100)}%`
              : "Tap to download"
            : item.progressPct >= 98
              ? "Finished"
              : item.progressPct > 0
                ? `${item.progressPct}% read`
                : "Not started"}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  heading: { fontSize: fontSize.xxl, fontWeight: "700" },
  topBarActions: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  iconText: { fontSize: 18, color: colors.text },
  syncChip: {
    backgroundColor: colors.backgroundSecondary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    minWidth: 80,
    alignItems: "center",
  },
  syncChipText: { fontSize: fontSize.xs, color: colors.text },
  uploadButton: {
    backgroundColor: colors.primary,
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  uploadButtonDisabled: { opacity: 0.5 },
  uploadButtonText: { color: colors.primaryFg, fontWeight: "700", fontSize: fontSize.xxl },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  searchInput: {
    flex: 1,
    backgroundColor: colors.backgroundSecondary,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.select({ ios: 10, android: 8 }),
    fontSize: 15,
    color: colors.text,
  },
  filterRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    gap: 6,
    flexDirection: "row",
    alignItems: "center",
    flexGrow: 1,
  },
  sortPill: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: 16,
  },
  sortPillText: { color: colors.primaryFg, fontSize: fontSize.xs, fontWeight: "600" },
  filterPill: {
    backgroundColor: colors.backgroundSecondary,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: 16,
  },
  filterPillActive: { backgroundColor: colors.filterActive },
  filterPillText: { color: colors.syncIcon, fontSize: fontSize.xs, fontWeight: "500" },
  filterPillTextActive: { color: colors.filterActiveText, fontWeight: "700" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xxl },
  muted: { color: colors.textMuted, textAlign: "center", marginBottom: spacing.xs },
  errorText: { color: colors.error },
  clearFilterLink: { color: "#2563eb", marginTop: spacing.sm, fontSize: fontSize.md },

  // Grid view
  grid: { padding: spacing.md },
  row: { gap: spacing.md },
  card: { flex: 1, marginBottom: spacing.lg },
  cover: {
    aspectRatio: 2 / 3,
    backgroundColor: colors.backgroundSecondary,
    borderRadius: 8,
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  coverImage: { width: "100%", height: "100%" },
  coverText: { padding: spacing.sm, fontSize: fontSize.xs, color: colors.textMuted, textAlign: "center" },
  progressTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: "rgba(0,0,0,0.12)",
  },
  progressFill: { height: "100%", backgroundColor: colors.primary },
  coverDimmed: { opacity: 0.55 },
  cloudBadge: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(17,17,17,0.75)",
    paddingVertical: spacing.xs,
    alignItems: "center",
  },
  cloudBadgeText: { color: colors.primaryFg, fontSize: 11, fontWeight: "600" },
  downloadOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(17,17,17,0.55)",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  downloadOverlayText: { color: colors.primaryFg, fontSize: fontSize.xs, fontWeight: "600" },
  bookTitle: { fontSize: fontSize.xs, fontWeight: "600", marginTop: spacing.xs },
  bookAuthor: { fontSize: 11, color: colors.textSecondary },

  // List view
  list: { padding: spacing.md, gap: spacing.sm },
  rowCard: {
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: 8,
    backgroundColor: "#fafafa",
  },
  rowCover: {
    width: 48,
    aspectRatio: 2 / 3,
    backgroundColor: colors.backgroundSecondary,
    borderRadius: 4,
    overflow: "hidden",
  },
  rowMeta: { flex: 1, justifyContent: "center" },
  rowTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  rowAuthor: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  rowStatus: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs },
});
