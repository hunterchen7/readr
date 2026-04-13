import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@readr/shared";
import {
  Highlighter,
  StickyNote,
  Copy,
  BookText,
  Pencil,
} from "lucide-react-native";
import { useDisplay } from "../../contexts/DisplayContext";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const MENU_GAP = 8;
const SCREEN_PADDING = 8;
const MENU_MAX_WIDTH = 360;

interface SelectionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ContextMenuProps {
  visible: boolean;
  selectedText: string;
  anchorRect?: SelectionRect | null;
  onClose: () => void;
  onHighlight: (color: HighlightColor) => void;
  onNote: () => void;
  onDraw: () => void;
  onCopy: () => void;
  onDefine: () => void;
  onLookup: (provider: string) => void;
  lookupProviders: { name: string; icon: string; urlTemplate: string }[];
}

const COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
  purple: "Purple",
};

const COLOR_HEX: Record<HighlightColor, string> = {
  yellow: "#fef08a",
  green: "#bbf7d0",
  blue: "#bfdbfe",
  pink: "#fbcfe8",
  purple: "#ddd6fe",
};

// E-ink underline styles (no color available)
const EINK_UNDERLINE: Record<HighlightColor, string> = {
  yellow: "solid",
  green: "dashed",
  blue: "double",
  pink: "dotted",
  purple: "wavy",
};

