import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { router } from "expo-router";
import { useAuthStore } from "../../lib/auth-store";

export default function SettingsScreen() {
  const { serverUrl, signOut } = useAuthStore();

  async function handleSignOut() {
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

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.label}>Server</Text>
        <Text style={styles.value}>{serverUrl || "Not configured"}</Text>
      </View>

      <Pressable style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", padding: 24 },
  section: { marginBottom: 24 },
  label: { fontSize: 12, color: "#999", marginBottom: 4, textTransform: "uppercase" },
  value: { fontSize: 16 },
  signOutButton: {
    borderWidth: 1,
    borderColor: "#dc2626",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: "auto",
  },
  signOutText: { color: "#dc2626", fontSize: 16, fontWeight: "600" },
});
