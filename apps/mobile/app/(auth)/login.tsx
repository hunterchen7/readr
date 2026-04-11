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
import { colors, spacing, fontSize } from "../../lib/theme";

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

  // Explicit selectors — zustand v5 re-renders the whole tree and
  // can trip "Maximum update depth" when subscribing to the full store.
  const setStoreServerUrl = useAuthStore((s) => s.setServerUrl);
  const loginDirect = useAuthStore((s) => s.loginDirect);

  async function handleSendCode() {
    // Accept bare hostnames by prepending https://. Avoids the cryptic
    // "Failed to construct 'URL': Invalid URL" from fetch() on web.
    let url = serverUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
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
      let url = serverUrl.trim().replace(/\/$/, "");
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      const token = await api.emailLoginVerify(url, email.trim().toLowerCase(), c);
      await setStoreServerUrl(url);
      await api.setToken(token);
      loginDirect(token);
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
                  placeholder="https://readr-api.hunterchen.ca"
                  placeholderTextColor={colors.textMuted}
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
              placeholder="hello@hunterchen.ca"
              placeholderTextColor={colors.textMuted}
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
  container: { flex: 1, backgroundColor: colors.background },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xxl,
  },
  title: { fontSize: fontSize.title, fontWeight: "bold", textAlign: "center", marginBottom: spacing.xxl },
  // Cap the form at a comfortable reading width on wide screens. On
  // mobile the view is narrower than this so the cap is inert.
  form: { gap: spacing.md, width: "100%", maxWidth: 380 },
  label: { fontSize: fontSize.sm, color: colors.textSecondary },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: spacing.md,
    fontSize: fontSize.lg,
  },
  codeInput: {
    fontSize: 24,
    letterSpacing: 8,
    textAlign: "center",
    fontWeight: "600",
  },
  helper: { color: colors.textSecondary, fontSize: fontSize.md, lineHeight: 20 },
  error: { color: colors.error, fontSize: fontSize.md },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    padding: fontSize.md,
    alignItems: "center",
    marginTop: spacing.xs,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.primaryFg, fontSize: fontSize.lg, fontWeight: "600" },
  backLink: { color: colors.textSecondary, fontSize: fontSize.md, textAlign: "center", marginTop: spacing.sm },
});
