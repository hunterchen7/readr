import { View, Text, Pressable, StyleSheet } from "react-native";
import { RotateCw, AlertCircle } from "lucide-react-native";
import { colors, spacing, fontSize } from "../lib/theme";
import { useDisplay } from "../contexts/DisplayContext";

interface ErrorFallbackProps {
  /** Short, user-facing description of what failed. */
  title?: string;
  /** Full error message — usually `error.message`. Shown below the title in a muted tone. */
  message?: string;
  /** Called when the user taps the retry button. */
  onRetry?: () => void;
  /** Label on the retry button. Defaults to "Retry". */
  retryLabel?: string;
}

/**
 * Shared error state. Every screen that can fail should render this so
 * errors consistently offer a way to recover instead of stranding the
 * user. Pair with a query's `refetch` for React Query, or with a
 * manual re-fetch closure for imperative flows.
 *
 * E-ink safe: no animations, high-contrast text, large tap target.
 */
export function ErrorFallback({ title = "Something went wrong", message, onRetry, retryLabel = "Retry" }: ErrorFallbackProps) {
  const display = useDisplay();
  const iconColor = display.isEink ? "#000" : colors.error;
  return (
    <View style={styles.container}>
      <AlertCircle size={32} color={iconColor} strokeWidth={display.isEink ? 2.5 : 2} />
      <Text style={[styles.title, display.isEink && { color: "#000" }]}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          style={({ pressed }) => [
            styles.button,
            pressed && !display.isEink && { opacity: 0.7 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={retryLabel}
        >
          <RotateCw size={16} color={colors.primaryFg} />
          <Text style={styles.buttonText}>{retryLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xxl,
    gap: spacing.md,
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: "600",
    color: colors.error,
    textAlign: "center",
  },
  message: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: -spacing.sm,
    maxWidth: 320,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 8,
    marginTop: spacing.sm,
    minHeight: 44, // iOS HIG tap target
  },
  buttonText: {
    color: colors.primaryFg,
    fontSize: fontSize.md,
    fontWeight: "600",
  },
});
