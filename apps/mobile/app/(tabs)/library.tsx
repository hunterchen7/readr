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
import {
  getAllProgress,
  upsertCachedBooks,
  pruneCachedBooks,
  getCachedBooks,
} from "../../lib/local-db";
import { downloadBook, getDownloadedBookIds } from "../../lib/book-cache";
import { cacheCoversInBackground } from "../../lib/cover-cache";
import { DragDropUpload } from "../../components/upload/DragDropUpload";
import { useSyncStatus } from "../../lib/sync-status";
import { useNetworkStatus } from "../../lib/network-status";
import {
  useLibraryPrefs,
  SORT_SERVER_DEFAULT_DIR,
} from "../../lib/library-prefs";
import { useDisplay } from "../../contexts/DisplayContext";
import { LoadingIndicator } from "../../components/LoadingIndicator";
import { ErrorFallback } from "../../components/ErrorFallback";
import { colors, spacing, fontSize } from "../../lib/theme";
import {
  Search,
  X,
  LayoutGrid,
  List,
  RefreshCw,
  Plus,
  ArrowDown,
  ArrowUp,
  Download,
  CloudOff,
  BookOpen,
} from "lucide-react-native";
import type { Book } from "@readr/shared";

type BookWithProgress = Book & {
  progressPct: number;
  downloaded: boolean;
  /** 0..1 when a download is in flight, null when idle or done. */
  downloadProgress: number | null;
  /** ISO timestamp of the most recent progress update across all devices. */
  lastReadAt: string | null;
  /** Chapter label from the last saved position — shown in the Jump-back-in card. */
  lastReadChapter: string | null;
};

type SortKey = "recent" | "lastRead" | "title" | "author";
type FilterKey = "all" | "reading" | "unread" | "finished" | "downloaded";

const SORT_LABELS: Record<SortKey, string> = {
  recent: "Added",
  lastRead: "Last read",
  title: "Title",
  author: "Author",
};

const FILTER_LABELS: Record<FilterKey, string> = {
  all: "All",
  reading: "Reading",
  unread: "Unread",
  finished: "Finished",
  downloaded: "Downloaded",
};

/**
 * Picks a column count for the library grid from the current viewport
 * width. Aims for a card a bit under 200px wide, with a floor of 4
 * columns so phone layouts stay unchanged, and a ceiling of 8 so
 * ultra-wide desktops don't turn covers into tiny thumbnails. E-ink
 * stays pinned to 4 — the Supernote A5X is narrow and prefers
 * larger, higher-contrast tap targets.
 */
function pickGridColumns(screenWidth: number, isEink: boolean): number {
  if (isEink) return 4;
  return Math.min(8, Math.max(4, Math.floor(screenWidth / 180)));
}

