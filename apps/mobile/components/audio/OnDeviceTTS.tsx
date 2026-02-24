import { useState, useCallback, useRef, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, Modal } from "react-native";
import * as Speech from "expo-speech";
import { useDisplay } from "../../contexts/DisplayContext";

interface OnDeviceTTSProps {
  visible: boolean;
  text: string;
  bookTitle: string;
  onClose: () => void;
  onPositionUpdate?: (charIndex: number) => void;
}

/**
 * On-device TTS using expo-speech (OS-native voices).
 * Zero bundle cost, works offline, no server needed.
 * Quality varies by device/voice — iOS Siri Enhanced voices are best.
 */
export function OnDeviceTTS({
  visible,
  text,
  bookTitle,
  onClose,
  onPositionUpdate,
}: OnDeviceTTSProps) {
  const display = useDisplay();
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [rate, setRate] = useState(1.0);
  const [voices, setVoices] = useState<Speech.Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string | undefined>();
  const charIndexRef = useRef(0);

  const RATES = [0.75, 1.0, 1.25, 1.5];

  useEffect(() => {
    Speech.getAvailableVoicesAsync().then((v) => {
      // Filter to English voices and sort by quality
      const englishVoices = v.filter(
        (voice) => voice.language.startsWith("en"),
      );
      setVoices(englishVoices);
      // Prefer enhanced/premium voices
      const enhanced = englishVoices.find(
        (voice) => voice.quality === "Enhanced" || voice.name?.includes("Enhanced"),
      );
      if (enhanced) {
        setSelectedVoice(enhanced.identifier);
      }
    });
  }, []);

  const speak = useCallback(() => {
    if (!text) return;

    Speech.speak(text, {
      rate,
      voice: selectedVoice,
      onStart: () => setIsSpeaking(true),
      onDone: () => setIsSpeaking(false),
      onStopped: () => setIsSpeaking(false),
      onError: () => setIsSpeaking(false),
    });
  }, [text, rate, selectedVoice]);

  function stop() {
    Speech.stop();
    setIsSpeaking(false);
  }

  function togglePlayPause() {
    if (isSpeaking) {
      stop();
    } else {
      speak();
    }
  }

  function cycleRate() {
    const idx = RATES.indexOf(rate);
    const next = RATES[(idx + 1) % RATES.length];
    setRate(next);
    // Restart if currently speaking with new rate
    if (isSpeaking) {
      stop();
      setTimeout(() => {
        Speech.speak(text, {
          rate: next,
          voice: selectedVoice,
          onStart: () => setIsSpeaking(true),
          onDone: () => setIsSpeaking(false),
          onStopped: () => setIsSpeaking(false),
        });
      }, 100);
    }
  }

  function handleClose() {
    stop();
    onClose();
  }

  return (
    <Modal
      visible={visible}
      animationType={display.animationsEnabled ? "slide" : "none"}
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={handleClose}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.content}>
          <Text style={styles.title} numberOfLines={2}>{bookTitle}</Text>
          <Text style={styles.badge}>Device TTS</Text>

          <View style={styles.preview}>
            <Text style={styles.previewText} numberOfLines={5}>
              {text.slice(0, 500)}
              {text.length > 500 ? "..." : ""}
            </Text>
          </View>

          <View style={styles.controls}>
            <Pressable
              style={[styles.playButton, { minHeight: display.minTapTarget }]}
              onPress={togglePlayPause}
            >
              <Text style={styles.playText}>
                {isSpeaking ? "Stop" : "Read Aloud"}
              </Text>
            </Pressable>

            <Pressable style={styles.rateButton} onPress={cycleRate}>
              <Text style={styles.rateText}>{rate}x</Text>
            </Pressable>
          </View>

          {voices.length > 0 ? (
            <View style={styles.voiceInfo}>
              <Text style={styles.voiceLabel}>
                Voice: {voices.find((v) => v.identifier === selectedVoice)?.name ?? "System Default"}
              </Text>
              <Text style={styles.voiceHint}>
                For better quality, download Enhanced/Premium voices in device Settings.
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    alignItems: "flex-end",
  },
  closeText: { fontSize: 16, color: "#111", fontWeight: "600" },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 24, alignItems: "center" },
  title: { fontSize: 18, fontWeight: "700", textAlign: "center", marginBottom: 8 },
  badge: {
    fontSize: 11,
    color: "#666",
    backgroundColor: "#f0f0f0",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: "hidden",
    marginBottom: 24,
  },
  preview: {
    backgroundColor: "#fafafa",
    borderRadius: 12,
    padding: 16,
    width: "100%",
    marginBottom: 32,
  },
  previewText: { fontSize: 14, lineHeight: 22, color: "#444" },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginBottom: 24,
  },
  playButton: {
    backgroundColor: "#111",
    borderRadius: 24,
    paddingHorizontal: 32,
    justifyContent: "center",
    alignItems: "center",
  },
  playText: { fontSize: 16, color: "#fff", fontWeight: "600" },
  rateButton: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  rateText: { fontSize: 14, fontWeight: "600" },
  voiceInfo: { alignItems: "center" },
  voiceLabel: { fontSize: 13, color: "#666", marginBottom: 4 },
  voiceHint: { fontSize: 11, color: "#999", textAlign: "center", maxWidth: 280 },
});
