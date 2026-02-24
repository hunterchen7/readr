import { useState } from "react";
import { View, TextInput, Pressable, Text, StyleSheet, Modal } from "react-native";

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
  const [text, setText] = useState(initialText);

  function handleSave() {
    if (text.trim()) {
      onSave(text.trim());
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onCancel}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Note</Text>
          <Pressable onPress={handleSave}>
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
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  title: { fontSize: 17, fontWeight: "600" },
  cancelText: { fontSize: 16, color: "#666" },
  saveText: { fontSize: 16, color: "#111", fontWeight: "600" },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 24,
    padding: 16,
  },
});
