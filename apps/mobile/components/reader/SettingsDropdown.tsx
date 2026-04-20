import { useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Modal, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDisplay } from "../../contexts/DisplayContext";
import { ReaderTheme } from "./ReaderControls";
import { spacing, fontSize } from "../../lib/theme";
import { Check, ChevronDown } from "lucide-react-native";

const THEME_PRESETS = [
  { label: "Light", bg: "#ffffff", fg: "#111111" },
  { label: "Sepia", bg: "#f8f0e3", fg: "#5b4636" },
  { label: "Canvas", bg: "#d4c5a9", fg: "#3a2e1e" },
  { label: "Gray", bg: "#2a2a2a", fg: "#cccccc" },
  { label: "Dark", bg: "#1a1a2e", fg: "#e0e0e0" },
  { label: "Black", bg: "#000000", fg: "#c8c8c8" },
] as const;

// Font families — loaded via Google Fonts in the WebView
const FONT_FAMILIES = [
  { label: "Default", value: "" },
  { label: "Literata", value: "'Literata', serif" },
  { label: "Lora", value: "'Lora', serif" },
  { label: "Merriweather", value: "'Merriweather', serif" },
  { label: "EB Garamond", value: "'EB Garamond', serif" },
  { label: "Source Serif 4", value: "'Source Serif 4', serif" },
  { label: "Noto Serif", value: "'Noto Serif', serif" },
  { label: "Crimson Text", value: "'Crimson Text', serif" },
  { label: "Libre Baskerville", value: "'Libre Baskerville', serif" },
  { label: "Playfair Display", value: "'Playfair Display', serif" },
  { label: "PT Serif", value: "'PT Serif', serif" },
  { label: "Roboto Slab", value: "'Roboto Slab', serif" },
  { label: "Roboto", value: "'Roboto', sans-serif" },
  { label: "Open Sans", value: "'Open Sans', sans-serif" },
  { label: "Inter", value: "'Inter', sans-serif" },
  { label: "Nunito", value: "'Nunito', sans-serif" },
  { label: "Fira Mono", value: "'Fira Mono', monospace" },
  { label: "IBM Plex Mono", value: "'IBM Plex Mono', monospace" },
  // OpenDyslexic removed — the .ttf wasn't bundled, so picking it
  // silently fell back to the serif fallback and did nothing. Add
  // the font to android/app/src/main/assets/fonts/ before re-listing.
] as const;

const FONT_WEIGHTS = [
  { label: "Light", value: 300 },
  { label: "Regular", value: 400 },
  { label: "Medium", value: 500 },
  { label: "Bold", value: 700 },
] as const;

interface SettingsDropdownProps {
  visible: boolean;
  onClose: () => void;
  theme: ReaderTheme;
  onThemeChange: (theme: ReaderTheme) => void;
}

