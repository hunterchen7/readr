import { View, Text, Pressable, StyleSheet, Modal, FlatList, TextInput } from "react-native";
import { useState } from "react";

export interface ReaderTheme {
  bg: string;
  fg: string;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
}

export const DEFAULT_THEME: ReaderTheme = {
  bg: "#ffffff",
  fg: "#111111",
  fontSize: 18,
  lineHeight: 1.6,
  fontFamily: "Georgia, serif",
};

const THEME_PRESETS = [
  { label: "Light", bg: "#ffffff", fg: "#111111" },
  { label: "Sepia", bg: "#f8f0e3", fg: "#5b4636" },
  { label: "Dark", bg: "#1a1a2e", fg: "#e0e0e0" },
  { label: "E-ink", bg: "#ffffff", fg: "#000000" },
] as const;

interface TocItem {
  label: string;
  href: string;
  depth: number;
}

interface ReaderControlsProps {
  visible: boolean;
  theme: ReaderTheme;
  toc: TocItem[];
  progress: number;
  onClose: () => void;
  onThemeChange: (theme: ReaderTheme) => void;
  onGoToChapter: (href: string) => void;
  onSearch: (query: string) => void;
}

export function ReaderControls({
  visible,
  theme,
  toc,
  progress,
  onClose,
  onThemeChange,
  onGoToChapter,
  onSearch,
}: ReaderControlsProps) {
  const [tab, setTab] = useState<"theme" | "toc" | "search">("theme");
  const [searchQuery, setSearchQuery] = useState("");

  if (!visible) return null;

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={styles.panel}>
        <View style={styles.tabs}>
          {(["theme", "toc", "search"] as const).map((t) => (
            <Pressable
              key={t}
              style={[styles.tab, tab === t && styles.tabActive]}
              onPress={() => setTab(t)}
            >
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t === "theme" ? "Theme" : t === "toc" ? "Contents" : "Search"}
              </Text>
            </Pressable>
          ))}
        </View>

        {tab === "theme" ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Preset</Text>
            <View style={styles.presetRow}>
              {THEME_PRESETS.map((p) => (
                <Pressable
                  key={p.label}
                  style={[
                    styles.presetButton,
                    { backgroundColor: p.bg, borderColor: p.bg === theme.bg ? "#111" : "#ddd" },
                  ]}
                  onPress={() => onThemeChange({ ...theme, bg: p.bg, fg: p.fg })}
                >
                  <Text style={{ color: p.fg, fontSize: 12 }}>{p.label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sectionLabel}>Font Size: {theme.fontSize}px</Text>
            <View style={styles.sizeRow}>
              <Pressable
                style={styles.sizeButton}
                onPress={() => onThemeChange({ ...theme, fontSize: Math.max(12, theme.fontSize - 1) })}
              >
                <Text style={styles.sizeButtonText}>A-</Text>
              </Pressable>
              <Pressable
                style={styles.sizeButton}
                onPress={() => onThemeChange({ ...theme, fontSize: Math.min(32, theme.fontSize + 1) })}
              >
                <Text style={styles.sizeButtonText}>A+</Text>
              </Pressable>
            </View>

            <Text style={styles.progressText}>{progress}% read</Text>
          </View>
        ) : tab === "toc" ? (
          <FlatList
            data={toc}
            keyExtractor={(_, i) => String(i)}
            style={styles.tocList}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.tocItem, { paddingLeft: 16 + item.depth * 16 }]}
                onPress={() => {
                  onGoToChapter(item.href);
                  onClose();
                }}
              >
                <Text style={styles.tocLabel} numberOfLines={1}>
                  {item.label}
                </Text>
              </Pressable>
            )}
          />
        ) : (
          <View style={styles.section}>
            <View style={styles.searchRow}>
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search in book..."
                returnKeyType="search"
                onSubmitEditing={() => onSearch(searchQuery)}
              />
              <Pressable
                style={styles.searchButton}
                onPress={() => onSearch(searchQuery)}
              >
                <Text style={styles.searchButtonText}>Go</Text>
              </Pressable>
            </View>
          </View>
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
    maxHeight: "60%",
    paddingBottom: 32,
  },
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#eee" },
  tab: { flex: 1, paddingVertical: 14, alignItems: "center" },
  tabActive: { borderBottomWidth: 2, borderBottomColor: "#111" },
  tabText: { color: "#999", fontSize: 14 },
  tabTextActive: { color: "#111", fontWeight: "600" },
  section: { padding: 16 },
  sectionLabel: { fontSize: 12, color: "#999", marginBottom: 8, textTransform: "uppercase" },
  presetRow: { flexDirection: "row", gap: 8, marginBottom: 20 },
  presetButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    borderWidth: 2,
    alignItems: "center",
  },
  sizeRow: { flexDirection: "row", gap: 12, marginBottom: 16 },
  sizeButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  sizeButtonText: { fontSize: 16, fontWeight: "600" },
  progressText: { color: "#999", textAlign: "center", marginTop: 8 },
  tocList: { maxHeight: 400 },
  tocItem: { paddingVertical: 12, paddingRight: 16, borderBottomWidth: 1, borderBottomColor: "#f0f0f0" },
  tocLabel: { fontSize: 15 },
  searchRow: { flexDirection: "row", gap: 8 },
  searchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  searchButton: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  searchButtonText: { color: "#fff", fontWeight: "600" },
});
