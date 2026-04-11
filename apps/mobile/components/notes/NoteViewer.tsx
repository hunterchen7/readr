import { View, Text, Pressable, StyleSheet, Modal, ScrollView, Alert } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { Note, StrokePoint } from "@readr/shared";
import { useDisplay } from "../../contexts/DisplayContext";

interface NoteViewerProps {
  note: Note | null;
  onClose: () => void;
  onEdit: (note: Note) => void;
  onDelete: (id: string) => void;
  onJumpTo: (cfi: string) => void;
}

function pointsToPath(points: StrokePoint[]): string {
  if (points.length === 0) return "";
  const first = points[0];
  let d = `M${first.x.toFixed(1)},${first.y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L${points[i].x.toFixed(1)},${points[i].y.toFixed(1)}`;
  }
  return d;
}

export function NoteViewer({ note, onClose, onEdit, onDelete, onJumpTo }: NoteViewerProps) {
  const display = useDisplay();
  if (!note) return null;

  const confirmDelete = () => {
    Alert.alert("Delete note", "This note will be removed.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => onDelete(note.id) },
    ]);
  };

  return (
    <Modal
      visible={!!note}
      transparent
      animationType={display.animationsEnabled ? "fade" : "none"}
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.header}>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.headerBtn}>Close</Text>
            </Pressable>
            <Text style={styles.title}>
              {note.noteType === "typed" ? "Note" : "Drawing"}
            </Text>
            <Pressable onPress={() => onEdit(note)} hitSlop={8}>
              <Text style={[styles.headerBtn, styles.headerBtnPrimary]}>Edit</Text>
            </Pressable>
          </View>

          {note.noteType === "typed" ? (
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              <Text style={styles.bodyText}>{note.textContent ?? ""}</Text>
            </ScrollView>
          ) : (
            <View style={styles.drawingBody}>
              <Svg style={StyleSheet.absoluteFill}>
                {(note.strokes ?? []).map((s, i) => (
                  <Path
                    key={i}
                    d={pointsToPath(s.points)}
                    stroke={s.color}
                    strokeWidth={s.width}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                ))}
              </Svg>
            </View>
          )}

          <View style={styles.footer}>
            <Pressable
              style={styles.footerBtn}
              onPress={() => note.position.cfi && onJumpTo(note.position.cfi)}
              disabled={!note.position.cfi}
            >
              <Text style={[styles.footerBtnText, !note.position.cfi && { opacity: 0.4 }]}>
                Jump to passage
              </Text>
            </Pressable>
            <Pressable style={styles.footerBtn} onPress={confirmDelete}>
              <Text style={[styles.footerBtnText, { color: "#dc2626" }]}>Delete</Text>
            </Pressable>
          </View>
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
  headerBtn: { fontSize: 14, color: "#666" },
  headerBtnPrimary: { color: "#111", fontWeight: "600" },
  body: { maxHeight: 260 },
  bodyContent: { padding: 14 },
  bodyText: { fontSize: 15, lineHeight: 22, color: "#111" },
  drawingBody: { height: 260, backgroundColor: "#fafafa" },
  footer: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e0e0e0",
  },
  footerBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  footerBtnText: { fontSize: 14, color: "#111" },
});
