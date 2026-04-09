import { useEffect, useState } from "react";
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
} from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import { listBooks, uploadBook } from "../../lib/api";
import { getProgress } from "../../lib/local-db";
import type { Book } from "@readr/shared";

type BookWithProgress = Book & { progressPct: number };

export default function LibraryScreen() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, isRefetching } = useQuery({
    queryKey: ["books"],
    queryFn: () => listBooks(),
  });

  const rawBooks = data?.books ?? [];
  const [booksWithProgress, setBooksWithProgress] = useState<BookWithProgress[]>([]);
  const [uploading, setUploading] = useState(false);

  // Hydrate each book with its locally-stored progress percentage.
  // Runs whenever the server list changes.
  useEffect(() => {
    if (rawBooks.length === 0) {
      setBooksWithProgress([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        rawBooks.map(async (b): Promise<BookWithProgress> => {
          const p = await getProgress(b.id);
          return { ...b, progressPct: Math.round(p?.position.percentage ?? 0) };
        }),
      );
      if (!cancelled) setBooksWithProgress(results);
    })();
    return () => {
      cancelled = true;
    };
  }, [rawBooks]);

  function handleBookPress(book: Book) {
    router.push(`/reader/${book.id}`);
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

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error.message}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Text style={styles.heading}>Library</Text>
        <Pressable
          style={[styles.uploadButton, uploading && styles.uploadButtonDisabled]}
          onPress={handleUpload}
          disabled={uploading}
        >
          {uploading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.uploadButtonText}>+ Upload</Text>
          )}
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <Text style={styles.muted}>Loading library...</Text>
        </View>
      ) : booksWithProgress.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.muted}>No books yet.</Text>
          <Text style={styles.muted}>Tap Upload to add an EPUB or PDF.</Text>
        </View>
      ) : (
        <FlatList
          data={booksWithProgress}
          numColumns={3}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => queryClient.invalidateQueries({ queryKey: ["books"] })}
            />
          }
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => handleBookPress(item)}>
              <View style={styles.cover}>
                {item.coverUrl ? (
                  <Image source={{ uri: item.coverUrl }} style={styles.coverImage} />
                ) : (
                  <Text style={styles.coverText} numberOfLines={3}>
                    {item.title ?? "Untitled"}
                  </Text>
                )}
                {item.progressPct > 0 ? (
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${Math.min(100, item.progressPct)}%` },
                      ]}
                    />
                  </View>
                ) : null}
              </View>
              <Text style={styles.bookTitle} numberOfLines={1}>
                {item.title ?? "Untitled"}
              </Text>
              <Text style={styles.bookAuthor} numberOfLines={1}>
                {item.author ?? "Unknown"}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  heading: { fontSize: 22, fontWeight: "700" },
  uploadButton: {
    backgroundColor: "#111",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 88,
    alignItems: "center",
  },
  uploadButtonDisabled: { opacity: 0.5 },
  uploadButtonText: { color: "#fff", fontWeight: "600" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  muted: { color: "#999", textAlign: "center", marginBottom: 4 },
  errorText: { color: "#dc2626" },
  grid: { padding: 12 },
  row: { gap: 12 },
  card: { flex: 1, maxWidth: "33%", marginBottom: 16 },
  cover: {
    aspectRatio: 2 / 3,
    backgroundColor: "#f3f4f6",
    borderRadius: 8,
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  coverImage: { width: "100%", height: "100%" },
  coverText: { padding: 8, fontSize: 12, color: "#999", textAlign: "center" },
  progressTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: "rgba(0,0,0,0.12)",
  },
  progressFill: { height: "100%", backgroundColor: "#111" },
  bookTitle: { fontSize: 12, fontWeight: "600", marginTop: 4 },
  bookAuthor: { fontSize: 11, color: "#666" },
});
