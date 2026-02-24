import type { Book } from "@readr/shared";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
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
