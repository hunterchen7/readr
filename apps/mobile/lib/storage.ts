/**
 * Cross-platform key-value storage. Native uses expo-secure-store;
 * web falls back to localStorage (see storage.web.ts).
 *
 * Everything that used to call SecureStore.getItemAsync/setItemAsync/
 * deleteItemAsync directly should go through this wrapper so the same
 * code runs on iOS/Android and web.
 */
import * as SecureStore from "expo-secure-store";

export async function getItem(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

export async function deleteItem(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}
