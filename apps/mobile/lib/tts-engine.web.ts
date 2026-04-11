/**
 * Web TTS engine backed by the browser's built-in SpeechSynthesis
 * API. Same shape as `tts-engine.ts` so `tts-store.ts` is unaware
 * of the platform split.
 *
 * Browser quirks the store doesn't need to care about:
 *
 *   - SpeechSynthesis.getVoices() is async-loaded on some browsers
 *     (Chrome fires a `voiceschanged` event on first available).
 *     We resolve lazily — store doesn't enumerate voices yet, so
 *     we just pass the string name through.
 *   - Chrome silently stops speaking after ~15s if the tab is
 *     backgrounded. Not our problem here; the store restarts on
 *     the next chunk.
 *   - pause() / resume() are buggy on Safari before 16.4 — fall
 *     back to stop() on failure.
 */

export interface SpeakChunkOptions {
  rate?: number;
  pitch?: number;
  voice?: string | null;
  onDone?: () => void;
  onError?: () => void;
}

function safeSynth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

function pickVoice(name: string | null | undefined): SpeechSynthesisVoice | null {
  if (!name) return null;
  const synth = safeSynth();
  if (!synth) return null;
  const voices = synth.getVoices();
  return voices.find((v) => v.name === name || v.voiceURI === name) ?? null;
}

export function speakChunk(text: string, opts: SpeakChunkOptions): void {
  const synth = safeSynth();
  if (!synth) {
    // No TTS available — immediately call onDone so the store
    // advances through its queue instead of hanging.
    opts.onDone?.();
    return;
  }
  try {
    const u = new SpeechSynthesisUtterance(text);
    if (typeof opts.rate === "number") u.rate = opts.rate;
    if (typeof opts.pitch === "number") u.pitch = opts.pitch;
    const voice = pickVoice(opts.voice ?? null);
    if (voice) u.voice = voice;
    u.onend = () => opts.onDone?.();
    u.onerror = () => opts.onError?.();
    synth.speak(u);
  } catch {
    opts.onError?.();
  }
}

export function stopSpeaking(): void {
  try { safeSynth()?.cancel(); } catch { /* ignore */ }
}

export function pauseSpeaking(): void {
  try { safeSynth()?.pause(); } catch {
    // Some older Safari builds throw — fall back to cancel.
    stopSpeaking();
  }
}

export function resumeSpeaking(): void {
  try { safeSynth()?.resume(); } catch { /* ignore */ }
}