export function ContextMenu({
  visible,
  selectedText,
  anchorRect,
  onClose,
  onHighlight,
  onNote,
  onDraw,
  onCopy,
  onDefine,
  onLookup,
  lookupProviders,
}: ContextMenuProps) {
  const display = useDisplay();
  const [showColors, setShowColors] = useState(false);
  const [menuSize, setMenuSize] = useState<{ w: number; h: number } | null>(null);
  const { width: screenW, height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  const tapTarget = display.minTapTarget;
  // On e-ink everything collapses to crisp black; on LCD use the existing
  // muted gray palette the menu was designed with.
  const iconColor = display.isEink ? "#000" : "#444";
  const linkColor = display.isEink ? "#000" : "#2563eb";

  // Compute menu position. Prefer above the selection — the top edge of the
  // selection rect is stable while the user drags the bottom handle, so the
  // menu doesn't jump around mid-selection. Fall back to below if above
  // would clip the notch/status bar, then pin to bottom as a last resort.
  const safeTop = insets.top + SCREEN_PADDING;
  const safeBottom = screenH - insets.bottom - SCREEN_PADDING;
  const safeLeft = SCREEN_PADDING;
  const safeRight = screenW - SCREEN_PADDING;
  const menuW = menuSize?.w ?? Math.min(MENU_MAX_WIDTH, screenW - SCREEN_PADDING * 2);
  const menuH = menuSize?.h ?? 120;

  let top: number;
  let left: number;
  if (anchorRect) {
    const above = anchorRect.y - MENU_GAP - menuH;
    if (above >= safeTop) {
      top = above;
    } else {
      // Selection is near the top — tuck the menu just below the
      // selection with a ~1.5 line gap so the highlighted text stays
      // readable without the menu feeling disconnected.
      top = Math.min(anchorRect.y + anchorRect.h + 30, safeBottom - menuH);
    }
    const centerX = anchorRect.x + anchorRect.w / 2;
    left = centerX - menuW / 2;
    if (left < safeLeft) left = safeLeft;
    if (left + menuW > safeRight) left = safeRight - menuW;
  } else {
    top = safeTop;
    left = (screenW - menuW) / 2;
  }

  const onMenuLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!menuSize || Math.abs(menuSize.w - width) > 1 || Math.abs(menuSize.h - height) > 1) {
      setMenuSize({ w: width, h: height });
    }
  };

  return (
    <Modal transparent animationType={display.isEink ? "none" : "fade"} visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View
        onLayout={onMenuLayout}
        style={[
          styles.menu,
          display.isEink && styles.menuEink,
          { top, left, maxWidth: MENU_MAX_WIDTH, width: menuW, opacity: menuSize ? 1 : 0 },
        ]}
      >
        {showColors ? (
          <View style={styles.colorRow}>
            {HIGHLIGHT_COLORS.map((color) => (
              <Pressable
                key={color}
                style={[
                  styles.colorButton,
                  { minHeight: tapTarget, minWidth: tapTarget },
                  display.isEink
                    ? { borderWidth: 2, borderColor: "#000", borderStyle: EINK_UNDERLINE[color] as "solid" | "dashed" | "dotted" }
                    : { backgroundColor: COLOR_HEX[color] },
                ]}
                onPress={() => {
                  onHighlight(color);
                  setShowColors(false);
                }}
              >
                <Text style={styles.colorLabel}>
                  {display.isEink ? EINK_UNDERLINE[color] : COLOR_LABELS[color]}
                </Text>
              </Pressable>
            ))}
            <Pressable style={styles.cancelButton} onPress={() => setShowColors(false)}>
              <Text>✕</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* Main action buttons */}
            <View style={styles.actionRow}>
              <Pressable style={[styles.actionButton, { minHeight: tapTarget }]} onPress={() => setShowColors(true)}>
                <Highlighter size={20} color={iconColor} />
                <Text style={[styles.actionLabel, display.isEink && styles.actionLabelEink]}>Highlight</Text>
              </Pressable>
              <Pressable style={[styles.actionButton, { minHeight: tapTarget }]} onPress={onDefine}>
                <BookText size={20} color={iconColor} />
                <Text style={[styles.actionLabel, display.isEink && styles.actionLabelEink]}>Define</Text>
              </Pressable>
              <Pressable style={[styles.actionButton, { minHeight: tapTarget }]} onPress={onNote}>
                <StickyNote size={20} color={iconColor} />
                <Text style={[styles.actionLabel, display.isEink && styles.actionLabelEink]}>Note</Text>
              </Pressable>
              <Pressable style={[styles.actionButton, { minHeight: tapTarget }]} onPress={onDraw}>
                <Pencil size={20} color={iconColor} />
                <Text style={[styles.actionLabel, display.isEink && styles.actionLabelEink]}>Draw</Text>
              </Pressable>
              <Pressable style={[styles.actionButton, { minHeight: tapTarget }]} onPress={onCopy}>
                <Copy size={20} color={iconColor} />
                <Text style={[styles.actionLabel, display.isEink && styles.actionLabelEink]}>Copy</Text>
              </Pressable>
            </View>
            {/* Inline search links */}
            <View style={styles.searchRow}>
              {lookupProviders.map((p) => (
                <Pressable
                  key={p.name}
                  style={styles.searchLink}
                  onPress={() => onLookup(p.urlTemplate.replace("{{query}}", encodeURIComponent(selectedText)))}
                >
                  <Text style={[styles.searchLinkText, { color: linkColor }, display.isEink && styles.searchLinkTextEink]}>
                    {p.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject },
  menu: {
    position: "absolute",
    backgroundColor: "#fff",
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    padding: 8,
  },
  // On e-ink, drop the soft drop-shadow (ghosts badly) and use a solid
  // black border instead so the menu still reads as a distinct panel.
  menuEink: {
    shadowOpacity: 0,
    elevation: 0,
    borderWidth: 2,
    borderColor: "#000",
    borderRadius: 0,
  },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, justifyContent: "center" },
  actionButton: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionIcon: { marginBottom: 2 },
  actionLabel: { fontSize: 11, color: "#666" },
  actionLabelEink: { color: "#000", fontWeight: "600" },
  searchRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
    paddingTop: 6,
    paddingBottom: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#eee",
  },
  searchLink: { paddingVertical: 4 },
  searchLinkText: { fontSize: 12, color: "#2563eb" },
  searchLinkTextEink: { textDecorationLine: "underline", fontWeight: "600" },
  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center", padding: 8 },
  colorButton: {
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  colorLabel: { fontSize: 11 },
  cancelButton: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
