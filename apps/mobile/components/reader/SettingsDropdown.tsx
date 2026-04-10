import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ReaderTheme,
  DEFAULT_THEME,
  EINK_THEME,
} from "./ReaderControls";
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

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 32;
const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.4;
const LINE_HEIGHT_STEP = 0.1;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

interface SettingsDropdownProps {
  visible: boolean;
  onClose: () => void;
  theme: ReaderTheme;
  onThemeChange: (theme: ReaderTheme) => void;
  isEink: boolean;
}

export function SettingsDropdown({
  visible,
  onClose,
  theme,
  onThemeChange,
  isEink,
}: SettingsDropdownProps) {
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  const presets = isEink
    ? THEME_PRESETS.filter((p) => p.label !== "Dark")
    : THEME_PRESETS;

  return (
    <>
      {/* Backdrop */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
      />

      {/* Dropdown panel */}
      <View
        style={[
          styles.panel,
          {
            top: insets.top + 52,
          },
        ]}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Theme presets */}
          <Text style={styles.sectionLabel}>Theme</Text>
          <View style={styles.row}>
            {presets.map((p) => (
              <Pressable
                key={p.label}
                style={[
                  styles.presetButton,
                  {
                    backgroundColor: p.bg,
                    borderColor: p.bg === theme.bg && p.fg === theme.fg
                      ? colors.text
                      : colors.border,
                  },
                ]}
                onPress={() => onThemeChange({ ...theme, bg: p.bg, fg: p.fg })}
              >
                <Text style={{ color: p.fg, fontSize: fontSize.xs }}>
                  {p.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Font family */}
          <Text style={styles.sectionLabel}>Font</Text>
          <View style={styles.row}>
            {FONT_FAMILIES.map((f) => {
              const active = theme.fontFamily === f.value;
              return (
                <Pressable
                  key={f.label}
                  style={[
                    styles.chipButton,
                    active && styles.chipButtonActive,
                  ]}
                  onPress={() => onThemeChange({ ...theme, fontFamily: f.value })}
                >
                  <Text
                    style={[
                      styles.chipText,
                      active && styles.chipTextActive,
                    ]}
                  >
                    {f.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Font size */}
          <Text style={styles.sectionLabel}>
            Font Size: {theme.fontSize}px
          </Text>
          <View style={styles.stepperRow}>
            <Pressable
              style={styles.stepperButton}
              onPress={() =>
                onThemeChange({
                  ...theme,
                  fontSize: clamp(theme.fontSize - 1, FONT_SIZE_MIN, FONT_SIZE_MAX),
                })
              }
            >
              <Text style={styles.stepperText}>A-</Text>
            </Pressable>
            <Text style={styles.stepperValue}>{theme.fontSize}</Text>
            <Pressable
              style={styles.stepperButton}
              onPress={() =>
                onThemeChange({
                  ...theme,
                  fontSize: clamp(theme.fontSize + 1, FONT_SIZE_MIN, FONT_SIZE_MAX),
                })
              }
            >
              <Text style={[styles.stepperText, { fontSize: 18 }]}>A+</Text>
            </Pressable>
          </View>

          {/* Line spacing */}
          <Text style={styles.sectionLabel}>
            Line Spacing: {theme.lineHeight.toFixed(1)}
          </Text>
          <View style={styles.stepperRow}>
            <Pressable
              style={styles.stepperButton}
              onPress={() =>
                onThemeChange({
                  ...theme,
                  lineHeight:
                    Math.round(
                      clamp(
                        theme.lineHeight - LINE_HEIGHT_STEP,
                        LINE_HEIGHT_MIN,
                        LINE_HEIGHT_MAX,
                      ) * 10,
                    ) / 10,
                })
              }
            >
              <Text style={styles.stepperText}>-</Text>
            </Pressable>
            <Text style={styles.stepperValue}>
              {theme.lineHeight.toFixed(1)}
            </Text>
            <Pressable
              style={styles.stepperButton}
              onPress={() =>
                onThemeChange({
                  ...theme,
                  lineHeight:
                    Math.round(
                      clamp(
                        theme.lineHeight + LINE_HEIGHT_STEP,
                        LINE_HEIGHT_MIN,
                        LINE_HEIGHT_MAX,
                      ) * 10,
                    ) / 10,
                })
              }
            >
              <Text style={styles.stepperText}>+</Text>
            </Pressable>
          </View>

          {/* Font weight */}
          <Text style={styles.sectionLabel}>Weight</Text>
          <View style={styles.row}>
            {FONT_WEIGHTS.map((w) => {
              const active = theme.fontWeight === w.value;
              return (
                <Pressable
                  key={w.value}
                  style={[
                    styles.chipButton,
                    active && styles.chipButtonActive,
                  ]}
                  onPress={() => onThemeChange({ ...theme, fontWeight: w.value })}
                >
                  <Text
                    style={[
                      styles.chipText,
                      active && styles.chipTextActive,
                      { fontWeight: String(w.value) as "300" | "400" | "500" | "700" },
                    ]}
                  >
                    {w.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: "absolute",
    right: spacing.lg,
    width: 300,
    maxHeight: 420,
    backgroundColor: colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  sectionLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: spacing.sm,
    marginTop: spacing.xs,
    textTransform: "uppercase",
  },
  row: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  presetButton: {
    flex: 1,
    padding: spacing.md,
    borderRadius: 8,
    borderWidth: 2,
    alignItems: "center",
  },
  chipButton: {
    flex: 1,
    padding: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    backgroundColor: colors.background,
  },
  chipButtonActive: {
    borderColor: colors.text,
    backgroundColor: colors.backgroundSecondary,
  },
  chipText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.text,
    fontWeight: "600",
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  stepperButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: spacing.md,
    alignItems: "center",
  },
  stepperText: {
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.text,
  },
  stepperValue: {
    fontSize: fontSize.md,
    fontWeight: "500",
    color: colors.text,
    minWidth: 32,
    textAlign: "center",
  },
});
