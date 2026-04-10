import { View, Text, Pressable, StyleSheet, ScrollView, Modal, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDisplay } from "../../contexts/DisplayContext";
import { ReaderTheme } from "./ReaderControls";
import { colors, spacing, fontSize } from "../../lib/theme";

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
  isEink: boolean;
}

export function SettingsDropdown({ visible, onClose, theme, onThemeChange, isEink }: SettingsDropdownProps) {
  const display = useDisplay();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const drawerWidth = Math.min(320, screenWidth * 0.8);

  function update(partial: Partial<ReaderTheme>) {
    onThemeChange({ ...theme, ...partial });
  }

  const presets = isEink
    ? THEME_PRESETS.filter((p) => p.label !== "Dark")
    : THEME_PRESETS;

  return (
    <Modal
      visible={visible}
      transparent
      animationType={display.animationsEnabled ? "slide" : "none"}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        {/* Backdrop — tap to close */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        {/* Right-aligned drawer */}
        <View
          style={[
            styles.drawer,
            {
              width: drawerWidth,
              paddingTop: insets.top + spacing.md,
              paddingBottom: insets.bottom + spacing.md,
              right: 0,
            },
          ]}
        >
          <Text style={styles.drawerTitle}>Settings</Text>

          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Theme presets */}
            <Text style={styles.label}>Theme</Text>
            <View style={styles.row}>
              {presets.map((p) => (
                <Pressable
                  key={p.label}
                  style={[
                    styles.presetBtn,
                    { backgroundColor: p.bg, borderColor: theme.bg === p.bg ? colors.text : colors.border },
                    theme.bg === p.bg && styles.presetBtnActive,
                  ]}
                  onPress={() => update({ bg: p.bg, fg: p.fg })}
                >
                  <Text style={[styles.presetLabel, { color: p.fg }]}>{p.label}</Text>
                </Pressable>
              ))}
            </View>

            {/* Font family */}
            <Text style={styles.label}>Font</Text>
            <View style={styles.row}>
              {FONT_FAMILIES.map((f) => (
                <Pressable
                  key={f.label}
                  style={[
                    styles.chipBtn,
                    theme.fontFamily === f.value && styles.chipBtnActive,
                  ]}
                  onPress={() => update({ fontFamily: f.value })}
                >
                  <Text style={[styles.chipLabel, theme.fontFamily === f.value && styles.chipLabelActive]}>
                    {f.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Font size */}
            <Text style={styles.label}>Size: {theme.fontSize}px</Text>
            <View style={styles.stepperRow}>
              <Pressable style={styles.stepperBtn} onPress={() => update({ fontSize: Math.max(12, theme.fontSize - 2) })}>
                <Text style={styles.stepperText}>A-</Text>
              </Pressable>
              <View style={styles.stepperValue}>
                <Text style={styles.stepperValueText}>{theme.fontSize}</Text>
              </View>
              <Pressable style={styles.stepperBtn} onPress={() => update({ fontSize: Math.min(32, theme.fontSize + 2) })}>
                <Text style={[styles.stepperText, { fontWeight: "700" }]}>A+</Text>
              </Pressable>
            </View>

            {/* Line spacing */}
            <Text style={styles.label}>Line spacing: {theme.lineHeight.toFixed(1)}</Text>
            <View style={styles.stepperRow}>
              <Pressable style={styles.stepperBtn} onPress={() => update({ lineHeight: Math.max(1.2, +(theme.lineHeight - 0.1).toFixed(1)) })}>
                <Text style={styles.stepperText}>-</Text>
              </Pressable>
              <View style={styles.stepperValue}>
                <Text style={styles.stepperValueText}>{theme.lineHeight.toFixed(1)}</Text>
              </View>
              <Pressable style={styles.stepperBtn} onPress={() => update({ lineHeight: Math.min(2.4, +(theme.lineHeight + 0.1).toFixed(1)) })}>
                <Text style={styles.stepperText}>+</Text>
              </Pressable>
            </View>

            {/* Weight */}
            <Text style={styles.label}>Weight</Text>
            <View style={styles.row}>
              {FONT_WEIGHTS.map((w) => (
                <Pressable
                  key={w.label}
                  style={[
                    styles.chipBtn,
                    theme.fontWeight === w.value && styles.chipBtnActive,
                  ]}
                  onPress={() => update({ fontWeight: w.value })}
                >
                  <Text style={[styles.chipLabel, theme.fontWeight === w.value && styles.chipLabelActive]}>
                    {w.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Margin */}
            <Text style={styles.label}>Margin: {theme.margin}px</Text>
            <View style={styles.stepperRow}>
              <Pressable style={styles.stepperBtn} onPress={() => update({ margin: Math.max(16, theme.margin - 16) })}>
                <Text style={styles.stepperText}>-</Text>
              </Pressable>
              <View style={styles.stepperValue}>
                <Text style={styles.stepperValueText}>{theme.margin}</Text>
              </View>
              <Pressable style={styles.stepperBtn} onPress={() => update({ margin: Math.min(128, theme.margin + 16) })}>
                <Text style={styles.stepperText}>+</Text>
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
    backgroundColor: colors.background,
    height: "100%",
    paddingHorizontal: spacing.lg,
    shadowColor: "#000",
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 10,
  },
  drawerTitle: {
    fontSize: fontSize.xl,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.lg,
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.textMuted,
    textTransform: "uppercase",
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  presetBtn: {
    flex: 1,
    minWidth: 60,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: "center",
  },
  presetBtnActive: { borderWidth: 2 },
  presetLabel: { fontSize: fontSize.sm, fontWeight: "500" },
  chipBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    backgroundColor: colors.backgroundSecondary,
  },
  chipBtnActive: { backgroundColor: colors.text },
  chipLabel: { fontSize: fontSize.sm, color: colors.text },
  chipLabelActive: { color: colors.primaryFg },
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
    borderColor: colors.border,
    justifyContent: "center",
    alignItems: "center",
  },
  stepperText: { fontSize: fontSize.lg, color: colors.text },
  stepperValue: { flex: 1, alignItems: "center" },
  stepperValueText: { fontSize: fontSize.md, color: colors.textSecondary },
});
