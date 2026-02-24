import * as SecureStore from "expo-secure-store";
import type { Book } from "@readr/shared";

const SERVER_URL_KEY = "serverUrl";

export async function getServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_URL_KEY);
}

export async function setServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_URL_KEY, url);
}

export async function clearServerUrl(): Promise<void> {
  await SecureStore.deleteItemAsync(SERVER_URL_KEY);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const serverUrl = await getServerUrl();
  if (!serverUrl) throw new Error("Server URL not configured");

  const res = await fetch(`${serverUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...init?.headers,
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }

  return res.json();
}

// Auth
export function signUp(email: string, password: string, name: string) {
  return apiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
}

export function signIn(email: string, password: string) {
  return apiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function signOut() {
  return apiFetch("/api/auth/sign-out", { method: "POST" });
}

export function getSession() {
  return apiFetch<{ session: unknown; user: unknown }>("/api/auth/get-session");
}

// Books
export function listBooks(sort = "recent", search?: string) {
  const params = new URLSearchParams({ sort });
  if (search) params.set("search", search);
  return apiFetch<{ books: Book[] }>(`/api/books?${params}`);
}

export function getBook(id: string) {
  return apiFetch<{ book: Book }>(`/api/books/${id}`);
}

export function deleteBook(id: string) {
  return apiFetch(`/api/books/${id}`, { method: "DELETE" });
}
