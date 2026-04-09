import type { Book } from "@readr/shared";

const SERVER_URL_KEY = "readr:serverUrl";
const TOKEN_KEY = "readr:token";

/**
 * Optional build-time default URL pulled from the Vite env. Set
 * VITE_DEFAULT_SERVER_URL at build time to ship a version of the web
 * dashboard that automatically talks to a specific backend (e.g. a
 * Cloudflare-tunneled Olares box) without the user having to enter it.
 */
export const DEFAULT_SERVER_URL: string =
  (import.meta.env.VITE_DEFAULT_SERVER_URL as string | undefined) ?? "";

export function getServerUrl(): string {
  return localStorage.getItem(SERVER_URL_KEY) ?? DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url.replace(/\/$/, ""));
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Generate a URL-safe 32+ char random token for first-time setup.
 * Uses the web Crypto API.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "";
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (const b of bytes) out += alphabet[b % 62];
  return out + "_" + Date.now().toString(36);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const serverUrl = getServerUrl();
  if (!serverUrl) throw new Error("Server URL not configured");
  const token = getToken();

  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !(init.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${serverUrl}${path}`, { ...init, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Create or confirm the user row for a given token. Idempotent.
 */
export async function registerToken(
  serverUrl: string,
  token: string,
): Promise<{ user: { id: string; name: string | null }; created: boolean }> {
  const res = await fetch(`${serverUrl}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Register failed: ${res.status}`);
  }
  return res.json();
}

// Email login
export async function emailLoginStart(email: string): Promise<void> {
  const serverUrl = getServerUrl();
  if (!serverUrl) throw new Error("Server URL not configured");
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

export async function emailLoginVerify(email: string, code: string): Promise<string> {
  const serverUrl = getServerUrl();
  if (!serverUrl) throw new Error("Server URL not configured");
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

export function uploadBook(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<{ book: Book }>("/api/books", {
    method: "POST",
    body: formData,
  });
}

export function updateBookMetadata(
  id: string,
  data: { title?: string; author?: string },
) {
  return apiFetch<{ book: Book }>(`/api/books/${id}/metadata`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}
