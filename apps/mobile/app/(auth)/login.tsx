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
import { useAuthStore } from "../../lib/auth-store";

export default function LoginScreen() {
  const [isRegister, setIsRegister] = useState(false);
  const [serverUrl, setServerUrlLocal] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const authStore = useAuthStore();

  async function handleSubmit() {
    if (!serverUrl.trim()) {
      setError("Server URL is required");
      return;
    }

    setError("");
    setLoading(true);

    try {
      await authStore.setServerUrl(serverUrl.trim());

      if (isRegister) {
        await authStore.signUp(email, password, name);
      } else {
        await authStore.signIn(email, password);
      }

      router.replace("/(tabs)/library");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
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
        <Text style={styles.subtitle}>
          {isRegister ? "Create Account" : "Sign In"}
        </Text>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Server URL (e.g. https://my-server.ts.net)"
            value={serverUrl}
            onChangeText={setServerUrlLocal}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          {isRegister ? (
            <TextInput
              style={styles.input}
              placeholder="Name"
              value={name}
              onChangeText={setName}
            />
          ) : null}

          <TextInput
            style={styles.input}
            placeholder="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />

          <TextInput
            style={styles.input}
            placeholder="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleSubmit}
            disabled={loading}
          >
            <Text style={styles.buttonText}>
              {loading ? "Loading..." : isRegister ? "Register" : "Sign In"}
            </Text>
          </Pressable>

          <Pressable onPress={() => setIsRegister(!isRegister)}>
            <Text style={styles.toggle}>
              {isRegister ? "Already have an account? Sign In" : "Need an account? Register"}
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
  form: { gap: 12 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  error: { color: "#dc2626", fontSize: 14 },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  toggle: { color: "#111", textAlign: "center", marginTop: 16, fontSize: 14 },
});
