import { View, Text, Pressable, StyleSheet, Modal, ActivityIndicator } from "react-native";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@readr/shared";
import { Highlighter, Bookmark, StickyNote, Copy } from "lucide-react-native";
import { useDisplay } from "../../contexts/DisplayContext";
import { useEffect, useState } from "react";
import { lookupWord, type LookupResult } from "../../lib/dictionary";

interface ContextMenuProps {
  visible: boolean;
  selectedText: string;
  onClose: () => void;
  onHighlight: (color: HighlightColor) => void;
  onBookmark: () => void;
  onNote: () => void;
  onCopy: () => void;
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
  onClose,
  onHighlight,
  onBookmark,
  onNote,
  onCopy,
  onLookup,
  lookupProviders,
}: ContextMenuProps) {
  const display = useDisplay();
  const [showColors, setShowColors] = useState(false);
  const [offlineDef, setOfflineDef] = useState<LookupResult | null | undefined>(
    undefined, // undefined = not looked up yet, null = not found
  );

  // Whenever the user selects a single (or few) words, kick off an
  // offline dictionary lookup in the background so the definition is
  // ready to display if they tap "Define". Does NOT block the menu.
  useEffect(() => {
    if (!visible || !selectedText) {
      setOfflineDef(undefined);
      return;
    }
    // Only run on short-ish selections — no point dictionary-ing a
    // whole paragraph.
    const words = selectedText.trim().split(/\s+/);
    if (words.length > 3) {
      setOfflineDef(null);
      return;
    }
    let cancelled = false;
    lookupWord(words[0]).then((res) => {
      if (!cancelled) setOfflineDef(res);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, selectedText]);

  if (!visible) return null;

  const tapTarget = display.minTapTarget;

  return (
    <Modal transparent animationType={display.isEink ? "none" : "fade"} visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={[styles.menu, { bottom: 80 }]}>
        {offlineDef ? (
          <View style={styles.definitionBlock}>
            <View style={styles.definitionHeader}>
              <Text style={styles.definitionWord}>{offlineDef.word}</Text>
              {offlineDef.partOfSpeech ? (
                <Text style={styles.definitionPos}>{offlineDef.partOfSpeech}</Text>
              ) : null}
            </View>
            <Text style={styles.definitionText}>{offlineDef.definition}</Text>
          </View>
        ) : offlineDef === undefined ? (
          <View style={styles.definitionBlock}>
            <ActivityIndicator size="small" color="#666" />
          </View>
        ) : null}
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
                <Highlighter size={20} color="#444" />
                <Text style={styles.actionLabel}>Highlight</Text>
              </Pressable>
              <Pressable style={[styles.actionButton, { minHeight: tapTarget }]} onPress={onBookmark}>
                <Bookmark size={20} color="#444" />
                <Text style={styles.actionLabel}>Bookmark</Text>
              </Pressable>
              <Pressable style={[styles.actionButton, { minHeight: tapTarget }]} onPress={onNote}>
                <StickyNote size={20} color="#444" />
                <Text style={styles.actionLabel}>Note</Text>
              </Pressable>
              <Pressable style={[styles.actionButton, { minHeight: tapTarget }]} onPress={onCopy}>
                <Copy size={20} color="#444" />
                <Text style={styles.actionLabel}>Copy</Text>
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
                  <Text style={styles.searchLinkText}>{p.name}</Text>
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
  overlay: { flex: 1 },
  menu: {
    position: "absolute",
    left: 16,
    right: 16,
    backgroundColor: "#fff",
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    padding: 8,
  },
  definitionBlock: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    marginBottom: 6,
  },
  definitionHeader: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  definitionWord: { fontSize: 15, fontWeight: "700", color: "#111" },
  definitionPos: { fontSize: 11, color: "#888", fontStyle: "italic" },
  definitionText: { fontSize: 13, color: "#333", marginTop: 4, lineHeight: 18 },
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
