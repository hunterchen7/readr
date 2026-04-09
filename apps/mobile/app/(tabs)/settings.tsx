import { View, Text, Pressable, StyleSheet, Alert, Switch, Platform, ScrollView } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import Constants from "expo-constants";
import { useAuthStore } from "../../lib/auth-store";
import { useDisplayStore } from "../../contexts/DisplayContext";
import { clearAllDownloads } from "../../lib/book-cache";

export default function SettingsScreen() {
  const { serverUrl, token, signOut } = useAuthStore();
  const { settings, toggleEink } = useDisplayStore();

  async function handleCopyToken() {
    if (!token) return;
    await Clipboard.setStringAsync(token);
    Alert.alert("Copied", "Device token copied to clipboard");
  }

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
            const count = await clearAllDownloads();
            Alert.alert("Done", `Removed ${count} cached file${count === 1 ? "" : "s"}`);
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
        <Text style={styles.label}>Device token</Text>
        <Text style={styles.token} selectable>
          {token || "Not configured"}
        </Text>
        <Pressable style={styles.copyButton} onPress={handleCopyToken}>
          <Text style={styles.copyButtonText}>Copy token</Text>
        </Pressable>
        <Text style={styles.hint}>
          Paste this on another device to share your library.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Display</Text>
        <View style={styles.row}>
          <Text style={styles.value}>E-ink Mode</Text>
          <Switch value={settings.isEink} onValueChange={toggleEink} />
        </View>
        {settings.isEink ? (
          <Text style={styles.hint}>
            Animations disabled, high contrast, larger tap targets, paginated scrolling
          </Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Storage</Text>
        <Pressable style={styles.actionButton} onPress={handleClearCache}>
          <Text style={styles.actionButtonText}>Clear offline cache</Text>
        </Pressable>
        <Text style={styles.hint}>
          Removes downloaded book files to free space. Books remain in your cloud library.
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
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 24, paddingBottom: 48 },
  section: { marginBottom: 24 },
  label: { fontSize: 12, color: "#999", marginBottom: 8, textTransform: "uppercase" },
  value: { fontSize: 16 },
  hint: { fontSize: 13, color: "#999", marginTop: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  copyButton: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#ddd",
    alignSelf: "flex-start",
  },
  copyButtonText: { fontSize: 13, color: "#333" },
  actionButton: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#ddd",
    alignSelf: "flex-start",
  },
  actionButtonText: { fontSize: 14, color: "#333" },
  signOutButton: {
    borderWidth: 1,
    borderColor: "#dc2626",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 16,
  },
  signOutText: { color: "#dc2626", fontSize: 16, fontWeight: "600" },
  token: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    fontSize: 13,
    color: "#333",
  },
  version: { textAlign: "center", color: "#bbb", fontSize: 12, marginTop: 24 },
});
