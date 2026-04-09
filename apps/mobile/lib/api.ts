import * as SecureStore from "expo-secure-store";
import type { Book } from "@readr/shared";

const SERVER_URL_KEY = "serverUrl";
const TOKEN_KEY = "apiToken";

export async function getServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_URL_KEY);
}

export async function setServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_URL_KEY, url);
}

export async function clearServerUrl(): Promise<void> {
  await SecureStore.deleteItemAsync(SERVER_URL_KEY);
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}


async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const serverUrl = await getServerUrl();
  if (!serverUrl) throw new Error("Server URL not configured");
  const token = await getToken();

  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !(init.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${serverUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? `Request failed: ${res.status}`);
    }

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * POST /api/register — create (or no-op if existing) a user row for the
 * given token.
 */
export async function registerToken(
  serverUrl: string,
  token: string,
  name?: string,
): Promise<{ user: { id: string; name: string | null }; created: boolean }> {
  const res = await fetch(`${serverUrl}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Register failed: ${res.status}`);
  }
  return res.json();
}

// === Email login ===

export async function emailLoginStart(
  serverUrl: string,
  email: string,
): Promise<void> {
  const res = await fetch(`${serverUrl}/api/email/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? "Failed to send code");
  }
}

export async function emailLoginVerify(
  serverUrl: string,
  email: string,
  code: string,
): Promise<string> {
  const res = await fetch(`${serverUrl}/api/email/login/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? "Verification failed");
  }
  const data = await res.json();
  return data.token;
}

/**
 * GET /api/books?limit=1 used as a cheap "is the token still valid" probe
 * on app launch. Returns true only on a 2xx.
 */
export async function checkToken(): Promise<boolean> {
  try {
    await apiFetch("/api/books");
    return true;
  } catch {
    return false;
  }
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

export function uploadBook(file: { uri: string; name: string; type: string }) {
  const form = new FormData();
  // React Native FormData file spec — see Expo docs. The any cast is
  // required because DOM FormData types are stricter than RN's.
  form.append("file", file as any);
  return apiFetch<{ book: Book }>(`/api/books`, {
    method: "POST",
    body: form,
  });
}

// === Reading stats ===
export interface StatsSummary {
  totalBooks: number;
  totalReadingMinutes: number;
  totalSessions: number;
  currentStreak: number;
  weeklyMinutes: number;
}

export function getStatsSummary() {
  return apiFetch<StatsSummary>(`/api/stats/summary`);
}

export function getStatsDaily() {
  return apiFetch<{ daily: { date: string; minutes: number }[] }>(
    `/api/stats/daily`,
  );
}

export function logReadingSession(session: {
  bookId: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  startPercentage?: number;
  endPercentage?: number;
}) {
  return apiFetch(`/api/stats/sessions`, {
    method: "POST",
    body: JSON.stringify(session),
  });
}
