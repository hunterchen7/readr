import * as Storage from "./storage";
import type { ReaderTheme } from "../components/reader/ReaderControls";

const KEY = "readerPrefs";

/**
 * Persisted reader preferences — stored via the platform storage wrapper
 * (SecureStore on native, localStorage on web). Small JSON blob, per
 * device, no cross-device sync.
 */
export interface ReaderPrefs {
  theme: ReaderTheme;
}

export async function loadReaderPrefs(): Promise<ReaderPrefs | null> {
  try {
    const raw = await Storage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ReaderPrefs;
  } catch {
    return null;
  }
}

export async function saveReaderPrefs(prefs: ReaderPrefs): Promise<void> {
  try {
    await Storage.setItem(KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn("saveReaderPrefs failed:", err);
  }
}
