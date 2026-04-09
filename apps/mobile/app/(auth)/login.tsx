import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { router } from "expo-router";
import Constants from "expo-constants";
import { useAuthStore } from "../../lib/auth-store";
import { generateToken } from "../../lib/api";

const DEFAULT_SERVER_URL =
  (Constants.expoConfig?.extra?.defaultServerUrl as string | undefined) ?? "";

export default function LoginScreen() {
  // Pre-fill from the EXPO_PUBLIC_DEFAULT_SERVER_URL build-time extra so
  // opinionated distributions (e.g. a Readr build shipped to a friend
  // aimed at a specific Olares/Cloudflare tunnel) don't have to type
  // the URL on first launch.
  const [serverUrl, setServerUrlLocal] = useState(DEFAULT_SERVER_URL);
  const [token, setTokenLocal] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const authStore = useAuthStore();

  function handleGenerate() {
    setTokenLocal(generateToken());
  }

  async function handleSubmit() {
    if (!serverUrl.trim()) {
      setError("Server URL is required");
      return;
    }
    if (!token.trim()) {
      setError("Paste an existing token or tap Generate");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await authStore.setServerUrl(serverUrl.trim());
      await authStore.saveToken(token.trim());
      router.replace("/(tabs)/library");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Readr</Text>
        <Text style={styles.subtitle}>Sign in with a device token</Text>

        <View style={styles.form}>
          <Text style={styles.label}>Server URL</Text>
          <TextInput
            style={styles.input}
            placeholder="https://reader.example.com"
            value={serverUrl}
            onChangeText={setServerUrlLocal}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={styles.label}>Device token</Text>
          <TextInput
            style={[styles.input, styles.tokenInput]}
            placeholder="Paste an existing token or tap Generate"
            value={token}
            onChangeText={setTokenLocal}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <Pressable onPress={handleGenerate}>
            <Text style={styles.generate}>Generate new token</Text>
          </Pressable>
          <Text style={styles.helper}>
            Your token is a long random string kept in SecureStore. Treat it
            like a password — anyone who has it can read and write your
            library. Paste the same token on another device to share.
          </Text>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleSubmit}
            disabled={loading}
          >
            <Text style={styles.buttonText}>
              {loading ? "Connecting..." : "Sign in"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  scroll: { flexGrow: 1, justifyContent: "center", padding: 24 },
  title: { fontSize: 32, fontWeight: "bold", textAlign: "center", marginBottom: 4 },
  subtitle: { fontSize: 16, color: "#666", textAlign: "center", marginBottom: 32 },
  form: { gap: 8 },
  label: { fontSize: 13, color: "#666", marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  tokenInput: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    minHeight: 60,
  },
  generate: { color: "#2563eb", fontSize: 14, marginTop: 4 },
  helper: { color: "#888", fontSize: 12, marginTop: 8, lineHeight: 18 },
  error: { color: "#dc2626", fontSize: 14, marginTop: 8 },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 12,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
