import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  ScrollView,
  Image as RNImage,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useState } from "react";
import Svg, { Path } from "react-native-svg";
import { X, Pencil, Trash2 } from "lucide-react-native";
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
  passageText?: string;
  onClose: () => void;
  onEdit: (note: Note, passageText?: string) => void;
  onDelete: (id: string) => void;
}

const POPOVER_GAP = 8;
const SCREEN_PADDING = 8;
const POPOVER_MAX_WIDTH = 360;

// Compact relative timestamp for the note footer. Drops to an absolute
// date once we're past a week — "8d ago" / "47d ago" reads worse than
// "Mar 14".
function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const ago = Math.max(0, Date.now() - ts);
  const mins = Math.floor(ago / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
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

export function NoteViewer({ note, anchorRect, passageText, onClose, onEdit, onDelete }: NoteViewerProps) {
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

        {passageText ? (
          <View style={styles.passageBar}>
            <Text style={styles.passageText} numberOfLines={2}>
              &ldquo;{passageText}&rdquo;
            </Text>
          </View>
        ) : null}

        {note.noteType === "typed" ? (
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <Text style={styles.bodyText}>{note.textContent ?? ""}</Text>
          </ScrollView>
        ) : note.canvasImage ? (
          <View style={styles.drawingBody}>
            <RNImage
              source={{ uri: note.canvasImage }}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
          </View>
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
          <Text style={styles.timestamp} numberOfLines={1}>
            {formatRelative(note.updatedAt ?? note.createdAt ?? "")}
          </Text>
          <View style={styles.footerActions}>
            <Pressable
              style={styles.iconBtn}
              onPress={() => onEdit(note, passageText)}
              hitSlop={10}
              accessibilityLabel="Edit"
            >
              <Pencil size={16} color="#111" />
            </Pressable>
            <Pressable
              style={styles.iconBtn}
              onPress={() => onDelete(note.id)}
              hitSlop={10}
              accessibilityLabel="Delete"
            >
              <Trash2 size={16} color="#dc2626" />
            </Pressable>
          </View>
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
  passageBar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
    backgroundColor: "#f9f9f9",
  },
  passageText: {
    fontSize: 12,
    color: "#666",
    fontStyle: "italic",
    lineHeight: 16,
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
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e0e0e0",
  },
  timestamp: {
    fontSize: 12,
    color: "#888",
    flexShrink: 1,
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  iconBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
});
