import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  ScrollView,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useState } from "react";
import Svg, { Path } from "react-native-svg";
import { X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Note, StrokePoint } from "@readr/shared";
import { useDisplay } from "../../contexts/DisplayContext";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface NoteViewerProps {
  note: Note | null;
  anchorRect: Rect | null;
  onClose: () => void;
  onEdit: (note: Note) => void;
  onDelete: (id: string) => void;
}

const POPOVER_GAP = 8;
const SCREEN_PADDING = 8;
const POPOVER_MAX_WIDTH = 360;

function pointsToPath(points: StrokePoint[]): string {
  if (points.length === 0) return "";
  const first = points[0];
  let d = `M${first.x.toFixed(1)},${first.y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L${points[i].x.toFixed(1)},${points[i].y.toFixed(1)}`;
  }
  return d;
}

// Compute the bounding box of every stroke so we can fit them into a
// viewBox. Drawings are captured at the canvas resolution used when
// creating the note, which can be much larger than the viewer popover.
// Padding keeps the strokes from kissing the edges.
function strokesBBox(
  strokes: { points: StrokePoint[]; width: number }[],
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const s of strokes) {
    const half = (s.width ?? 2) / 2;
    for (const p of s.points) {
      any = true;
      if (p.x - half < minX) minX = p.x - half;
      if (p.y - half < minY) minY = p.y - half;
      if (p.x + half > maxX) maxX = p.x + half;
      if (p.y + half > maxY) maxY = p.y + half;
    }
  }
  if (!any) return null;
  const pad = 4;
  return {
    x: minX - pad,
    y: minY - pad,
    w: Math.max(1, maxX - minX + pad * 2),
    h: Math.max(1, maxY - minY + pad * 2),
  };
}

export function NoteViewer({ note, anchorRect, onClose, onEdit, onDelete }: NoteViewerProps) {
  const display = useDisplay();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const { width: screenW, height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  if (!note) return null;

  // Position mirrors ContextMenu: below the anchor by default, flip
  // above if it overflows the bottom, fall back to pinned-bottom if
  // neither fits.
  const safeTop = insets.top + SCREEN_PADDING;
  const safeBottom = screenH - insets.bottom - SCREEN_PADDING;
  const safeLeft = SCREEN_PADDING;
  const safeRight = screenW - SCREEN_PADDING;
  const popW = size?.w ?? Math.min(POPOVER_MAX_WIDTH, screenW - SCREEN_PADDING * 2);
  const popH = size?.h ?? 200;

  let top: number;
  let left: number;
  if (anchorRect) {
    const below = anchorRect.y + anchorRect.h + POPOVER_GAP;
    const above = anchorRect.y - POPOVER_GAP - popH;
    if (below + popH <= safeBottom) {
      top = below;
    } else if (above >= safeTop) {
      top = above;
    } else {
      top = safeBottom - popH;
    }
    const centerX = anchorRect.x + anchorRect.w / 2;
    left = centerX - popW / 2;
    if (left < safeLeft) left = safeLeft;
    if (left + popW > safeRight) left = safeRight - popW;
  } else {
    top = safeBottom - popH;
    left = (screenW - popW) / 2;
  }

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!size || Math.abs(size.w - width) > 1 || Math.abs(size.h - height) > 1) {
      setSize({ w: width, h: height });
    }
  };

  return (
    <Modal
      visible={!!note}
      transparent
      animationType={display.animationsEnabled ? "fade" : "none"}
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View
        onLayout={onLayout}
        style={[
          styles.popover,
          display.isEink && styles.popoverEink,
          {
            top,
            left,
            width: popW,
            maxWidth: POPOVER_MAX_WIDTH,
            opacity: size ? 1 : 0,
          },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.title}>
            {note.noteType === "typed" ? "Note" : "Drawing"}
          </Text>
          <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
            <X size={16} color="#666" />
          </Pressable>
        </View>

        {note.noteType === "typed" ? (
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <Text style={styles.bodyText}>{note.textContent ?? ""}</Text>
          </ScrollView>
        ) : (
          <View style={styles.drawingBody}>
            {(() => {
              const strokes = note.strokes ?? [];
              const bbox = strokesBBox(strokes);
              const viewBox = bbox
                ? `${bbox.x} ${bbox.y} ${bbox.w} ${bbox.h}`
                : undefined;
              return (
                <Svg style={StyleSheet.absoluteFill} viewBox={viewBox}>
                  {strokes.map((s, i) => (
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
              );
            })()}
          </View>
        )}

        <View style={styles.footer}>
          <Pressable style={styles.footerBtn} onPress={() => onEdit(note)}>
            <Text style={[styles.footerBtnText, styles.footerBtnTextPrimary]}>Edit</Text>
          </Pressable>
          <View style={styles.footerDivider} />
          <Pressable style={styles.footerBtn} onPress={() => onDelete(note.id)}>
            <Text style={[styles.footerBtnText, { color: "#dc2626" }]}>Delete</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject },
  popover: {
    position: "absolute",
    backgroundColor: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
  },
  popoverEink: {
    shadowOpacity: 0,
    elevation: 0,
    borderWidth: 2,
    borderColor: "#000",
    borderRadius: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  title: { fontSize: 13, fontWeight: "600", color: "#111" },
  closeBtn: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { maxHeight: 220 },
  bodyContent: { padding: 12 },
  bodyText: { fontSize: 14, lineHeight: 20, color: "#111" },
  drawingBody: { height: 220, backgroundColor: "#fafafa" },
  footer: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e0e0e0",
  },
  footerBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  footerBtnText: { fontSize: 14, color: "#111" },
  footerBtnTextPrimary: { fontWeight: "600" },
  footerDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: "#e0e0e0",
  },
});
