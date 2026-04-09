import { useState, useEffect } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
} from "react-native";

interface GotoDialogProps {
  visible: boolean;
  currentPage: number | null;
  totalPages: number | null;
  progressPct: number;
  onClose: () => void;
  /** Jump to a specific page (1..totalPages). */
  onGoToPage: (page: number) => void;
  /** Jump to a fractional position 0..1. */
  onGoToFraction: (fraction: number) => void;
}

/**
 * Small modal invoked by tapping the progress bar at the bottom of
 * the reader. Lets the user type a page number (when a count is
 * known) or a percentage.
 */
export function GotoDialog({
  visible,
  currentPage,
  totalPages,
  progressPct,
  onClose,
  onGoToPage,
  onGoToFraction,
}: GotoDialogProps) {
  const [pageInput, setPageInput] = useState("");
  const [pctInput, setPctInput] = useState("");

  useEffect(() => {
    if (visible) {
      setPageInput(currentPage != null ? String(currentPage) : "");
      setPctInput(String(progressPct));
    }
  }, [visible, currentPage, progressPct]);

  function submitPage() {
    const n = parseInt(pageInput, 10);
    if (!Number.isFinite(n) || n < 1) return;
    if (totalPages && n > totalPages) return;
    onGoToPage(n);
    onClose();
  }

  function submitPct() {
    const n = parseFloat(pctInput);
    if (!Number.isFinite(n) || n < 0 || n > 100) return;
    onGoToFraction(n / 100);
    onClose();
  }

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={styles.dialog}>
        <Text style={styles.title}>Go to…</Text>
        {totalPages != null ? (
          <View style={styles.field}>
            <Text style={styles.label}>Page (1–{totalPages})</Text>
            <View style={styles.row}>
              <TextInput
                style={styles.input}
                value={pageInput}
                onChangeText={setPageInput}
                keyboardType="number-pad"
                returnKeyType="go"
                onSubmitEditing={submitPage}
                autoFocus
              />
              <Pressable style={styles.btn} onPress={submitPage}>
                <Text style={styles.btnText}>Go</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <View style={styles.field}>
          <Text style={styles.label}>Percentage (0–100)</Text>
          <View style={styles.row}>
            <TextInput
              style={styles.input}
              value={pctInput}
              onChangeText={setPctInput}
              keyboardType="decimal-pad"
              returnKeyType="go"
              onSubmitEditing={submitPct}
              autoFocus={totalPages == null}
            />
            <Pressable style={styles.btn} onPress={submitPct}>
              <Text style={styles.btnText}>Go</Text>
            </Pressable>
          </View>
        </View>
        <Pressable style={styles.cancel} onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  dialog: {
    position: "absolute",
    left: 24,
    right: 24,
    bottom: 80,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
  },
  title: { fontSize: 16, fontWeight: "700", marginBottom: 12 },
  field: { marginBottom: 12 },
  label: { fontSize: 12, color: "#666", marginBottom: 4, textTransform: "uppercase" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  btn: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  btnText: { color: "#fff", fontWeight: "600" },
  cancel: { alignItems: "center", marginTop: 4 },
  cancelText: { color: "#666", fontSize: 14 },
});
