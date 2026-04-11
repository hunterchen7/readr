import { useState, useRef, useMemo, useEffect } from "react";
import { View, Pressable, Text, StyleSheet, Modal, PanResponder } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { Stroke, StrokePoint, PenConfig } from "@readr/shared";
import { useDisplay } from "../../contexts/DisplayContext";

interface HandwritingCanvasProps {
  visible: boolean;
  initialStrokes?: Stroke[];
  onSave: (strokes: Stroke[], penConfig: PenConfig) => void;
  onCancel: () => void;
}

const PEN_SIZES = [2, 4, 8];
const PEN_COLORS = ["#000000", "#dc2626", "#2563eb"];

/** Convert stroke points to an SVG path string */
function pointsToPath(points: StrokePoint[]): string {
  if (points.length === 0) return "";
  const first = points[0];
  let d = `M${first.x.toFixed(1)},${first.y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L${points[i].x.toFixed(1)},${points[i].y.toFixed(1)}`;
  }
  return d;
}

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

  // Reset the canvas whenever the modal opens. useState(initialStrokes)
  // only runs on first mount; without this, opening the drawing modal
  // for a fresh note shows the strokes from whichever drawing was
  // edited last.
  useEffect(() => {
    if (visible) {
      setStrokes(initialStrokes);
      setCurrentStroke([]);
      activeStrokeRef.current = [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Keep the active stroke in a ref so the PanResponder callbacks (which
  // are memoized once on mount) always see the latest points without
  // closing over stale state.
  const activeStrokeRef = useRef<StrokePoint[]>([]);
  // Latest tool/pen settings — again via ref so PanResponder doesn't
  // need to be torn down and rebuilt when the user switches color/width.
  const toolRef = useRef({ color: penColor, width: penWidth, isEraser });
  toolRef.current = { color: penColor, width: penWidth, isEraser };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (evt) => {
          const ne = evt?.nativeEvent;
          if (!ne) return;
          const point: StrokePoint = {
            x: ne.locationX ?? 0,
            y: ne.locationY ?? 0,
            pressure: (ne as { force?: number }).force ?? 0.5,
          };
          activeStrokeRef.current = [point];
          setCurrentStroke([point]);
        },
        onPanResponderMove: (evt) => {
          const ne = evt?.nativeEvent;
          if (!ne) return;
          const point: StrokePoint = {
            x: ne.locationX ?? 0,
            y: ne.locationY ?? 0,
            pressure: (ne as { force?: number }).force ?? 0.5,
          };
          activeStrokeRef.current = [...activeStrokeRef.current, point];
          setCurrentStroke(activeStrokeRef.current);
        },
        onPanResponderRelease: () => commitStroke(),
        onPanResponderTerminate: () => commitStroke(),
      }),
    // PanResponder is created once; the tool settings are read from a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function commitStroke() {
    const points = activeStrokeRef.current;
    if (points.length === 0) return;
    const { color, width, isEraser: erasing } = toolRef.current;
    if (erasing) {
      setStrokes((prev) =>
        prev.filter((s) => {
          for (const ep of points) {
            for (const sp of s.points) {
              const dx = ep.x - sp.x;
              const dy = ep.y - sp.y;
              if (dx * dx + dy * dy < 400) return false; // 20px radius
            }
          }
          return true;
        }),
      );
    } else {
      setStrokes((prev) => [...prev, { points, color, width }]);
    }
    activeStrokeRef.current = [];
    setCurrentStroke([]);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={display.animationsEnabled ? "fade" : "none"}
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.centerWrap} pointerEvents="box-none">
       <View style={styles.card}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={8}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Draw</Text>
          <Pressable onPress={() => onSave(strokes, { color: penColor, width: penWidth })} hitSlop={8}>
            <Text style={styles.saveText}>Save</Text>
          </Pressable>
        </View>

        {/* Pen toolbar */}
        <View style={styles.toolbar}>
          {PEN_SIZES.map((size) => (
            <Pressable
              key={size}
              style={[styles.sizeButton, penWidth === size && styles.sizeButtonActive]}
              onPress={() => { setPenWidth(size); setIsEraser(false); }}
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
              onPress={() => { setPenColor(color); setIsEraser(false); }}
            />
          ))}

          <View style={styles.separator} />

          <Pressable
            style={[styles.toolButton, isEraser && styles.toolButtonActive]}
            onPress={() => setIsEraser(!isEraser)}
          >
            <Text style={[styles.toolButtonText, isEraser && { color: "#fff" }]}>Eraser</Text>
          </Pressable>

          <Pressable style={styles.toolButton} onPress={() => setStrokes((p) => p.slice(0, -1))}>
            <Text style={styles.toolButtonText}>Undo</Text>
          </Pressable>

          <Pressable style={styles.toolButton} onPress={() => setStrokes([])}>
            <Text style={styles.toolButtonText}>Clear</Text>
          </Pressable>
        </View>

        {/* Canvas with SVG rendering */}
        <View style={styles.canvas} {...panResponder.panHandlers}>
          <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            {/* Completed strokes */}
            {strokes.map((s, i) => (
              <Path
                key={i}
                d={pointsToPath(s.points)}
                stroke={s.color}
                strokeWidth={s.width}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            ))}
            {/* Active stroke being drawn */}
            {currentStroke.length > 0 ? (
              <Path
                d={pointsToPath(currentStroke)}
                stroke={isEraser ? "#ccc" : penColor}
                strokeWidth={isEraser ? 20 : penWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity={isEraser ? 0.5 : 1}
              />
            ) : null}
          </Svg>
        </View>
       </View>
      </View>
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
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
    gap: 6,
    flexWrap: "wrap",
  },
  sizeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  sizeButtonActive: { borderColor: "#111" },
  colorDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorDotActive: { borderColor: "#111" },
  separator: { width: 1, height: 20, backgroundColor: "#e0e0e0" },
  toolButton: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  toolButtonActive: { backgroundColor: "#111", borderColor: "#111" },
  toolButtonText: { fontSize: 11, color: "#666" },
  canvas: {
    height: 320,
    backgroundColor: "#fafafa",
  },
});
