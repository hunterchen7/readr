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
  { label: "Roboto Slab", value: "'Roboto Slab', serif" },
  { label: "Roboto", value: "'Roboto', sans-serif" },
  { label: "Open Sans", value: "'Open Sans', sans-serif" },
  { label: "Fira Mono", value: "'Fira Mono', monospace" },
  { label: "OpenDyslexic", value: "'OpenDyslexic', serif" },
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
  const { width: screenWidth } = useWindowDimensions();
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
              animationType="fade"
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
              <Pressable style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ fontSize: Math.max(12, theme.fontSize - 2) })}>
                <Text style={[styles.stepperText, { color: fg }]}>A-</Text>
              </Pressable>
              <View style={styles.stepperValue}>
                <Text style={[styles.stepperValueText, { color: fg }]}>{theme.fontSize}px</Text>
              </View>
              <Pressable style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ fontSize: Math.min(32, theme.fontSize + 2) })}>
                <Text style={[styles.stepperText, { color: fg, fontWeight: "700" }]}>A+</Text>
              </Pressable>
            </View>

            {/* Line spacing */}
            <Text style={[styles.label, { color: muted }]}>Line spacing</Text>
            <View style={styles.stepperRow}>
              <Pressable style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ lineHeight: Math.max(1.2, +(theme.lineHeight - 0.1).toFixed(1)) })}>
                <Text style={[styles.stepperText, { color: fg }]}>-</Text>
              </Pressable>
              <View style={styles.stepperValue}>
                <Text style={[styles.stepperValueText, { color: fg }]}>{theme.lineHeight.toFixed(1)}</Text>
              </View>
              <Pressable style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ lineHeight: Math.min(2.4, +(theme.lineHeight + 0.1).toFixed(1)) })}>
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

            {/* Horizontal margin */}
            <Text style={[styles.label, { color: muted }]}>Horizontal margin</Text>
            <View style={styles.stepperRow}>
              <Pressable style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ margin: Math.max(8, theme.margin - 8) })}>
                <Text style={[styles.stepperText, { color: fg }]}>-</Text>
              </Pressable>
              <View style={styles.stepperValue}>
                <Text style={[styles.stepperValueText, { color: fg }]}>{theme.margin}px</Text>
              </View>
              <Pressable style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ margin: Math.min(128, theme.margin + 8) })}>
                <Text style={[styles.stepperText, { color: fg }]}>+</Text>
              </Pressable>
            </View>

            {/* Vertical margin */}
            <Text style={[styles.label, { color: muted }]}>Vertical margin</Text>
            <View style={styles.stepperRow}>
              <Pressable style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ marginV: Math.max(0, (theme.marginV ?? 24) - 8) })}>
                <Text style={[styles.stepperText, { color: fg }]}>-</Text>
              </Pressable>
              <View style={styles.stepperValue}>
                <Text style={[styles.stepperValueText, { color: fg }]}>{theme.marginV ?? 24}px</Text>
              </View>
              <Pressable style={[styles.stepperBtn, { borderColor: border }]} onPress={() => update({ marginV: Math.min(96, (theme.marginV ?? 24) + 8) })}>
                <Text style={[styles.stepperText, { color: fg }]}>+</Text>
              </Pressable>
            </View>
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
    padding: 32,
  },
  pickerSheet: {
    width: "100%",
    maxWidth: 320,
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
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  stepperText: { fontSize: fontSize.lg },
  stepperValue: { flex: 1, alignItems: "center" },
  stepperValueText: { fontSize: fontSize.md },
});
