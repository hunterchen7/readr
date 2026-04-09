import * as SecureStore from "expo-secure-store";
import type { ReaderTheme } from "../components/reader/ReaderControls";

const KEY = "readerPrefs";

/**
 * Persisted reader preferences. Stored in SecureStore (the same place as
 * the bearer token) as a JSON blob — they're small, per-device, and don't
 * need to be synced across devices.
 */
export interface ReaderPrefs {
  theme: ReaderTheme;
}

export async function loadReaderPrefs(): Promise<ReaderPrefs | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ReaderPrefs;
  } catch {
    return null;
  }
}

export async function saveReaderPrefs(prefs: ReaderPrefs): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn("saveReaderPrefs failed:", err);
  }
}
