/**
 * Thin wrapper over whatever platform TTS engine we use. Native
 * targets expo-speech; the sibling `.web.ts` file uses the browser's
 * built-in SpeechSynthesis API. `tts-store.ts` owns chunking and
 * zustand state; this file only deals with "say this one chunk".
 */
import * as Speech from "expo-speech";

export interface SpeakChunkOptions {
  rate?: number;
  pitch?: number;
  voice?: string | null;
  onDone?: () => void;
  onError?: () => void;
}

export function speakChunk(text: string, opts: SpeakChunkOptions): void {
  Speech.speak(text, {
    rate: opts.rate,
    pitch: opts.pitch,
    voice: opts.voice ?? undefined,
    onDone: opts.onDone,
    onError: opts.onError,
  });
}

export function stopSpeaking(): void {
  Speech.stop();
}

export function pauseSpeaking(): void {
  Speech.pause();
}

export function resumeSpeaking(): void {
  Speech.resume();
}
