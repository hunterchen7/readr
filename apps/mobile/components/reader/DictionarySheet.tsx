import { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  ActivityIndicator,
} from "react-native";
import { X } from "lucide-react-native";
import { lookupWord, type LookupResult } from "../../lib/dictionary";

interface DictionarySheetProps {
  visible: boolean;
  query: string;
  onClose: () => void;
}

type State =
  | { kind: "loading" }
  | { kind: "found"; result: LookupResult }
  | { kind: "notFound" };

export function DictionarySheet({
  visible,
  query,
  onClose,
}: DictionarySheetProps) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!visible || !query) return;
    let cancelled = false;
    setState({ kind: "loading" });
    lookupWord(query).then((result) => {
      if (cancelled) return;
      setState(result ? { kind: "found", result } : { kind: "notFound" });
    });
    return () => {
      cancelled = true;
    };
  }, [visible, query]);

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.headerLabel}>Dictionary</Text>
          <Pressable
            onPress={onClose}
            style={styles.closeButton}
            accessibilityLabel="Close dictionary"
            hitSlop={8}
          >
            <X size={18} color="#444" />
          </Pressable>
        </View>
        {state.kind === "loading" ? (
          <View style={styles.body}>
            <ActivityIndicator size="small" color="#666" />
          </View>
        ) : state.kind === "found" ? (
          <View style={styles.body}>
            <View style={styles.wordRow}>
              <Text style={styles.word}>{state.result.word}</Text>
              {state.result.partOfSpeech ? (
                <Text style={styles.pos}>{state.result.partOfSpeech}</Text>
              ) : null}
            </View>
            <Text style={styles.definition}>{state.result.definition}</Text>
          </View>
        ) : (
          <View style={styles.body}>
            <Text style={styles.notFoundTitle}>Word not found</Text>
            <Text style={styles.notFoundSubtitle} numberOfLines={2}>
              “{query.trim()}” isn’t in the offline dictionary.
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.25)" },
  sheet: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 80,
    backgroundColor: "#fff",
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    paddingBottom: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  headerLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#888",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  closeButton: { padding: 2 },
  body: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 60,
    justifyContent: "center",
  },
  wordRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  word: { fontSize: 20, fontWeight: "700", color: "#111" },
  pos: { fontSize: 12, color: "#888", fontStyle: "italic" },
  definition: {
    fontSize: 14,
    color: "#333",
    marginTop: 6,
    lineHeight: 20,
  },
  notFoundTitle: { fontSize: 15, fontWeight: "600", color: "#111" },
  notFoundSubtitle: { fontSize: 13, color: "#666", marginTop: 4 },
});
