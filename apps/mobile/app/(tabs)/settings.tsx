import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, Switch, ScrollView, Platform } from "react-native";
import { router, useFocusEffect } from "expo-router";
import Constants from "expo-constants";
import { useAuthStore } from "../../lib/auth-store";
import { useDisplayStore } from "../../contexts/DisplayContext";
import { Cloud, Smartphone, Trash2 } from "lucide-react-native";
import { clearAllDownloads, getCacheUsage } from "../../lib/book-cache";
import { listBooks } from "../../lib/api";
import { useQuery } from "@tanstack/react-query";
import { colors, spacing, fontSize } from "../../lib/theme";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default function SettingsScreen() {
  // Explicit selectors — zustand v5 requires them to keep
  // useSyncExternalStore snapshots stable across renders.
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const signOut = useAuthStore((s) => s.signOut);
  const settings = useDisplayStore((s) => s.settings);
  const toggleEink = useDisplayStore((s) => s.toggleEink);
  const [usage, setUsage] = useState<{ bytes: number; count: number } | null>(null);
  // Reuse the same books query the library uses — React Query dedupes
  // so we just read cached data, and can compute cloud totals locally
  // (sum of fileSize across all books) without a separate endpoint.
  const { data: booksData } = useQuery({
    queryKey: ["books", "recent"],
    queryFn: () => listBooks("recent"),
    staleTime: 30_000,
  });
  const cloudUsage = booksData
    ? {
        bytes: booksData.books.reduce((sum, b) => sum + (b.fileSize ?? 0), 0),
        count: booksData.books.length,
      }
    : null;

  const refreshUsage = useCallback(async () => {
    if (Platform.OS === "web") return;
    try {
      setUsage(await getCacheUsage());
    } catch {
      /* non-fatal — leave stale */
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  useFocusEffect(
    useCallback(() => {
      void refreshUsage();
    }, [refreshUsage]),
  );

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
              await refreshUsage();
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
        <Text style={styles.hint}>
          Animations disabled, high contrast, larger tap targets
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Storage</Text>
        <View style={styles.storageCard}>
          <View style={styles.storageRow}>
            <Cloud size={18} color={colors.textSecondary} />
            <View style={styles.storageRowBody}>
              <Text style={styles.storageRowTitle}>Cloud library</Text>
              <Text style={styles.storageRowMeta}>
                {cloudUsage
                  ? `${formatBytes(cloudUsage.bytes)} · ${cloudUsage.count} book${cloudUsage.count === 1 ? "" : "s"}`
                  : "—"}
              </Text>
            </View>
          </View>
          {Platform.OS !== "web" ? (
            <>
              <View style={styles.storageDivider} />
              <View style={styles.storageRow}>
                <Smartphone size={18} color={colors.textSecondary} />
                <View style={styles.storageRowBody}>
                  <Text style={styles.storageRowTitle}>On this device</Text>
                  <Text style={styles.storageRowMeta}>
                    {usage && usage.count > 0
                      ? `${formatBytes(usage.bytes)} · ${usage.count} book${usage.count === 1 ? "" : "s"}`
                      : "No downloads"}
                  </Text>
                </View>
                {usage && usage.count > 0 ? (
                  <Pressable
                    onPress={handleClearCache}
                    hitSlop={8}
                    accessibilityLabel="Clear offline cache"
                    style={styles.storageClearBtn}
                  >
                    <Trash2 size={16} color={colors.error} />
                    <Text style={styles.storageClearText}>Clear</Text>
                  </Pressable>
                ) : null}
              </View>
            </>
          ) : null}
        </View>
        <Text style={styles.hint}>
          Clearing offline downloads frees space on this device. Books stay in your cloud library.
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
  storageCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: "hidden",
  },
  storageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  storageRowBody: { flex: 1 },
  storageRowTitle: { fontSize: fontSize.md, color: colors.text, fontWeight: "500" },
  storageRowMeta: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  storageDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.md + 18 + spacing.md,
  },
  storageClearBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  storageClearText: { fontSize: fontSize.sm, color: colors.error, fontWeight: "500" },
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
