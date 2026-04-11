/**
 * Web stub for the reader screen. The native reader relies on
 * react-native-webview, expo-speech, expo-av, expo-file-system and a
 * bunch of other mobile-only modules — none of which make sense in a
 * browser where foliate-js can just render into the DOM directly.
 *
 * Rather than try to force the WebView-based reader to run on web, we
 * ship this placeholder screen today. A proper web reader (foliate-js
 * + pdf.js rendered into the host document, no iframe shell) is
 * tracked as a follow-up once the upload/library flow is stable.
 *
 * Metro's platform-extension resolver picks this file on web and
 * leaves `reader/[bookId].tsx` untouched for iOS/Android.
 */
import { View, Text, Pressable, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { BookOpen, ArrowLeft } from "lucide-react-native";
import { colors, spacing, fontSize } from "../../lib/theme";

export default function ReaderStub() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();

  return (
    <View style={styles.container}>
      <Pressable style={styles.backRow} onPress={() => router.back()}>
        <ArrowLeft size={18} color={colors.text} />
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      <View style={styles.center}>
        <BookOpen size={48} color={colors.textMuted} />
        <Text style={styles.title}>Reader coming soon on web</Text>
        <Text style={styles.body}>
          The in-browser reader is still in progress. For now, use the
          mobile app to read books. Uploads, the library and book
          details all work here.
        </Text>
        {bookId ? (
          <Text style={styles.meta}>Book ID: {bookId}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.lg,
  },
  backText: {
    fontSize: fontSize.md,
    color: colors.text,
    fontWeight: "500",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xxl,
    gap: spacing.md,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
  },
  body: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: "center",
    maxWidth: 420,
    lineHeight: 22,
  },
  meta: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.md,
  },
});
