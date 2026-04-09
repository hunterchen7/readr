import { useState, useCallback } from "react";
import { View, Pressable, Text, StyleSheet, Modal } from "react-native";
import type { Stroke, StrokePoint, PenConfig } from "@readr/shared";
import { useDisplay } from "../../contexts/DisplayContext";

// Note: This component uses a basic touch-based drawing approach.
// @shopify/react-native-skia integration for pressure-sensitive drawing
// will be added when dev client build is configured.

interface HandwritingCanvasProps {
  visible: boolean;
  initialStrokes?: Stroke[];
  onSave: (strokes: Stroke[], penConfig: PenConfig) => void;
  onCancel: () => void;
}

const PEN_SIZES = [2, 4, 8];
const PEN_COLORS = ["#000000", "#dc2626", "#2563eb"];

export function HandwritingCanvas({
  visible,
  initialStrokes = [],
  onSave,
  onCancel,
}: HandwritingCanvasProps) {
  const display = useDisplay();
  const [strokes, setStrokes] = useState<Stroke[]>(initialStrokes);
  const [currentStroke, setCurrentStroke] = useState<StrokePoint[]>([]);
  const [penColor, setPenColor] = useState("#000000");
  const [penWidth, setPenWidth] = useState(4);
  const [isEraser, setIsEraser] = useState(false);

  const handleTouchStart = useCallback(
    (e: { nativeEvent: { locationX: number; locationY: number; force?: number } }) => {
      const point: StrokePoint = {
        x: e.nativeEvent.locationX,
        y: e.nativeEvent.locationY,
        pressure: e.nativeEvent.force ?? 0.5,
      };
      setCurrentStroke([point]);
    },
    [],
  );

  const handleTouchMove = useCallback(
    (e: { nativeEvent: { locationX: number; locationY: number; force?: number } }) => {
      const point: StrokePoint = {
        x: e.nativeEvent.locationX,
        y: e.nativeEvent.locationY,
        pressure: e.nativeEvent.force ?? 0.5,
      };
      setCurrentStroke((prev) => [...prev, point]);
    },
    [],
  );

  const handleTouchEnd = useCallback(() => {
    if (currentStroke.length > 0) {
      if (isEraser) {
        // Simple eraser: remove strokes near the touch points
        // Full eraser implementation will use Skia hit testing
      } else {
        setStrokes((prev) => [
          ...prev,
          { points: currentStroke, color: penColor, width: penWidth },
        ]);
      }
      setCurrentStroke([]);
    }
  }, [currentStroke, penColor, penWidth, isEraser]);

  function handleSave() {
    onSave(strokes, { color: penColor, width: penWidth });
  }

  function handleUndo() {
    setStrokes((prev) => prev.slice(0, -1));
  }

  function handleClear() {
    setStrokes([]);
  }

  return (
    <Modal
      visible={visible}
      animationType={display.animationsEnabled ? "slide" : "none"}
      presentationStyle="fullScreen"
      onRequestClose={onCancel}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Handwriting</Text>
          <Pressable onPress={handleSave}>
            <Text style={styles.saveText}>Save</Text>
          </Pressable>
        </View>

        {/* Pen toolbar */}
        <View style={styles.toolbar}>
          {PEN_SIZES.map((size) => (
            <Pressable
              key={size}
              style={[styles.sizeButton, penWidth === size && styles.sizeButtonActive]}
              onPress={() => {
                setPenWidth(size);
                setIsEraser(false);
              }}
            >
              <View
                style={{
                  width: size * 2,
                  height: size * 2,
                  borderRadius: size,
                  backgroundColor: penWidth === size ? "#111" : "#999",
                }}
              />
            </Pressable>
          ))}

          <View style={styles.separator} />

          {PEN_COLORS.map((color) => (
            <Pressable
              key={color}
              style={[
                styles.colorDot,
                { backgroundColor: color },
                penColor === color && !isEraser && styles.colorDotActive,
              ]}
              onPress={() => {
                setPenColor(color);
                setIsEraser(false);
              }}
            />
          ))}

          <View style={styles.separator} />

          <Pressable
            style={[styles.toolButton, isEraser && styles.toolButtonActive]}
            onPress={() => setIsEraser(!isEraser)}
          >
            <Text style={styles.toolButtonText}>Eraser</Text>
          </Pressable>

          <Pressable style={styles.toolButton} onPress={handleUndo}>
            <Text style={styles.toolButtonText}>Undo</Text>
          </Pressable>

          <Pressable style={styles.toolButton} onPress={handleClear}>
            <Text style={styles.toolButtonText}>Clear</Text>
          </Pressable>
        </View>

        {/* Canvas area — basic touch tracking.
            Full Skia canvas will be integrated when dev client is available. */}
        <View
          style={styles.canvas}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <Text style={styles.canvasPlaceholder}>
            {strokes.length > 0
              ? `${strokes.length} stroke(s) recorded`
              : "Draw here — Skia rendering will be added with dev client"}
          </Text>
        </View>
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
    paddingTop: 48,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  title: { fontSize: 17, fontWeight: "600" },
  cancelText: { fontSize: 16, color: "#666" },
  saveText: { fontSize: 16, color: "#111", fontWeight: "600" },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
    gap: 8,
  },
  sizeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  sizeButtonActive: { borderColor: "#111" },
  colorDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorDotActive: { borderColor: "#111" },
  separator: { width: 1, height: 24, backgroundColor: "#e0e0e0" },
  toolButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  toolButtonActive: { backgroundColor: "#111", borderColor: "#111" },
  toolButtonText: { fontSize: 12, color: "#666" },
  canvas: {
    flex: 1,
    backgroundColor: "#fafafa",
    justifyContent: "center",
    alignItems: "center",
  },
  canvasPlaceholder: { color: "#999", textAlign: "center" },
});
