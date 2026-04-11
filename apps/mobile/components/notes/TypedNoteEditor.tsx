import { useState, useEffect } from "react";
import {
  View,
  TextInput,
  Pressable,
  Text,
  StyleSheet,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useDisplay } from "../../contexts/DisplayContext";

interface TypedNoteEditorProps {
  visible: boolean;
  initialText?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}

export function TypedNoteEditor({
  visible,
  initialText = "",
  onSave,
  onCancel,
}: TypedNoteEditorProps) {
  const display = useDisplay();
  const [text, setText] = useState(initialText);

  // Reset text when modal opens with new initialText
  useEffect(() => {
    if (visible) setText(initialText);
  }, [visible, initialText]);

  function handleSave() {
    if (text.trim()) {
      onSave(text.trim());
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={display.animationsEnabled ? "fade" : "none"}
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <KeyboardAvoidingView
        style={styles.centerWrap}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        pointerEvents="box-none"
      >
        <View style={styles.card}>
          <View style={styles.header}>
            <Pressable onPress={onCancel} hitSlop={8}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Text style={styles.title}>Note</Text>
            <Pressable onPress={handleSave} hitSlop={8}>
              <Text style={styles.saveText}>Save</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            placeholder="Write your note..."
            textAlignVertical="top"
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.35)" },
  centerWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#fff",
    borderRadius: 14,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  title: { fontSize: 15, fontWeight: "600" },
  cancelText: { fontSize: 14, color: "#666" },
  saveText: { fontSize: 14, color: "#111", fontWeight: "600" },
  input: {
    height: 220,
    fontSize: 15,
    lineHeight: 22,
    padding: 14,
  },
});
