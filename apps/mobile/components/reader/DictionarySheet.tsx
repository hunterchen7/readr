import { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  ScrollView,
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

const MAX_DEFS_PER_POS = 3;

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
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <View style={styles.wordRow}>
              <Text style={styles.word}>{state.result.word}</Text>
              {state.result.pronunciation ? (
                <Text style={styles.pronunciation}>
                  {state.result.pronunciation}
                </Text>
              ) : null}
            </View>
            {state.result.groups.map((group, gi) => {
              const defs = group.definitions.slice(0, MAX_DEFS_PER_POS);
              return (
                <View key={gi} style={styles.posGroup}>
                  {group.pos ? (
                    <Text style={styles.pos}>{group.pos}</Text>
                  ) : null}
                  {defs.map((d, di) => (
                    <View key={di} style={styles.defRow}>
                      {defs.length > 1 ? (
                        <Text style={styles.defNum}>{di + 1}.</Text>
                      ) : null}
                      <View style={styles.defBody}>
                        <Text style={styles.definition}>{d.definition}</Text>
                        {d.example ? (
                          <Text style={styles.example}>"{d.example}"</Text>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>
              );
            })}
          </ScrollView>
        ) : (
          <View style={styles.body}>
            <Text style={styles.notFoundTitle}>Word not found</Text>
            <Text style={styles.notFoundSubtitle} numberOfLines={2}>
              "{query.trim()}" isn't in the dictionary.
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
    maxHeight: 300,
  },
  bodyContent: {
    paddingVertical: 12,
  },
  wordRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    flexWrap: "wrap",
  },
  word: { fontSize: 20, fontWeight: "700", color: "#111" },
  pronunciation: { fontSize: 14, color: "#888" },
  posGroup: { marginTop: 10 },
  pos: {
    fontSize: 12,
    color: "#888",
    fontStyle: "italic",
    marginBottom: 4,
  },
  defRow: {
    flexDirection: "row",
    gap: 4,
    marginTop: 2,
  },
  defNum: {
    fontSize: 13,
    color: "#999",
    fontWeight: "600",
    minWidth: 16,
  },
  defBody: { flex: 1 },
  definition: {
    fontSize: 14,
    color: "#222",
    lineHeight: 20,
  },
  example: {
    fontSize: 13,
    color: "#777",
    fontStyle: "italic",
    lineHeight: 18,
    marginTop: 2,
  },
  notFoundTitle: { fontSize: 15, fontWeight: "600", color: "#111" },
  notFoundSubtitle: { fontSize: 13, color: "#666", marginTop: 4 },
});
