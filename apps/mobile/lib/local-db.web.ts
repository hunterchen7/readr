/**
 * Web stub for local-db. The mobile app uses expo-sqlite + a local
 * SQLite database for offline progress, bookmarks, notes, highlights,
 * and a sync queue. None of that exists on web (yet) — the web build
 * only needs to serve the library/upload flow, and the reader is
 * stubbed until a web-specific implementation lands.
 *
 * This file exports the same symbols as `local-db.ts` so Metro's
 * platform resolution can swap in this module on web without breaking
 * any imports. Every persistence operation is a no-op; query functions
 * return empty data. initDeviceId() hands out a browser-local device id
 * via the platform storage wrapper so sync can still identify the
 * device if/when we wire it up on web.
 */
import type {
  BookPosition,
  ReadingProgress,
  Bookmark,
  Highlight,
  Note,
  Stroke,
  PenConfig,
  SyncLogEntry,
} from "@readr/shared";
import * as Storage from "./storage";

// Deliberately typed as `any` — the native module returns an expo-sqlite
// SQLiteDatabase, which we cannot pull in on web. Callers on web should
// not hit getDb() directly (the reader is stubbed). If they do, they'll
// crash loudly rather than silently operate on a fake handle.
export async function getDb(): Promise<any> {
  throw new Error("local-db.getDb is not available on web");
}

let cachedDeviceId: string | null = null;

export async function initDeviceId(): Promise<void> {
  let id = await Storage.getItem("deviceId");
  if (!id) {
    id = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await Storage.setItem("deviceId", id);
  }
  cachedDeviceId = id;
}

// ─── Reading Progress ────────────────────────────────────────────────────

export async function getProgress(
  _bookId: string,
): Promise<ReadingProgress | null> {
  return null;
}

export async function upsertProgress(
  _bookId: string,
  _position: BookPosition,
): Promise<void> {
  // No-op on web. Progress will come from the server when we add it.
}

export async function getAllProgress(): Promise<Map<string, ReadingProgress>> {
  return new Map();
}

// ─── Bookmarks ───────────────────────────────────────────────────────────

export async function getBookmarks(_bookId: string): Promise<Bookmark[]> {
  return [];
}

export async function createBookmark(
  bookId: string,
  position: BookPosition,
  label?: string,
): Promise<Bookmark> {
  const now = new Date().toISOString();
  return {
    id: `web-${Math.random().toString(36).slice(2)}`,
    bookId,
    userId: "",
    position,
    label: label ?? null,
    createdAt: now,
    deletedAt: null,
  };
}

export async function deleteBookmark(_id: string): Promise<void> {
  // No-op on web.
}

// ─── Highlights ──────────────────────────────────────────────────────────

export async function getHighlights(_bookId: string): Promise<Highlight[]> {
  return [];
}

export async function createHighlight(
  bookId: string,
  cfiRange: string,
  color: Highlight["color"],
  textContent?: string,
): Promise<Highlight> {
  const now = new Date().toISOString();
  return {
    id: `web-${Math.random().toString(36).slice(2)}`,
    bookId,
    userId: "",
    cfiRange,
    textContent: textContent ?? null,
    note: null,
    color,
    createdAt: now,
    deletedAt: null,
  };
}

export async function deleteHighlight(_id: string): Promise<void> {
  // No-op on web.
}

// ─── Notes ───────────────────────────────────────────────────────────────

export async function getNotes(_bookId: string): Promise<Note[]> {
  return [];
}

export async function createNote(
  bookId: string,
  position: BookPosition,
  noteType: "typed" | "handwritten",
  textContent?: string,
  strokes?: Stroke[],
  penConfig?: PenConfig,
): Promise<Note> {
  const now = new Date().toISOString();
  return {
    id: `web-${Math.random().toString(36).slice(2)}`,
    bookId,
    userId: "",
    position,
    noteType,
    textContent: textContent ?? null,
    strokes: strokes ?? null,
    penConfig: penConfig ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export async function updateNote(
  _id: string,
  _updates: {
    textContent?: string;
    strokes?: Stroke[];
    penConfig?: PenConfig;
  },
): Promise<void> {
  // No-op on web.
}

export async function deleteNote(_id: string): Promise<void> {
  // No-op on web.
}

// ─── Sync Queue ──────────────────────────────────────────────────────────

export async function getSyncQueue(): Promise<SyncLogEntry[]> {
  return [];
}

export async function clearSyncQueue(_upToId: number): Promise<void> {
  // No-op on web.
}
