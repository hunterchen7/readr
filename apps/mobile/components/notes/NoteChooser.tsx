import { View, Text, Pressable, StyleSheet, Modal, FlatList } from "react-native";
import type { Note } from "@readr/shared";
import { useDisplay } from "../../contexts/DisplayContext";

interface NoteChooserProps {
  notes: Note[] | null;
  onPick: (note: Note) => void;
  onClose: () => void;
}

export function NoteChooser({ notes, onPick, onClose }: NoteChooserProps) {
  const display = useDisplay();
  if (!notes || notes.length === 0) return null;

  return (
    <Modal
      visible={!!notes}
      transparent
      animationType={display.animationsEnabled ? "fade" : "none"}
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{notes.length} notes here</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <FlatList
            data={notes}
            keyExtractor={(n) => n.id}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
            renderItem={({ item }) => (
              <Pressable style={styles.row} onPress={() => onPick(item)}>
                <Text style={styles.rowKind}>
                  {item.noteType === "typed" ? "Note" : "Drawing"}
                </Text>
                <Text style={styles.rowBody} numberOfLines={2}>
                  {item.noteType === "typed"
                    ? (item.textContent ?? "")
                    : `${(item.strokes ?? []).length} stroke${(item.strokes ?? []).length === 1 ? "" : "s"}`}
                </Text>
                <Text style={styles.rowDate}>
                  {new Date(item.createdAt).toLocaleString()}
                </Text>
              </Pressable>
            )}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.35)" },
  centerWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "70%",
    backgroundColor: "#fff",
    borderRadius: 14,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  title: { fontSize: 15, fontWeight: "600" },
  close: { fontSize: 16, color: "#666" },
  row: { paddingHorizontal: 14, paddingVertical: 12 },
  rowKind: { fontSize: 12, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 },
  rowBody: { fontSize: 14, color: "#111", marginTop: 2 },
  rowDate: { fontSize: 11, color: "#999", marginTop: 4 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: "#eee", marginLeft: 14 },
});
