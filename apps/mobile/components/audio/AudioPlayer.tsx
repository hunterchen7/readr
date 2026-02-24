import { useState, useRef, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, Modal, FlatList } from "react-native";
import { Audio, type AVPlaybackStatus } from "expo-av";
import { useDisplay } from "../../contexts/DisplayContext";

interface AudioChapter {
  index: number;
  title: string;
  audioUrl: string;
  durationMs?: number;
}

interface AudioPlayerProps {
  visible: boolean;
  bookTitle: string;
  chapters: AudioChapter[];
  onClose: () => void;
}

export function AudioPlayer({
  visible,
  bookTitle,
  chapters,
  onClose,
}: AudioPlayerProps) {
  const display = useDisplay();
  const soundRef = useRef<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentChapter, setCurrentChapter] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);

  const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

  const onPlaybackStatusUpdate = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    setPositionMs(status.positionMillis);
    setDurationMs(status.durationMillis ?? 0);
    setIsPlaying(status.isPlaying);

    if (status.didJustFinish) {
      // Auto-advance to next chapter
      setCurrentChapter((prev) => {
        const next = prev + 1;
        if (next < chapters.length) {
          loadAndPlay(next);
          return next;
        }
        return prev;
      });
    }
  }, [chapters.length]);

  async function loadAndPlay(chapterIndex: number) {
    // Unload previous
    if (soundRef.current) {
      await soundRef.current.unloadAsync();
    }

    const chapter = chapters[chapterIndex];
    if (!chapter) return;

    const { sound } = await Audio.Sound.createAsync(
      { uri: chapter.audioUrl },
      { shouldPlay: true, rate: playbackSpeed },
      onPlaybackStatusUpdate,
    );
    soundRef.current = sound;
    setCurrentChapter(chapterIndex);
  }

  async function togglePlayPause() {
    if (!soundRef.current) {
      if (chapters.length > 0) {
        await loadAndPlay(currentChapter);
      }
      return;
    }

    const status = await soundRef.current.getStatusAsync();
    if (!status.isLoaded) return;

    if (status.isPlaying) {
      await soundRef.current.pauseAsync();
    } else {
      await soundRef.current.playAsync();
    }
  }

  async function skipForward() {
    if (currentChapter < chapters.length - 1) {
      await loadAndPlay(currentChapter + 1);
    }
  }

  async function skipBackward() {
    if (currentChapter > 0) {
      await loadAndPlay(currentChapter - 1);
    }
  }

  async function cycleSpeed() {
    const currentIdx = SPEEDS.indexOf(playbackSpeed);
    const nextIdx = (currentIdx + 1) % SPEEDS.length;
    const newSpeed = SPEEDS[nextIdx];
    setPlaybackSpeed(newSpeed);

    if (soundRef.current) {
      await soundRef.current.setRateAsync(newSpeed, true);
    }
  }

  async function handleClose() {
    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
    setIsPlaying(false);
    setPositionMs(0);
    onClose();
  }

  function formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
  }

  const progressPct = durationMs > 0 ? (positionMs / durationMs) * 100 : 0;

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

        <View style={styles.nowPlaying}>
          <Text style={styles.bookTitle} numberOfLines={2}>{bookTitle}</Text>
          <Text style={styles.chapterTitle} numberOfLines={1}>
            {chapters[currentChapter]?.title ?? `Chapter ${currentChapter + 1}`}
          </Text>
        </View>

        {/* Progress bar */}
        <View style={styles.progressContainer}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
          </View>
          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{formatTime(positionMs)}</Text>
            <Text style={styles.timeText}>{formatTime(durationMs)}</Text>
          </View>
        </View>

        {/* Playback controls */}
        <View style={styles.controls}>
          <Pressable
            style={[styles.controlButton, { minHeight: display.minTapTarget }]}
            onPress={skipBackward}
          >
            <Text style={styles.controlText}>⏮</Text>
          </Pressable>

          <Pressable
            style={[styles.playButton, { minHeight: display.minTapTarget, minWidth: display.minTapTarget }]}
            onPress={togglePlayPause}
          >
            <Text style={styles.playText}>{isPlaying ? "⏸" : "▶"}</Text>
          </Pressable>

          <Pressable
            style={[styles.controlButton, { minHeight: display.minTapTarget }]}
            onPress={skipForward}
          >
            <Text style={styles.controlText}>⏭</Text>
          </Pressable>
        </View>

        {/* Speed control */}
        <Pressable style={styles.speedButton} onPress={cycleSpeed}>
          <Text style={styles.speedText}>{playbackSpeed}x</Text>
        </Pressable>

        {/* Chapter list */}
        <View style={styles.chapterList}>
          <Text style={styles.sectionTitle}>Chapters</Text>
          <FlatList
            data={chapters}
            keyExtractor={(item) => String(item.index)}
            renderItem={({ item }) => (
              <Pressable
                style={[
                  styles.chapterRow,
                  item.index === currentChapter && styles.chapterRowActive,
                ]}
                onPress={() => loadAndPlay(item.index)}
              >
                <Text
                  style={[
                    styles.chapterLabel,
                    item.index === currentChapter && styles.chapterLabelActive,
                  ]}
                  numberOfLines={1}
                >
                  {item.title}
                </Text>
                {item.durationMs ? (
                  <Text style={styles.chapterDuration}>
                    {formatTime(item.durationMs)}
                  </Text>
                ) : null}
              </Pressable>
            )}
          />
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
  nowPlaying: {
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  bookTitle: { fontSize: 18, fontWeight: "700", textAlign: "center", marginBottom: 4 },
  chapterTitle: { fontSize: 14, color: "#666", textAlign: "center" },
  progressContainer: { paddingHorizontal: 24, paddingBottom: 24 },
  progressTrack: {
    height: 4,
    backgroundColor: "#e0e0e0",
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: "#111", borderRadius: 2 },
  timeRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  timeText: { fontSize: 11, color: "#999" },
  controls: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 32,
    paddingBottom: 16,
  },
  controlButton: {
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  controlText: { fontSize: 28 },
  playButton: {
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#111",
    borderRadius: 32,
    paddingHorizontal: 20,
  },
  playText: { fontSize: 28, color: "#fff" },
  speedButton: {
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ddd",
    marginBottom: 16,
  },
  speedText: { fontSize: 14, fontWeight: "600" },
  chapterList: { flex: 1, paddingHorizontal: 16 },
  sectionTitle: { fontSize: 14, fontWeight: "600", marginBottom: 8, color: "#666" },
  chapterRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  chapterRowActive: { backgroundColor: "#f5f5f5" },
  chapterLabel: { flex: 1, fontSize: 14 },
  chapterLabelActive: { fontWeight: "600" },
  chapterDuration: { fontSize: 12, color: "#999", marginLeft: 8 },
});
