import { View, Text, Pressable, StyleSheet, Modal, FlatList, TextInput, ScrollView, Switch } from "react-native";
import { useState } from "react";
import { useDisplay } from "../../contexts/DisplayContext";

export interface ReaderTheme {
  bg: string;
  fg: string;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  /** Horizontal page margin in pixels. */
  margin: number;
  /** Vertical page margin in pixels. */
  marginV: number;
  /** Tap left/right edges to turn pages. When false, tap anywhere opens the controls. */
  tapToTurn: boolean;
  /**
   * How the reader advances pages. "tap" = only edge-tap zones turn
   * pages (swipe is swallowed), "swipe" = only swipe/drag turns pages
   * (edge taps just open controls), "both" = both work.
   */
  pageTurnMode: "tap" | "swipe" | "both" | "scroll";
  /** 100 = normal weight. 300 = light, 700 = bold. Applied via CSS font-weight. */
  fontWeight: number;
  /**
   * Screen brightness 0..1, mirrored into the Android screen backlight
   * via expo-brightness. null = honor the system setting.
   */
  brightness: number | null;
  /** Progress bar visibility mode:
   *  "off" = never, "bar" = only in toolbar, "always" = toolbar + mini bar,
   *  "verbose" = toolbar + richer mini bar with percentage & chapter. */
  progressBar: "off" | "bar" | "always" | "verbose";
  /** Always-visible page number overlay drawn over the reader content. */
  pageIndicator: PageIndicator;
}

export interface PageIndicator {
  enabled: boolean;
  /** "top" or "bottom" edge of the page. */
  edge: "top" | "bottom";
  /**
   * "left" / "right" pins to a fixed corner. "alternate" swaps sides
   * each page turn so the indicator sits on the outer edge of a
   * two-page spread (odd pages on the right, even on the left).
   */
  side: "left" | "right" | "alternate";
}

export const DEFAULT_THEME: ReaderTheme = {
  bg: "#ffffff",
  fg: "#111111",
  fontSize: 18,
  lineHeight: 1.6,
  fontFamily: "Georgia, serif",
  margin: 48,
  marginV: 24,
  tapToTurn: true,
  pageTurnMode: "both",
  fontWeight: 400,
  brightness: null,
  progressBar: "always",
  pageIndicator: { enabled: true, edge: "bottom", side: "alternate" },
};

/** Generous defaults tuned for the Supernote A5X 7.8" e-ink panel. */
export const EINK_THEME: ReaderTheme = {
  bg: "#ffffff",
  fg: "#000000",
  fontSize: 20,
  lineHeight: 1.7,
  fontFamily: "Georgia, serif",
  margin: 72,
  marginV: 32,
  tapToTurn: true,
  pageTurnMode: "both",
  fontWeight: 500,
  brightness: null,
  progressBar: "always",
  pageIndicator: { enabled: true, edge: "bottom", side: "alternate" },
};

const THEME_PRESETS = [
  { label: "Light", bg: "#ffffff", fg: "#111111" },
  { label: "Sepia", bg: "#f8f0e3", fg: "#5b4636" },
  { label: "Dark", bg: "#1a1a2e", fg: "#e0e0e0" },
  { label: "E-ink", bg: "#ffffff", fg: "#000000" },
] as const;

const FONT_FAMILIES = [
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Sans", value: "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: "Mono", value: "'SF Mono', Menlo, Consolas, monospace" },
  { label: "Dyslexic", value: "'OpenDyslexic', Georgia, serif" },
] as const;

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 32;
const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.4;
const LINE_HEIGHT_STEP = 0.1;
const MARGIN_MIN = 16;
const MARGIN_MAX = 128;
const MARGIN_STEP = 8;

interface TocItem {
  label: string;
  href: string;
  depth: number;
}