function readingStatus(
  item: BookWithProgress,
): { label: string; tone: "reading" | "finished" | "unread" } | null {
  // Status reflects the book's reading state — independent of whether
  // its EPUB is currently cached on this device. A book at 47% on
  // another device shows "Reading · 47%" here too; the download state
  // is surfaced separately (cover badge / cover opacity) so the user
  // can tell at a glance which books need downloading to read offline
  // without losing the progress signal.
  if (item.progressPct >= 98) return { label: "Finished", tone: "finished" };
  if (item.progressPct > 0)
    return { label: `Reading · ${item.progressPct}%`, tone: "reading" };
  return { label: "Unread", tone: "unread" };
}

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
  const display = useDisplay();

  // Persisted UI prefs (sort, filter, view mode, last search)
  const sort = useLibraryPrefs((s) => s.sort);
  const sortDir = useLibraryPrefs((s) => s.sortDir);
  const filter = useLibraryPrefs((s) => s.filter);
  const view = useLibraryPrefs((s) => s.view);
  const setSort = useLibraryPrefs((s) => s.setSort);
  const setSortDir = useLibraryPrefs((s) => s.setSortDir);
  const setFilter = useLibraryPrefs((s) => s.setFilter);
  const setView = useLibraryPrefs((s) => s.setView);

  const { width: screenWidth } = useWindowDimensions();
  const gridColumns = useMemo(
    () => pickGridColumns(screenWidth, display.isEink),
    [screenWidth, display.isEink],
  );
  const gridCardWidth = useMemo(() => {
    const horizontalPadding = spacing.md * 2;
    const totalGap = spacing.md * (gridColumns - 1);
    return Math.floor(
      (screenWidth - horizontalPadding - totalGap) / gridColumns,
    );
  }, [screenWidth, gridColumns]);

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const { data, isLoading, error, isRefetching, refetch } = useQuery({
    queryKey: ["books", sort],
    // Local-first read: if the network call fails (offline, server
    // unreachable), fall back to whatever's in the local cache. We only
    // throw when both the network and the cache are empty, which is the
    // genuine "no books to show" state. Filters/searches still happen
    // client-side downstream from `rawBooks`, so the cache returning the
    // full library is fine — we don't need to re-apply the server's sort
    // because the client already re-sorts via SORT_SERVER_DEFAULT_DIR.
    queryFn: async () => {
      try {
        const result = await listBooks(sort);
        try {
          await upsertCachedBooks(result.books);
          if (sort === "recent") {
            await pruneCachedBooks(result.books.map((b) => b.id));
          }
          // Fire-and-forget cover download for any books we haven't
          // cached locally yet. The covers stay rendered from the
          // presigned URL until the local file lands; subsequent
          // listBooks() reads will return the file:// URL.
          cacheCoversInBackground(result.books);
        } catch (err) {
          console.warn("upsertCachedBooks failed:", err);
        }
        return result;
      } catch (networkErr) {
        const cached = await getCachedBooks();
        if (cached.length > 0) {
          // Tag the response so downstream code can tell it came from
          // the offline cache (e.g. to show a "stale" badge).
          return { books: cached, fromCache: true as const };
        }
        // Truly nothing to show — let React Query surface the error.
        throw networkErr;
      }
    },
  });

  const rawBooks = useMemo(() => data?.books ?? [], [data?.books]);
  const [booksWithProgress, setBooksWithProgress] = useState<
    BookWithProgress[]
  >([]);

  const syncPhase = useSyncStatus((s) => s.phase);
  const syncLastAt = useSyncStatus((s) => s.lastSyncAt);
  const syncLastError = useSyncStatus((s) => s.lastError);
  const runSyncNow = useSyncStatus((s) => s.sync);
  const isOnline = useNetworkStatus((s) => s.isOnline);
  const isNetHydrated = useNetworkStatus((s) => s.isHydrated);

  // Re-hydrate download/progress status when screen regains focus
  // (e.g. after downloading a book in the detail screen).
  const [focusCount, setFocusCount] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setFocusCount((c) => c + 1);
      // Pull remote changes before re-rendering so progress from
      // other devices lands in local SQLite first, then invalidate
      // the books query so the list reflects the new data. Failures
      // are non-fatal — the local cache still renders offline.
      runSyncNow()
        .catch(() => {})
        .finally(() => {
          queryClient.invalidateQueries({ queryKey: ["books"] });
        });
    }, [queryClient, runSyncNow]),
  );

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
          lastReadAt: p?.updatedAt ?? null,
          lastReadChapter: p?.position.chapterLabel ?? null,
        };
      });
      if (!cancelled) setBooksWithProgress(results);
    })();
    return () => {
      cancelled = true;
    };
  }, [rawBooks, focusCount]);

  // Apply filter + client-side search on top of the server-sorted list,
  // then reverse if the user flipped direction away from the server default.
  const visibleBooks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = booksWithProgress.filter((b) => {
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
      if (needle) {
        const hay = `${b.title ?? ""} ${b.author ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return sortDir === SORT_SERVER_DEFAULT_DIR[sort]
      ? filtered
      : filtered.toReversed();
  }, [booksWithProgress, filter, search, sort, sortDir]);

  // Most recently read, partially-finished book — shown in the "Jump
  // back in" card at the top of the library. Picked across ALL books
  // regardless of which device they're downloaded on, so the same
  // candidate appears on every device. If the book isn't on the local
  // device the card shows a download-and-resume affordance instead of
  // a one-tap resume.
  const resumeBook = useMemo(() => {
    let best: BookWithProgress | null = null;
    for (const b of booksWithProgress) {
      if (!b.lastReadAt) continue;
      if (b.progressPct <= 0 || b.progressPct >= 98) continue;
      if (!best || b.lastReadAt > (best.lastReadAt ?? "")) best = b;
    }
    return best;
  }, [booksWithProgress]);

  function handleResume(book: BookWithProgress) {
    // Downloaded → straight into the reader, the whole point of the
    // resume card is one tap. Not downloaded → detour through the
    // detail screen where the Download flow lives, so the user
    // doesn't tap "resume" and get a blank reader.
    if (Platform.OS !== "web" && !book.downloaded) {
      router.push(`/book/${book.id}`);
      return;
    }
    router.push(`/reader/${book.id}`);
  }

  async function handleDownload(bookId: string) {
    setBooksWithProgress((prev) =>
      prev.map((b) => (b.id === bookId ? { ...b, downloadProgress: 0 } : b)),
    );
    try {
      await downloadBook(bookId, (frac) => {
        setBooksWithProgress((prev) =>
          prev.map((b) =>
            b.id === bookId ? { ...b, downloadProgress: frac } : b,
          ),
        );
      });
      setBooksWithProgress((prev) =>
        prev.map((b) =>
          b.id === bookId
            ? { ...b, downloaded: true, downloadProgress: null }
            : b,
        ),
      );
    } catch (err) {
      setBooksWithProgress((prev) =>
        prev.map((b) =>
          b.id === bookId ? { ...b, downloadProgress: null } : b,
        ),
      );
      Alert.alert(
        "Download failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function handleBookPress(book: BookWithProgress) {
    // On native, a tap on an undownloaded book kicks off the download
    // in place (no detail-screen detour). Tapping mid-download is a
    // no-op since downloadProgress is non-null. On web there is no
    // local "downloaded" state — books stream from the server — so we
    // always route straight to the book detail screen.
    if (Platform.OS === "web") {
      router.push(`/book/${book.id}`);
      return;
    }
    // Finished books skip the download-on-tap shortcut — the user is
    // done with it, so tapping should just open the detail screen
    // where they can choose to re-download or delete.
    const finished = book.progressPct >= 98;
    if (!book.downloaded && !finished) {
      if (book.downloadProgress == null) {
        void handleDownload(book.id);
      }
      return;
    }
    router.push(`/book/${book.id}`);
  }

  /**
   * Upload one or more files to the server. Shared between the + button
   * (DocumentPicker / HTML file input) and the web drag-and-drop
   * overlay. Validates extension + size, posts sequentially, then
   * refetches the library.
   */
  async function handleFiles(
    files: Array<File | { uri: string; name: string; type: string }>,
  ) {
    if (files.length === 0) return;
    const MAX_SIZE_MB = 500;
    setUploading(true);
    try {
      for (const f of files) {
        const isFile = typeof File !== "undefined" && f instanceof File;
        const name = isFile ? (f as File).name : (f as { name: string }).name;
        const ext = name.split(".").pop()?.toLowerCase();
        if (ext !== "epub" && ext !== "pdf") {
          Alert.alert("Unsupported file", `${name} is not an EPUB or PDF.`);
          continue;
        }
        if (isFile && (f as File).size > MAX_SIZE_MB * 1024 * 1024) {
          Alert.alert("Too large", `${name} exceeds ${MAX_SIZE_MB} MB.`);
          continue;
        }
        await uploadBook(f);
      }
      await queryClient.invalidateQueries({ queryKey: ["books"] });
    } catch (err) {
      Alert.alert(
        "Upload failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleUpload() {
    // On web, `<input type="file">` gives us a proper File we can stream
    // through FormData. expo-document-picker also has web support, but
    // going through a native DOM input is simpler and matches the drop
    // zone's code path.
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".epub,.pdf,application/epub+zip,application/pdf";
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        void handleFiles(files);
      };
      input.click();
      return;
    }
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["application/epub+zip", "application/pdf", ".epub", ".pdf"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets[0]) return;
      const asset = picked.assets[0];
      await handleFiles([
        {
          uri: asset.uri,
          name: asset.name,
          type: asset.mimeType ?? "application/octet-stream",
        },
      ]);
    } catch (err) {
      Alert.alert(
        "Upload failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function cycleSort() {
    const order: SortKey[] = ["recent", "lastRead", "title", "author"];
    const next = order[(order.indexOf(sort) + 1) % order.length];
    setSort(next);
  }

  function toggleSortDir() {
    setSortDir(sortDir === "asc" ? "desc" : "asc");
  }

  if (error) {
    return (
      <ErrorFallback
        title="Couldn't load library"
        message={error.message}
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <DragDropUpload onFiles={(files) => void handleFiles(files)}>
    <View style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.heading}>Library</Text>
        <View style={styles.topBarActions}>
          <Pressable
            style={styles.iconButton}
            onPress={() => setSearchOpen((o) => !o)}
            accessibilityLabel={searchOpen ? "Close search" : "Search library"}
          >
            {searchOpen ? (
              <X size={20} color={colors.text} />
            ) : (
              <Search size={20} color={colors.text} />
            )}
          </Pressable>
          <Pressable
            style={styles.iconButton}
            onPress={() => setView(view === "grid" ? "list" : "grid")}
            accessibilityLabel={
              view === "grid" ? "Switch to list view" : "Switch to grid view"
            }
          >
            {view === "grid" ? (
              <List size={20} color={colors.text} />
            ) : (
              <LayoutGrid size={20} color={colors.text} />
            )}
          </Pressable>
          <Pressable
            style={[
              styles.syncChip,
              isNetHydrated && !isOnline && styles.syncChipOffline,
            ]}
            onPress={async () => {
              // Tap-to-retry is the path back online — runSyncNow() will
              // either succeed (and then NetInfo flips us back to online
              // through the next event) or no-op silently.
              await runSyncNow();
              queryClient.invalidateQueries({ queryKey: ["books"] });
            }}
            accessibilityLabel={
              isNetHydrated && !isOnline ? "Offline — tap to retry" : "Sync library"
            }
          >
            {syncPhase === "running" ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : isNetHydrated && !isOnline ? (
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                <CloudOff size={14} color={colors.syncError} />
                <Text style={[styles.syncChipText, styles.syncChipTextOffline]}>
                  Offline
                </Text>
              </View>
            ) : (
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                <RefreshCw
                  size={14}
                  color={syncLastError ? colors.syncError : colors.syncIcon}
                />
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
            style={[
              styles.uploadButton,
              uploading && styles.uploadButtonDisabled,
            ]}
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

      {resumeBook ? renderResumeCard(resumeBook, handleResume) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
        style={styles.filterScroll}
      >
        <Pressable style={styles.sortPill} onPress={cycleSort}>
          <Text style={styles.sortPillText} numberOfLines={1}>
            {SORT_LABELS[sort]}
          </Text>
        </Pressable>
        <Pressable
          style={styles.sortDirPill}
          onPress={toggleSortDir}
          accessibilityLabel={
            sortDir === "asc" ? "Sort ascending" : "Sort descending"
          }
        >
          {sortDir === "asc" ? (
            <ArrowUp size={14} color={colors.primaryFg} />
          ) : (
            <ArrowDown size={14} color={colors.primaryFg} />
          )}
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
              numberOfLines={1}
            >
              {FILTER_LABELS[key]}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {isLoading ? (
        <View style={styles.center}>
          <LoadingIndicator
            size="large"
            color={colors.textMuted}
            label="Loading library…"
          />
          {display.isEink ? null : (
            <Text style={[styles.muted, { marginTop: spacing.md }]}>
              Loading library...
            </Text>
          )}
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
          numColumns={gridColumns}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          // FlatList can't change numColumns without remounting, so
          // fold the column count into the key. Resizing a desktop
          // window picks up a new layout cleanly.
          key={`grid-${gridColumns}`}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() =>
                queryClient.invalidateQueries({ queryKey: ["books"] })
              }
            />
          }
          renderItem={({ item }) =>
            renderCard(item, handleBookPress, gridCardWidth, display.isEink)
          }
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
    </DragDropUpload>
  );
}

function renderResumeCard(
  item: BookWithProgress,
  onPress: (b: BookWithProgress) => void,
) {
  const pct = Math.min(100, Math.max(0, item.progressPct));
  const needsDownload = Platform.OS !== "web" && !item.downloaded;
  return (
    <Pressable style={styles.resumeCard} onPress={() => onPress(item)}>
      <View style={[styles.resumeCover, needsDownload && styles.coverDimmed]}>
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.coverImage} />
        ) : (
          <Text style={styles.resumeCoverText} numberOfLines={3}>
            {item.title ?? "Untitled"}
          </Text>
        )}
      </View>
      <View style={styles.resumeBody}>
        <Text style={styles.resumeLabel}>
          {needsDownload ? "Download to continue" : "Jump back in"}
        </Text>
        <Text style={styles.resumeTitle} numberOfLines={1}>
          {item.title ?? "Untitled"}
        </Text>
        {item.lastReadChapter ? (
          <Text style={styles.resumeChapter} numberOfLines={1}>
            {item.lastReadChapter}
          </Text>
        ) : null}
        <View style={styles.resumeProgressRow}>
          <View style={styles.resumeProgressTrack}>
            <View
              style={[styles.resumeProgressFill, { width: `${pct}%` }]}
            />
          </View>
          <Text style={styles.resumeProgressText}>{pct}%</Text>
        </View>
      </View>
      {needsDownload ? (
        <Download size={20} color={colors.primary} style={styles.resumeIcon} />
      ) : (
        <BookOpen size={20} color={colors.primary} style={styles.resumeIcon} />
      )}
    </Pressable>
  );
}

function renderCard(
  item: BookWithProgress,
  onPress: (b: BookWithProgress) => void,
  width: number,
  isEink: boolean,
) {
  const downloading = item.downloadProgress !== null;
  const status = readingStatus(item);
  const notDownloaded = Platform.OS !== "web" && !item.downloaded;
  return (
    <Pressable style={[styles.card, { width }]} onPress={() => onPress(item)}>
      <View style={[styles.cover, notDownloaded && styles.coverDimmed]}>
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.coverImage} />
        ) : (
          <Text style={styles.coverText} numberOfLines={3}>
            {item.title ?? "Untitled"}
          </Text>
        )}
        {notDownloaded && downloading ? (
          <View style={[styles.downloadOverlay, isEink && styles.downloadOverlayEink]}>
            <LoadingIndicator color="#fff" label="Downloading" />
            <Text style={styles.downloadOverlayText}>
              {Math.round((item.downloadProgress ?? 0) * 100)}%
            </Text>
          </View>
        ) : notDownloaded ? (
          // Small "not on this device" badge — keeps the progress pill
          // free to show actual reading state (Reading X% / Unread /
          // Finished) the same way a downloaded book does.
          <View style={styles.coverDownloadBadge}>
            <Download size={12} color="#fff" />
          </View>
        ) : null}
      </View>
      <Text style={styles.bookTitle} numberOfLines={1}>
        {item.title ?? "Untitled"}
      </Text>
      <Text style={styles.bookAuthor} numberOfLines={1}>
        {item.author ?? "Unknown"}
      </Text>
      {renderStatusPill(item, status, downloading)}
    </Pressable>
  );
}

function renderStatusPill(
  item: BookWithProgress,
  status: ReturnType<typeof readingStatus>,
  downloading: boolean,
) {
  // Active download still takes precedence — a download-in-progress
  // animation is the actionable signal users care about right then.
  if (downloading) {
    return (
      <View style={[styles.statusPill, styles.statusPillMuted]}>
        <View style={[styles.statusPillFill, { width: `${Math.round((item.downloadProgress ?? 0) * 100)}%` }]} />
        <View style={styles.statusPillRow}>
          <Text style={[styles.statusPillText, styles.statusPillTextNoPad]} numberOfLines={1}>
            {`Downloading ${Math.round((item.downloadProgress ?? 0) * 100)}%`}
          </Text>
        </View>
      </View>
    );
  }
  const fillPct =
    status?.tone === "finished" ? 100 : Math.min(100, item.progressPct);
  const finished = status?.tone === "finished";
  const unread = status?.tone === "unread";
  return (
    <View
      style={[
        styles.statusPill,
        finished && styles.statusPillFinished,
        unread && styles.statusPillUnread,
      ]}
    >
      {!unread && !finished ? (
        <View style={[styles.statusPillFill, { width: `${fillPct}%` }]} />
      ) : null}
      <Text
        style={[
          styles.statusPillText,
          finished && styles.statusPillTextFinished,
        ]}
        numberOfLines={1}
      >
        {status?.label ?? ""}
      </Text>
    </View>
  );
}

function renderRow(
  item: BookWithProgress,
  onPress: (b: BookWithProgress) => void,
) {
  const downloading = item.downloadProgress !== null;
  const status = readingStatus(item);
  const notDownloaded = Platform.OS !== "web" && !item.downloaded;
  return (
    <Pressable style={styles.rowCard} onPress={() => onPress(item)}>
      <View style={[styles.rowCover, notDownloaded && styles.coverDimmed]}>
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.coverImage} />
        ) : null}
        {notDownloaded && !downloading ? (
          <View style={styles.coverDownloadBadge}>
            <Download size={12} color="#fff" />
          </View>
        ) : null}
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.title ?? "Untitled"}
        </Text>
        <Text style={styles.rowAuthor} numberOfLines={1}>
          {item.author ?? "Unknown"}
        </Text>
        {downloading ? (
          <View style={styles.rowStatusDownload}>
            <Text style={styles.rowStatus}>
              {`Downloading ${Math.round((item.downloadProgress ?? 0) * 100)}%`}
            </Text>
          </View>
        ) : (
          <Text
            style={[
              styles.rowStatus,
              status?.tone === "reading" && styles.rowStatusReading,
            ]}
          >
            {status?.label ?? ""}
          </Text>
        )}
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
  topBarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
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
  // Visual treatment for the offline state — bordered chip with a
  // muted background so the user can spot it at a glance without it
  // looking like an error.
  syncChipOffline: {
    borderWidth: 1,
    borderColor: colors.syncError,
    backgroundColor: colors.background,
  },
  syncChipText: { fontSize: fontSize.xs, color: colors.text },
  syncChipTextOffline: { color: colors.syncError, fontWeight: "600" },
  uploadButton: {
    backgroundColor: colors.primary,
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  uploadButtonDisabled: { opacity: 0.5 },
  uploadButtonText: {
    color: colors.primaryFg,
    fontWeight: "700",
    fontSize: fontSize.xxl,
  },
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
  filterScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  filterRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    gap: 6,
    flexDirection: "row",
    alignItems: "center",
  },
  sortPill: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: 16,
    flexShrink: 0,
  },
  sortDirPill: {
    backgroundColor: colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 16,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  sortPillText: {
    color: colors.primaryFg,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  filterPill: {
    backgroundColor: colors.backgroundSecondary,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: 16,
    flexShrink: 0,
  },
  filterPillActive: { backgroundColor: colors.filterActive },
  filterPillText: {
    color: colors.syncIcon,
    fontSize: fontSize.xs,
    fontWeight: "500",
  },
  filterPillTextActive: { color: colors.filterActiveText, fontWeight: "700" },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xxl,
  },
  muted: {
    color: colors.textMuted,
    textAlign: "center",
    marginBottom: spacing.xs,
  },
  errorText: { color: colors.error },
  clearFilterLink: {
    color: "#2563eb",
    marginTop: spacing.sm,
    fontSize: fontSize.md,
  },

  // Grid view
  grid: { padding: spacing.md },
  row: {
    gap: spacing.md,
    justifyContent: "flex-start",
    alignItems: "flex-start",
  },
  card: { marginBottom: spacing.lg },
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
  coverText: {
    padding: spacing.sm,
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: "center",
  },
  statusPill: {
    marginTop: 6,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: "#ffffff",
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "center",
  },
  statusPillFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.primary,
    opacity: 0.22,
  },
  statusPillText: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    paddingHorizontal: 6,
  },
  statusPillRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
  },
  statusPillTextNoPad: {
    paddingHorizontal: 0,
  },
  statusPillMuted: {
    backgroundColor: colors.backgroundSecondary,
  },
  statusPillUnread: {
    backgroundColor: colors.backgroundSecondary,
  },
  statusPillFinished: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  statusPillTextFinished: {
    color: colors.primaryFg,
  },
  coverDimmed: { opacity: 0.55 },
  // Small badge in the top-right of a non-downloaded book's cover.
  // Tells the user "this book lives on the server, you'll need to
  // download it to read offline" without sacrificing the progress
  // pill below the cover.
  coverDownloadBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  downloadOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(17,17,17,0.55)",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  // Solid black overlay for e-ink — the translucent tint would smudge into
  // a near-invisible gray on a ~16-level grayscale panel.
  downloadOverlayEink: { backgroundColor: "#000" },
  downloadOverlayText: {
    color: colors.primaryFg,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  bookTitle: {
    fontSize: fontSize.xs,
    fontWeight: "600",
    marginTop: spacing.xs,
  },
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
  rowAuthor: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: 2,
  },
  rowStatus: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs },
  rowStatusReading: { color: colors.primary, fontWeight: "600" },
  rowStatusDownload: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: spacing.xs,
  },

  // "Jump back in" shortcut card — compact row right under the header
  // so one tap puts you back where you were. Always visible when a
  // resume candidate exists.
  resumeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: 10,
    backgroundColor: colors.backgroundSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  resumeCover: {
    width: 40,
    aspectRatio: 2 / 3,
    backgroundColor: colors.backgroundSecondary,
    borderRadius: 4,
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "center",
  },
  resumeCoverText: {
    padding: 2,
    fontSize: 8,
    color: colors.textMuted,
    textAlign: "center",
  },
  resumeBody: {
    flex: 1,
    minWidth: 0,
  },
  resumeLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: colors.primary,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  resumeTitle: {
    fontSize: fontSize.sm,
    fontWeight: "700",
    color: colors.text,
    marginTop: 1,
  },
  resumeChapter: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1,
    fontStyle: "italic",
  },
  resumeProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 4,
  },
  resumeProgressTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.borderLight,
    overflow: "hidden",
  },
  resumeProgressFill: {
    height: "100%",
    backgroundColor: colors.primary,
  },
  resumeProgressText: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: "600",
    minWidth: 28,
    textAlign: "right",
  },
  resumeIcon: {
    alignSelf: "center",
    marginRight: 4,
  },
});
