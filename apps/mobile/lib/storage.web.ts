/**
 * Web implementation of the key-value storage wrapper. Backed by
 * localStorage, which is plenty for auth tokens, device IDs and UI
 * preferences. Metro's platform extension resolver (`.web.ts`) picks
 * this file over `storage.ts` when targeting web.
 */

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function getItem(key: string): Promise<string | null> {
  return safeStorage()?.getItem(key) ?? null;
}

export async function setItem(key: string, value: string): Promise<void> {
  safeStorage()?.setItem(key, value);
}

export async function deleteItem(key: string): Promise<void> {
  safeStorage()?.removeItem(key);
}
