import * as Storage from "./storage";
import type { Book } from "@readr/shared";

const SERVER_URL_KEY = "serverUrl";
const TOKEN_KEY = "apiToken";

export async function getServerUrl(): Promise<string | null> {
  return Storage.getItem(SERVER_URL_KEY);
}

export async function setServerUrl(url: string): Promise<void> {
  await Storage.setItem(SERVER_URL_KEY, url);
}

export async function clearServerUrl(): Promise<void> {
  await Storage.deleteItem(SERVER_URL_KEY);
}

export async function getToken(): Promise<string | null> {
  return Storage.getItem(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await Storage.setItem(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await Storage.deleteItem(TOKEN_KEY);
}


/**
 * Typed error thrown by apiFetch when the request fails with a non-2xx
 * status. Carries the HTTP status so callers can distinguish auth
 * failures (401) from server errors and from genuine network failures
 * (which throw a plain `Error` from `fetch` itself, no `status` set).
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
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
      throw new ApiError(body.error ?? `Request failed: ${res.status}`, res.status);
    }

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// 30s upper bound on bare login/register fetches. apiFetch handles its
// own timeout but these endpoints run before a token exists and can't
// route through it.
async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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
  const res = await fetchWithTimeout(`${serverUrl}/api/register`, {
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
  const res = await fetchWithTimeout(`${serverUrl}/api/email/login`, {
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
  const res = await fetchWithTimeout(`${serverUrl}/api/email/login/verify`, {
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
 * GET /api/books used as a cheap "is the token still valid" probe.
 * Returns:
 *   - "valid"   — server responded 2xx, token works
 *   - "invalid" — server responded 401/403, token is bad
 *   - "offline" — request never reached the server (network error,
 *                 timeout, DNS failure). Token MIGHT still be valid;
 *                 we just don't know yet.
 *
 * The auth store uses this distinction to keep users signed in when
 * the server is unreachable instead of forcing a logout on every
 * flaky-network app launch.
 */
export type TokenCheck = "valid" | "invalid" | "offline";

export async function checkToken(): Promise<TokenCheck> {
  try {
    await apiFetch("/api/books");
    return "valid";
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return "invalid";
    }
    return "offline";
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

/**
 * Upload a book to the server. Accepts either:
 *   - a browser `File` / `Blob` (web), which FormData handles natively
 *   - an RN file descriptor `{ uri, name, type }` (iOS/Android), which
 *     the React Native FormData polyfill knows how to turn into a
 *     multipart part. The `any` cast is required because DOM FormData
 *     types are stricter than RN's.
 */
export function uploadBook(
  file: File | Blob | { uri: string; name: string; type: string },
) {
  const form = new FormData();
  if (typeof File !== "undefined" && file instanceof File) {
    form.append("file", file, file.name);
  } else if (typeof Blob !== "undefined" && file instanceof Blob) {
    form.append("file", file);
  } else {
    form.append("file", file as any);
  }
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