export function SettingsDropdown({ visible, onClose, theme, onThemeChange }: SettingsDropdownProps) {
  const display = useDisplay();
  const [fontOpen, setFontOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const drawerWidth = Math.min(320, screenWidth * 0.8);

  // Drawer colors follow the reader theme
  const bg = theme.bg;
  const fg = theme.fg;
  const muted = fg + "88";
  const border = fg + "22";
  const chipBg = fg + "11";
  const chipActiveBg = fg;
  const chipActiveFg = bg;

  function update(partial: Partial<ReaderTheme>) {
    onThemeChange({ ...theme, ...partial });
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={display.animationsEnabled ? "slide" : "none"}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View
          style={[
            styles.drawer,
            {
              width: drawerWidth,
              paddingTop: insets.top + spacing.md,
              paddingBottom: insets.bottom + spacing.md,
              right: 0,
              backgroundColor: bg,
              borderLeftColor: border,
            },
          ]}
        >
          <Text style={[styles.drawerTitle, { color: fg }]}>Settings</Text>

          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Theme presets — 3x2 grid */}
            <Text style={[styles.label, { color: muted }]}>Theme</Text>
            <View style={styles.themeGrid}>
              {THEME_PRESETS.map((p) => {
                const active = theme.bg === p.bg;
                return (
                  <Pressable
                    key={p.label}
                    accessibilityLabel={`Theme ${p.label}`}
                    style={[
                      styles.themeCell,
                      { backgroundColor: p.bg, borderColor: active ? fg : border },
                      active && { borderWidth: 2 },
                    ]}
                    onPress={() => update({ bg: p.bg, fg: p.fg })}
                  >
                    <Text style={{ color: p.fg, fontSize: 12, fontWeight: "500" }}>{p.label}</Text>
                    {active ? <Check size={12} color={p.fg} /> : null}
                  </Pressable>
                );
              })}
            </View>

            {/* Font family — dropdown button */}
            <Text style={[styles.label, { color: muted }]}>Font</Text>
            <Pressable
              accessibilityLabel="Open font picker"
              style={[styles.dropdownBtn, { borderColor: border, backgroundColor: chipBg }]}
              onPress={() => setFontOpen(true)}
            >
              <Text style={[styles.dropdownBtnText, { color: fg }]}>
                {FONT_FAMILIES.find((f) => f.value === theme.fontFamily)?.label ?? "Default"}
              </Text>
              <ChevronDown size={16} color={muted} />
            </Pressable>

            {/* Font picker modal */}
            <Modal
              visible={fontOpen}
              transparent
              animationType={display.animationsEnabled ? "fade" : "none"}
              onRequestClose={() => setFontOpen(false)}
            >
              <Pressable style={styles.pickerOverlay} onPress={() => setFontOpen(false)}>
                <View style={[styles.pickerSheet, { backgroundColor: bg, borderColor: border }]}>
                  <Text style={[styles.pickerTitle, { color: fg }]}>Choose Font</Text>
                  <ScrollView style={{ maxHeight: 400 }}>
                    {FONT_FAMILIES.map((f) => {
                      const active = theme.fontFamily === f.value;
                      return (
                        <Pressable
                          key={f.label}
                          accessibilityLabel={`Font ${f.label}`}
                          style={[styles.pickerItem, { borderBottomColor: border }, active && { backgroundColor: chipBg }]}
                          onPress={() => { update({ fontFamily: f.value }); setFontOpen(false); }}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.pickerItemText, { color: fg }]}>{f.label}</Text>
                            <Text
                              style={{
                                color: muted,
                                fontSize: 13,
                                fontFamily: f.value.includes("mono") ? "monospace"
                                  : f.value.includes("sans") ? "sans-serif"
                                  : f.value ? "serif" : undefined,
                                marginTop: 2,
                              }}
                              numberOfLines={1}
                            >
                              The quick brown fox jumps over the lazy dog
                            </Text>
                          </View>
                          {active ? <Check size={16} color={fg} /> : null}
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              </Pressable>
            </Modal>

            {/* Font size */}
            <Text style={[styles.label, { color: muted }]}>Size</Text>
            <View style={styles.stepperRow}>
              <Pressable accessibilityLabel="Decrease font size" style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ fontSize: Math.max(12, theme.fontSize - 1) })}>
                <Text style={[styles.stepperText, { color: fg }]}>A-</Text>
              </Pressable>
              <View style={styles.stepperValue}>
                <Text accessibilityLabel={`Font size ${theme.fontSize}`} style={[styles.stepperValueText, { color: fg }]}>{theme.fontSize}px</Text>
              </View>
              <Pressable accessibilityLabel="Increase font size" style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ fontSize: Math.min(32, theme.fontSize + 1) })}>
                <Text style={[styles.stepperText, { color: fg, fontWeight: "700" }]}>A+</Text>
              </Pressable>
            </View>

            {/* Line spacing */}
            <Text style={[styles.label, { color: muted }]}>Line spacing</Text>
            <View style={styles.stepperRow}>
              <Pressable accessibilityLabel="Decrease line spacing" style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ lineHeight: Math.max(1.2, +(theme.lineHeight - 0.1).toFixed(1)) })}>
                <Text style={[styles.stepperText, { color: fg }]}>-</Text>
              </Pressable>
              <View style={styles.stepperValue}>
                <Text accessibilityLabel={`Line spacing ${theme.lineHeight.toFixed(1)}`} style={[styles.stepperValueText, { color: fg }]}>{theme.lineHeight.toFixed(1)}</Text>
              </View>
              <Pressable accessibilityLabel="Increase line spacing" style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ lineHeight: Math.min(2.4, +(theme.lineHeight + 0.1).toFixed(1)) })}>
                <Text style={[styles.stepperText, { color: fg }]}>+</Text>
              </Pressable>
            </View>

            {/* Weight */}
            <Text style={[styles.label, { color: muted }]}>Weight</Text>
            <View style={styles.row}>
              {FONT_WEIGHTS.map((w) => {
                const active = theme.fontWeight === w.value;
                return (
                  <Pressable
                    key={w.label}
                    style={[
                      styles.chipBtn,
                      { backgroundColor: active ? chipActiveBg : chipBg },
                    ]}
                    onPress={() => update({ fontWeight: w.value })}
                  >
                    <Text style={{ fontSize: 12, color: active ? chipActiveFg : fg }}>
                      {w.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Horizontal margin — shown as % of screen width since a
                raw px value reads meaningless across phone/tablet
                sizes. The underlying theme field is still px (kept so
                old saved values + the reader runtime don't need a
                migration); we derive a step size from the screen so
                each +/- tap moves the margin by ~1% of the viewport. */}
            <Text style={[styles.label, { color: muted }]}>Horizontal margin</Text>
            {(() => {
              const stepH = Math.max(2, Math.round(screenWidth * 0.01));
              const maxH = Math.round(screenWidth * 0.3);
              const pctH = Math.round((theme.margin / screenWidth) * 100);
              return (
                <View style={styles.stepperRow}>
                  <Pressable accessibilityLabel="Decrease horizontal margin" style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ margin: Math.max(0, theme.margin - stepH) })}>
                    <Text style={[styles.stepperText, { color: fg }]}>-</Text>
                  </Pressable>
                  <View style={styles.stepperValue}>
                    <Text accessibilityLabel={`Horizontal margin ${pctH}`} style={[styles.stepperValueText, { color: fg }]}>{pctH}%</Text>
                  </View>
                  <Pressable accessibilityLabel="Increase horizontal margin" style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ margin: Math.min(maxH, theme.margin + stepH) })}>
                    <Text style={[styles.stepperText, { color: fg }]}>+</Text>
                  </Pressable>
                </View>
              );
            })()}

            {/* Vertical margin — same story: displayed as % of screen
                height, stepped by ~1% of the viewport, stored as px. */}
            <Text style={[styles.label, { color: muted }]}>Vertical margin</Text>
            {(() => {
              const curV = theme.marginV ?? 24;
              const stepV = Math.max(2, Math.round(screenHeight * 0.01));
              const maxV = Math.round(screenHeight * 0.2);
              const pctV = Math.round((curV / screenHeight) * 100);
              return (
                <View style={styles.stepperRow}>
                  <Pressable accessibilityLabel="Decrease vertical margin" style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ marginV: Math.max(0, curV - stepV) })}>
                    <Text style={[styles.stepperText, { color: fg }]}>-</Text>
                  </Pressable>
                  <View style={styles.stepperValue}>
                    <Text accessibilityLabel={`Vertical margin ${pctV}`} style={[styles.stepperValueText, { color: fg }]}>{pctV}%</Text>
                  </View>
                  <Pressable accessibilityLabel="Increase vertical margin" style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ marginV: Math.min(maxV, curV + stepV) })}>
                    <Text style={[styles.stepperText, { color: fg }]}>+</Text>
                  </Pressable>
                </View>
              );
            })()}

            {/* Page turn gestures */}
            <Text style={[styles.label, { color: muted }]}>Page turn</Text>
            <View style={styles.row}>
              {([
                { label: "Tap", mode: "tap" as const },
                { label: "Swipe", mode: "swipe" as const },
                { label: "Both", mode: "both" as const },
                { label: "Scroll", mode: "scroll" as const },
              ]).map((opt) => {
                const active = (theme.pageTurnMode ?? "both") === opt.mode;
                return (
                  <Pressable
                    key={opt.label}
                    style={[styles.chipBtn, { backgroundColor: active ? chipActiveBg : chipBg }]}
                    onPress={() =>
                      update({
                        pageTurnMode: opt.mode,
                        // Keep the legacy boolean in sync for any code
                        // path that still reads it directly.
                        tapToTurn: opt.mode !== "swipe",
                      })
                    }
                  >
                    <Text style={{ fontSize: 12, color: active ? chipActiveFg : fg }}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Progress bar mode */}
            <Text style={[styles.label, { color: muted }]}>Progress bar</Text>
            <View style={styles.row}>
              {([
                { label: "Off", value: "off" as const },
                { label: "Bar", value: "bar" as const },
                { label: "Verbose", value: "verbose" as const },
              ]).map((opt) => {
                const raw: string = typeof theme.progressBar === "boolean"
                  ? (theme.progressBar ? "bar" : "off")
                  : (theme.progressBar ?? "bar");
                // Legacy "always" maps to the new "bar".
                const cur = raw === "always" ? "bar" : raw;
                const active = cur === opt.value;
                return (
                  <Pressable
                    key={opt.label}
                    style={[styles.chipBtn, { backgroundColor: active ? chipActiveBg : chipBg }]}
                    onPress={() => update({ progressBar: opt.value })}
                  >
                    <Text style={{ fontSize: 12, color: active ? chipActiveFg : fg }}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Page number — one consolidated picker. "Off" chip plus a
                2×3 grid where each cell shows a mini-page with a dot in
                the corresponding corner (alternate = both sides). */}
            <Text style={[styles.label, { color: muted }]}>Page number</Text>
            {(() => {
              const enabled = theme.pageIndicator?.enabled ?? true;
              const curEdge = theme.pageIndicator?.edge ?? "bottom";
              const curSide = theme.pageIndicator?.side ?? "alternate";
              const POSITIONS = [
                { edge: "top", side: "left" },
                { edge: "top", side: "alternate" },
                { edge: "top", side: "right" },
                { edge: "bottom", side: "left" },
                { edge: "bottom", side: "alternate" },
                { edge: "bottom", side: "right" },
              ] as const;
              return (
                <View style={styles.pageNumRow}>
                  <Pressable
                    style={[
                      styles.pageNumOffBtn,
                      { backgroundColor: !enabled ? chipActiveBg : chipBg },
                    ]}
                    onPress={() =>
                      update({
                        pageIndicator: { enabled: false, edge: curEdge, side: curSide },
                      })
                    }
                  >
                    <Text style={{ fontSize: 12, color: !enabled ? chipActiveFg : fg }}>Off</Text>
                  </Pressable>
                  <View style={styles.pageNumGrid}>
                    {POSITIONS.map((p) => {
                      const active = enabled && curEdge === p.edge && curSide === p.side;
                      const dotY = p.edge === "top" ? { top: 4 } : { bottom: 4 };
                      const dotColor = active ? chipActiveFg : fg;
                      return (
                        <Pressable
                          key={`${p.edge}-${p.side}`}
                          style={[
                            styles.pageNumCell,
                            {
                              backgroundColor: active ? chipActiveBg : chipBg,
                              borderColor: active ? fg : border,
                            },
                          ]}
                          onPress={() =>
                            update({
                              pageIndicator: { enabled: true, edge: p.edge, side: p.side },
                            })
                          }
                          accessibilityLabel={`Page number ${p.edge} ${p.side}`}
                        >
                          {p.side === "alternate" ? (
                            <>
                              <View
                                style={[
                                  styles.pageNumDot,
                                  { backgroundColor: dotColor, opacity: 0.5, left: 4, ...dotY },
                                ]}
                              />
                              <View
                                style={[
                                  styles.pageNumDot,
                                  { backgroundColor: dotColor, opacity: 0.5, right: 4, ...dotY },
                                ]}
                              />
                            </>
                          ) : (
                            <View
                              style={[
                                styles.pageNumDot,
                                {
                                  backgroundColor: dotColor,
                                  [p.side]: 4,
                                  ...dotY,
                                },
                              ]}
                            />
                          )}
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })()}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, flexDirection: "row", justifyContent: "flex-end" },
  drawer: {
    height: "100%",
    paddingHorizontal: spacing.lg,
    shadowColor: "#000",
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 10,
    borderLeftWidth: 1,
  },
  drawerTitle: {
    fontSize: fontSize.xl,
    fontWeight: "700",
    marginBottom: spacing.lg,
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  // 3x2 theme grid
  themeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  themeCell: {
    width: "30%",
    flexGrow: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  // Font dropdown
  dropdownBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  dropdownBtnText: { fontSize: 14 },
  // Font picker modal
  pickerOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: 16,
  },
  pickerSheet: {
    width: "100%",
    maxWidth: 500,
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: "600",
    padding: 16,
    paddingBottom: 8,
  },
  pickerItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerItemText: { fontSize: 15 },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  chipBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  stepperBtn: {
    width: 40,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  stepperText: { fontSize: fontSize.md },
  stepperValue: { flex: 1, alignItems: "center" },
  stepperValueText: { fontSize: fontSize.md },
  // Consolidated page-number picker: one "Off" chip next to a 2×3
  // visual grid of mini "page" cells. Each cell shows a dot in the
  // corner the page-number will render at, so the control reads at a
  // glance without separate Position / Side / Enabled sections.
  pageNumRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: spacing.sm,
  },
  pageNumOffBtn: {
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  pageNumGrid: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  pageNumCell: {
    width: "31.5%",
    height: 28,
    borderWidth: 1,
    borderRadius: 6,
  },
  pageNumDot: {
    position: "absolute",
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
});
