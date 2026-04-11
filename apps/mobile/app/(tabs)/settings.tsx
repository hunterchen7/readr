import { View, Text, Pressable, StyleSheet, Alert, Switch, ScrollView } from "react-native";
import { router } from "expo-router";
import Constants from "expo-constants";
import { useAuthStore } from "../../lib/auth-store";
import { useDisplayStore } from "../../contexts/DisplayContext";
import { clearAllDownloads } from "../../lib/book-cache";
import { colors, spacing, fontSize } from "../../lib/theme";

export default function SettingsScreen() {
  // Explicit selectors — zustand v5 requires them to keep
  // useSyncExternalStore snapshots stable across renders.
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const signOut = useAuthStore((s) => s.signOut);
  const settings = useDisplayStore((s) => s.settings);
  const toggleEink = useDisplayStore((s) => s.toggleEink);

  function handleClearCache() {
    Alert.alert(
      "Clear offline cache",
      "Remove all downloaded book files? You can re-download them later.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            try {
              const count = await clearAllDownloads();
              Alert.alert("Done", `Removed ${count} cached file${count === 1 ? "" : "s"}`);
            } catch (err) {
              Alert.alert(
                "Couldn't clear cache",
                err instanceof Error ? err.message : String(err),
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Retry", onPress: handleClearCache },
                ],
              );
            }
          },
        },
      ],
    );
  }

  function handleSignOut() {
    Alert.alert("Sign Out", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          await signOut();
          router.replace("/(auth)/login");
        },
      },
    ]);
  }

  const appVersion = Constants.expoConfig?.version ?? "0.0.1";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.label}>Server</Text>
        <Text style={styles.value}>{serverUrl || "Not configured"}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Display</Text>
        <View style={styles.row}>
          <Text style={styles.value}>E-ink Mode</Text>
          <Switch value={settings.isEink} onValueChange={toggleEink} />
        </View>
        {settings.isEink ? (
          <Text style={styles.hint}>
            Animations disabled, high contrast, larger tap targets
          </Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Storage</Text>
        <Pressable style={styles.actionButton} onPress={handleClearCache}>
          <Text style={styles.actionButtonText}>Clear offline cache</Text>
        </Pressable>
        <Text style={styles.hint}>
          Removes downloaded books to free space. Books stay in your cloud library.
        </Text>
      </View>

      <Pressable style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </Pressable>

      <Text style={styles.version}>Readr v{appVersion}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.xl, paddingBottom: 40 },
  section: { marginBottom: spacing.xl },
  label: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 6, textTransform: "uppercase" },
  value: { fontSize: 15 },
  hint: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: spacing.xs },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  actionButton: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: "flex-start",
  },
  actionButtonText: { fontSize: fontSize.md, color: colors.text },
  signOutButton: {
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: spacing.md,
  },
  signOutText: { color: colors.error, fontSize: fontSize.lg, fontWeight: "600" },
  version: { textAlign: "center", color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.xl },
});
