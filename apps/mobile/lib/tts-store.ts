import { create } from "zustand";
import {
  speakChunk,
  stopSpeaking,
  pauseSpeaking,
  resumeSpeaking,
} from "./tts-engine";

export type TtsState = "idle" | "playing" | "paused";

interface TtsStoreState {
  state: TtsState;
  rate: number;
  pitch: number;
  voice: string | null;

  /** Speak a block of text. Breaks it on sentence boundaries so
   *  Android's 4000-char TTS buffer doesn't truncate long passages. */
  speak: (text: string, opts?: { onDone?: () => void }) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setRate: (rate: number) => void;
  setPitch: (pitch: number) => void;
}

function splitForSpeech(text: string): string[] {
  // Break on sentence-ending punctuation followed by whitespace/newline.
  // Falls back to splitting by newlines if the text has no periods
  // (e.g., a page of poetry), and finally by fixed-length chunks.
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+[\s"']*|[^.!?]+$/g);
  if (!sentences || sentences.length === 0) return chunkFixed(clean);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length > 3500) {
      if (buf) out.push(buf.trim());
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) out.push(buf.trim());
  return out;
}

function chunkFixed(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 3500) {
    out.push(text.slice(i, i + 3500));
  }
  return out;
}

export const useTtsStore = create<TtsStoreState>((set, get) => ({
  state: "idle",
  rate: 1.0,
  pitch: 1.0,
  voice: null,

  speak: (text, opts) => {
    const { rate, pitch, voice } = get();
    const chunks = splitForSpeech(text);
    if (chunks.length === 0) {
      opts?.onDone?.();
      return;
    }

    stopSpeaking();
    set({ state: "playing" });

    let index = 0;
    const speakNext = () => {
      if (index >= chunks.length) {
        set({ state: "idle" });
        opts?.onDone?.();
        return;
      }
      const chunk = chunks[index++];
      speakChunk(chunk, {
        rate,
        pitch,
        voice,
        onDone: () => {
          // Only advance if we haven't been paused/stopped in the
          // meantime.
          if (get().state === "playing") speakNext();
        },
        onError: () => {
          set({ state: "idle" });
        },
      });
    };
    speakNext();
  },

  pause: () => {
    pauseSpeaking();
    set({ state: "paused" });
  },

  resume: () => {
    resumeSpeaking();
    set({ state: "playing" });
  },

  stop: () => {
    stopSpeaking();
    set({ state: "idle" });
  },

  setRate: (rate) => set({ rate }),
  setPitch: (pitch) => set({ pitch }),
}));
