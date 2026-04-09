import { Modal, View, Text, FlatList, Pressable, StyleSheet, Alert } from "react-native";
import type { Note, Highlight, Bookmark, BookPosition } from "@readr/shared";
import { exportAnnotations } from "../../lib/export-annotations";

interface NotesPanelProps {
  visible: boolean;
  bookTitle: string;
  bookAuthor: string | null;
  notes: Note[];
  highlights: Highlight[];
  bookmarks: Bookmark[];
  onClose: () => void;
  onJumpTo: (position: BookPosition | { cfi: string }) => void;
}

/**
 * Read-only review panel shown from the reader's header menu. Lists the
 * user's highlights and typed/handwritten notes for the current book,
 * sorted most-recent-first. Tapping an item jumps the reader to the
 * matching CFI or percentage position.
 */
export function NotesPanel({
  visible,
  bookTitle,
  bookAuthor,
  notes,
  highlights,
  bookmarks,
  onClose,
  onJumpTo,
}: NotesPanelProps) {
  async function handleExport(format: "markdown" | "json") {
    try {
      await exportAnnotations({
        bookTitle,
        bookAuthor,
        highlights,
        notes,
        bookmarks,
        format,
      });
    } catch (err) {
      Alert.alert(
        "Export failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  // Merge and tag so a single list covers both.
  type Row =
    | {
        kind: "highlight";
        id: string;
        createdAt: string;
        textContent: string | null;
        note: string | null;
        color: string;
        cfiRange: string;
      }
    | {
        kind: "note";
        id: string;
        createdAt: string;
        noteType: "typed" | "handwritten";
        textContent: string | null;
        position: BookPosition;
      };

  const rows: Row[] = [
    ...highlights.map<Row>((h) => ({
      kind: "highlight",
      id: h.id,
      createdAt: h.createdAt,
      textContent: h.textContent,
      note: h.note,
      color: h.color,
      cfiRange: h.cfiRange,
    })),
    ...notes.map<Row>((n) => ({
      kind: "note",
      id: n.id,
      createdAt: n.createdAt ?? "",
      noteType: n.noteType,
      textContent: n.textContent,
      position: n.position,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <Modal transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.title}>Notes & Highlights</Text>
          <View style={styles.headerActions}>
            <Pressable
              style={styles.exportBtn}
              onPress={() => handleExport("markdown")}
              disabled={highlights.length + notes.length + bookmarks.length === 0}
            >
              <Text style={styles.exportBtnText}>Export MD</Text>
            </Pressable>
            <Pressable
              style={styles.exportBtn}
              onPress={() => handleExport("json")}
              disabled={highlights.length + notes.length + bookmarks.length === 0}
            >
              <Text style={styles.exportBtnText}>JSON</Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={16}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
        </View>
        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No highlights or notes yet.</Text>
            <Text style={styles.emptyHint}>
              Long-press text in the reader to highlight or annotate.
            </Text>
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(r) => `${r.kind}-${r.id}`}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <Pressable
                style={styles.row}
                onPress={() => {
                  if (item.kind === "highlight") {
                    onJumpTo({ cfi: item.cfiRange });
                  } else {
                    onJumpTo(item.position);
                  }
                  onClose();
                }}
              >
                <View style={styles.rowMeta}>
                  <Text style={styles.rowKind}>
                    {item.kind === "highlight"
                      ? `Highlight · ${item.color}`
                      : `Note · ${item.noteType}`}
                  </Text>
                  <Text style={styles.rowDate}>
                    {new Date(item.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                {item.kind === "highlight" ? (
                  <>
                    {item.textContent ? (
                      <Text style={styles.highlightText} numberOfLines={4}>
                        “{item.textContent}”
                      </Text>
                    ) : null}
                    {item.note ? (
                      <Text style={styles.noteText} numberOfLines={3}>
                        {item.note}
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.noteText} numberOfLines={4}>
                    {item.textContent ?? "(handwritten)"}
                  </Text>
                )}
              </Pressable>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.3)" },
  panel: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "75%",
    paddingBottom: 24,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  title: { fontSize: 16, fontWeight: "700" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  exportBtn: {
    backgroundColor: "#f3f4f6",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  exportBtnText: { fontSize: 12, color: "#333", fontWeight: "600" },
  close: { fontSize: 20, color: "#666", marginLeft: 4 },
  empty: { padding: 32, alignItems: "center" },
  emptyText: { fontSize: 15, color: "#333" },
  emptyHint: { fontSize: 12, color: "#999", marginTop: 6, textAlign: "center" },
  list: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  row: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  rowMeta: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  rowKind: { fontSize: 11, color: "#666", textTransform: "uppercase" },
  rowDate: { fontSize: 11, color: "#999" },
  highlightText: { fontSize: 14, color: "#222", fontStyle: "italic", lineHeight: 20 },
  noteText: { fontSize: 14, color: "#222", marginTop: 6, lineHeight: 20 },
});
