import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Image,
  RefreshControl,
} from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listBooks } from "../../lib/api";
import type { Book } from "@readr/shared";

export default function LibraryScreen() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, isRefetching } = useQuery({
    queryKey: ["books"],
    queryFn: () => listBooks(),
  });

  const books = data?.books ?? [];

  function handleBookPress(book: Book) {
    router.push(`/reader/${book.id}`);
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
      {isLoading ? (
        <View style={styles.center}>
          <Text style={styles.muted}>Loading library...</Text>
        </View>
      ) : books.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.muted}>No books yet.</Text>
          <Text style={styles.muted}>Upload books from the web dashboard.</Text>
        </View>
      ) : (
        <FlatList
          data={books}
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
  },
  coverImage: { width: "100%", height: "100%" },
  coverText: { padding: 8, fontSize: 12, color: "#999", textAlign: "center" },
  bookTitle: { fontSize: 12, fontWeight: "600", marginTop: 4 },
  bookAuthor: { fontSize: 11, color: "#666" },
});
