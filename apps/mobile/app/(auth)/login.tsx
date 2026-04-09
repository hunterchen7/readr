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
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import Constants from "expo-constants";
import { useAuthStore } from "../../lib/auth-store";
import * as api from "../../lib/api";

const DEFAULT_SERVER_URL =
  (Constants.expoConfig?.extra?.defaultServerUrl as string | undefined) ?? "";

type Step = "email" | "code";

export default function LoginScreen() {
  const [serverUrl, setServerUrlLocal] = useState(DEFAULT_SERVER_URL);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const authStore = useAuthStore();

  async function handleSendCode() {
    const url = serverUrl.trim();
    if (!url) { setError("Server URL is required"); return; }
    const em = email.trim().toLowerCase();
    if (!em || !em.includes("@")) { setError("Enter a valid email"); return; }

    setError("");
    setLoading(true);
    try {
      await api.emailLoginStart(url, em);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode() {
    const c = code.trim();
    if (c.length !== 6) { setError("Enter the 6-digit code"); return; }

    setError("");
    setLoading(true);
    try {
      const url = serverUrl.trim().replace(/\/$/, "");
      const token = await api.emailLoginVerify(url, email.trim().toLowerCase(), c);
      await authStore.setServerUrl(url);
      await api.setToken(token);
      authStore.loginDirect(token);
      router.replace("/(tabs)/library");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
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

        {step === "email" ? (
          <View style={styles.form}>
            {!DEFAULT_SERVER_URL ? (
              <>
                <Text style={styles.label}>Server URL</Text>
                <TextInput
                  style={styles.input}
                  placeholder="https://readr.example.com"
                  value={serverUrl}
                  onChangeText={setServerUrlLocal}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </>
            ) : null}

            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoFocus
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleSendCode}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Continue</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <View style={styles.form}>
            <Text style={styles.helper}>
              Code sent to {email.trim().toLowerCase()}
            </Text>

            <TextInput
              style={[styles.input, styles.codeInput]}
              placeholder="000000"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleVerifyCode}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Sign in</Text>
              )}
            </Pressable>

            <Pressable onPress={() => { setStep("email"); setCode(""); setError(""); }}>
              <Text style={styles.backLink}>← Back</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  scroll: { flexGrow: 1, justifyContent: "center", padding: 24 },
  title: { fontSize: 28, fontWeight: "bold", textAlign: "center", marginBottom: 24 },
  form: { gap: 12 },
  label: { fontSize: 13, color: "#666" },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  codeInput: {
    fontSize: 24,
    letterSpacing: 8,
    textAlign: "center",
    fontWeight: "600",
  },
  helper: { color: "#666", fontSize: 14, lineHeight: 20 },
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
  backLink: { color: "#666", fontSize: 14, textAlign: "center", marginTop: 8 },
});
