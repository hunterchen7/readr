import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTtsStore } from "../../lib/tts-store";

interface TtsBarProps {
  onRequestPageText: () => void;
  onNextPage: () => void;
  onStop: () => void;
}

/**
 * Floating bottom bar shown when TTS playback is active. Parent
 * manages the "get current page text" flow via onRequestPageText,
 * which should ultimately call `useTtsStore().speak(...)`.
 */
export function TtsBar({ onRequestPageText, onNextPage, onStop }: TtsBarProps) {
  const state = useTtsStore((s) => s.state);
  const rate = useTtsStore((s) => s.rate);
  const setRate = useTtsStore((s) => s.setRate);
  const pause = useTtsStore((s) => s.pause);
  const resume = useTtsStore((s) => s.resume);
  const stop = useTtsStore((s) => s.stop);

  if (state === "idle") return null;

  return (
    <View style={styles.bar}>
      <Pressable
        style={styles.btn}
        onPress={() => {
          stop();
          onStop();
        }}
      >
        <Text style={styles.btnText}>■</Text>
      </Pressable>
      {state === "playing" ? (
        <Pressable style={styles.btn} onPress={pause}>
          <Text style={styles.btnText}>⏸</Text>
        </Pressable>
      ) : (
        <Pressable style={styles.btn} onPress={resume}>
          <Text style={styles.btnText}>▶</Text>
        </Pressable>
      )}
      <Pressable
        style={styles.btn}
        onPress={() => {
          onNextPage();
          setTimeout(onRequestPageText, 200);
        }}
      >
        <Text style={styles.btnText}>⏭</Text>
      </Pressable>
      <View style={styles.rateBlock}>
        <Pressable
          style={styles.rateBtn}
          onPress={() => setRate(Math.max(0.5, rate - 0.1))}
        >
          <Text style={styles.rateBtnText}>−</Text>
        </Pressable>
        <Text style={styles.rateLabel}>{rate.toFixed(1)}×</Text>
        <Pressable
          style={styles.rateBtn}
          onPress={() => setRate(Math.min(2.0, rate + 0.1))}
        >
          <Text style={styles.rateBtnText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 60,
    backgroundColor: "rgba(17,17,17,0.9)",
    borderRadius: 28,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  btn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: { color: "#fff", fontSize: 16 },
  rateBlock: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rateBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  rateBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  rateLabel: { color: "#fff", fontSize: 13, minWidth: 30, textAlign: "center" },
});