export interface SearchResult {
  cfi: string;
  excerpt: string;
  section?: string | null;
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
  searchResults: SearchResult[];
  searchLoading: boolean;
  onJumpToResult: (cfi: string) => void;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
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
  searchResults,
  searchLoading,
  onJumpToResult,
}: ReaderControlsProps) {
  const display = useDisplay();
  const [tab, setTab] = useState<"theme" | "toc" | "search">("theme");
  const [searchQuery, setSearchQuery] = useState("");

  if (!visible) return null;

  // Hide the Dark preset on e-ink devices — inverted text causes ghosting & A2-mode flashing.
  const presets = display.isEink
    ? THEME_PRESETS.filter((p) => p.label !== "Dark")
    : THEME_PRESETS;

  return (
    <Modal
      transparent
      animationType={display.animationsEnabled ? "slide" : "none"}
      visible={visible}
      onRequestClose={onClose}
    >
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
                {t === "theme" ? "Display" : t === "toc" ? "Contents" : "Search"}
              </Text>
            </Pressable>
          ))}
        </View>

        {tab === "theme" ? (
          <ScrollView style={styles.section} contentContainerStyle={styles.sectionContent}>
            <Text style={styles.sectionLabel}>Preset</Text>
            <View style={styles.presetRow}>
              {presets.map((p) => (
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

            <Text style={styles.sectionLabel}>Font</Text>
            <View style={styles.presetRow}>
              {FONT_FAMILIES.map((f) => {
                const active = theme.fontFamily === f.value;
                return (
                  <Pressable
                    key={f.label}
                    style={[
                      styles.fontButton,
                      active && styles.fontButtonActive,
                    ]}
                    onPress={() => onThemeChange({ ...theme, fontFamily: f.value })}
                  >
                    <Text
                      style={[
                        styles.fontButtonText,
                        active && styles.fontButtonTextActive,
                      ]}
                    >
                      {f.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.sectionLabel}>Font Size: {theme.fontSize}px</Text>
            <View style={styles.sizeRow}>
              <Pressable
                style={styles.sizeButton}
                onPress={() =>
                  onThemeChange({ ...theme, fontSize: clamp(theme.fontSize - 1, FONT_SIZE_MIN, FONT_SIZE_MAX) })
                }
              >
                <Text style={styles.sizeButtonText}>A−</Text>
              </Pressable>
              <Pressable
                style={styles.sizeButton}
                onPress={() =>
                  onThemeChange({ ...theme, fontSize: clamp(theme.fontSize + 1, FONT_SIZE_MIN, FONT_SIZE_MAX) })
                }
              >
                <Text style={[styles.sizeButtonText, { fontSize: 20 }]}>A+</Text>
              </Pressable>
            </View>

            <Text style={styles.sectionLabel}>Line Spacing: {theme.lineHeight.toFixed(1)}</Text>
            <View style={styles.sizeRow}>
              <Pressable
                style={styles.sizeButton}
                onPress={() =>
                  onThemeChange({
                    ...theme,
                    lineHeight: Math.round(clamp(theme.lineHeight - LINE_HEIGHT_STEP, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX) * 10) / 10,
                  })
                }
              >
                <Text style={styles.sizeButtonText}>−</Text>
              </Pressable>
              <Pressable
                style={styles.sizeButton}
                onPress={() =>
                  onThemeChange({
                    ...theme,
                    lineHeight: Math.round(clamp(theme.lineHeight + LINE_HEIGHT_STEP, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX) * 10) / 10,
                  })
                }
              >
                <Text style={styles.sizeButtonText}>+</Text>
              </Pressable>
            </View>

            <Text style={styles.sectionLabel}>Page Margin: {theme.margin}px</Text>
            <View style={styles.sizeRow}>
              <Pressable
                style={styles.sizeButton}
                onPress={() =>
                  onThemeChange({ ...theme, margin: clamp(theme.margin - MARGIN_STEP, MARGIN_MIN, MARGIN_MAX) })
                }
              >
                <Text style={styles.sizeButtonText}>−</Text>
              </Pressable>
              <Pressable
                style={styles.sizeButton}
                onPress={() =>
                  onThemeChange({ ...theme, margin: clamp(theme.margin + MARGIN_STEP, MARGIN_MIN, MARGIN_MAX) })
                }
              >
                <Text style={styles.sizeButtonText}>+</Text>
              </Pressable>
            </View>

            <Text style={styles.sectionLabel}>Weight</Text>
            <View style={styles.presetRow}>
              {(
                [
                  { label: "Light", value: 300 },
                  { label: "Regular", value: 400 },
                  { label: "Medium", value: 500 },
                  { label: "Bold", value: 700 },
                ] as const
              ).map((w) => {
                const active = theme.fontWeight === w.value;
                return (
                  <Pressable
                    key={w.value}
                    style={[styles.fontButton, active && styles.fontButtonActive]}
                    onPress={() => onThemeChange({ ...theme, fontWeight: w.value })}
                  >
                    <Text
                      style={[
                        styles.fontButtonText,
                        active && styles.fontButtonTextActive,
                        { fontWeight: String(w.value) as "400" | "500" | "300" | "700" },
                      ]}
                    >
                      {w.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {display.isEink ? null : (
              <>
                <Text style={styles.sectionLabel}>
                  Brightness{" "}
                  {theme.brightness == null
                    ? "(system)"
                    : `${Math.round(theme.brightness * 100)}%`}
                </Text>
                <View style={styles.sizeRow}>
                  <Pressable
                    style={styles.sizeButton}
                    onPress={() =>
                      onThemeChange({
                        ...theme,
                        brightness: clamp((theme.brightness ?? 0.5) - 0.1, 0.1, 1),
                      })
                    }
                  >
                    <Text style={styles.sizeButtonText}>☀−</Text>
                  </Pressable>
                  <Pressable
                    style={styles.sizeButton}
                    onPress={() =>
                      onThemeChange({
                        ...theme,
                        brightness: clamp((theme.brightness ?? 0.5) + 0.1, 0.1, 1),
                      })
                    }
                  >
                    <Text style={styles.sizeButtonText}>☀+</Text>
                  </Pressable>
                  <Pressable
                    style={styles.sizeButton}
                    onPress={() => onThemeChange({ ...theme, brightness: null })}
                  >
                    <Text style={styles.sizeButtonText}>Auto</Text>
                  </Pressable>
                </View>
              </>
            )}

            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleLabel}>Tap to turn pages</Text>
                <Text style={styles.toggleHint}>
                  Tap the left/right edges of the page. Center tap opens this panel.
                </Text>
              </View>
              <Switch
                value={theme.tapToTurn}
                onValueChange={(v) => onThemeChange({ ...theme, tapToTurn: v })}
              />
            </View>

            <Text style={styles.progressText}>{progress}% read</Text>
          </ScrollView>
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
          <View style={styles.searchPane}>
            <View style={styles.searchRow}>
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search in book..."
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={() => onSearch(searchQuery)}
              />
              <Pressable
                style={styles.searchButton}
                onPress={() => onSearch(searchQuery)}
              >
                <Text style={styles.searchButtonText}>Go</Text>
              </Pressable>
            </View>
            {searchLoading ? (
              <Text style={styles.searchMeta}>Searching…</Text>
            ) : searchQuery && searchResults.length === 0 ? (
              <Text style={styles.searchMeta}>No results</Text>
            ) : searchResults.length > 0 ? (
              <Text style={styles.searchMeta}>
                {searchResults.length} result{searchResults.length === 1 ? "" : "s"}
              </Text>
            ) : null}
            <FlatList
              style={styles.searchResults}
              data={searchResults}
              keyExtractor={(r, i) => `${r.cfi}-${i}`}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  style={styles.resultItem}
                  onPress={() => {
                    onJumpToResult(item.cfi);
                    onClose();
                  }}
                >
                  {item.section ? (
                    <Text style={styles.resultSection} numberOfLines={1}>
                      {item.section}
                    </Text>
                  ) : null}
                  <Text style={styles.resultExcerpt} numberOfLines={3}>
                    {item.excerpt}
                  </Text>
                </Pressable>
              )}
            />
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
    maxHeight: "75%",
    paddingBottom: 32,
  },
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#eee" },
  tab: { flex: 1, paddingVertical: 14, alignItems: "center" },
  tabActive: { borderBottomWidth: 2, borderBottomColor: "#111" },
  tabText: { color: "#999", fontSize: 14 },
  tabTextActive: { color: "#111", fontWeight: "600" },
  section: { paddingHorizontal: 16, paddingTop: 16 },
  sectionContent: { paddingBottom: 24 },
  sectionLabel: { fontSize: 12, color: "#999", marginBottom: 8, marginTop: 4, textTransform: "uppercase" },
  presetRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  presetButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    borderWidth: 2,
    alignItems: "center",
  },
  fontButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  fontButtonActive: {
    borderColor: "#111",
    backgroundColor: "#f4f4f4",
  },
  fontButtonText: { fontSize: 13, color: "#666" },
  fontButtonTextActive: { color: "#111", fontWeight: "600" },
  sizeRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
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
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 12,
    paddingVertical: 4,
  },
  toggleLabel: { fontSize: 14, color: "#111" },
  toggleHint: { fontSize: 11, color: "#888", marginTop: 2 },
  searchPane: { paddingHorizontal: 16, paddingTop: 16, flex: 1 },
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
  searchMeta: { color: "#999", fontSize: 12, marginTop: 8, textTransform: "uppercase" },
  searchResults: { marginTop: 8, maxHeight: 400 },
  resultItem: {
    paddingVertical: 12,
    paddingRight: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  resultSection: { fontSize: 11, color: "#666", marginBottom: 2, textTransform: "uppercase" },
  resultExcerpt: { fontSize: 14, color: "#222", lineHeight: 20 },
});
