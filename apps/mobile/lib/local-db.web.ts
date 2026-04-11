/**
 * Web implementation of local-db, backed by IndexedDB via web-idb.ts.
 *
 * The native file (local-db.ts) uses expo-sqlite and JSON-encodes
 * nested values (BookPosition, Stroke[], PenConfig) into TEXT
 * columns. IndexedDB stores structured values directly, so the
 * records this file writes are closer to the domain types —
 * `position` is an object, not a stringified JSON, and so on.
 *
 * The exported interface matches local-db.ts exactly. Callers
 * shouldn't be able to tell which backend they're talking to.
 */
import type {
  Book,
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
import { STORE, tx, req } from "./web-idb";

// ─── Shared record shapes (IDB values) ───────────────────────────────────

interface ProgressRecord {
  id: string;
  bookId: string;
  deviceId: string;
  position: BookPosition;
  updatedAt: string;
  synced: 0 | 1;
}

interface BookmarkRecord {
  id: string;
  bookId: string;
  position: BookPosition;
  label: string | null;
  createdAt: string;
  deletedAt: string | null;
  synced: 0 | 1;
}

interface HighlightRecord {
  id: string;
  bookId: string;
  cfiRange: string;
  textContent: string | null;
  note: string | null;
  color: Highlight["color"];
  chapterLabel: string | null;
  percentage: number | null;
  createdAt: string;
  deletedAt: string | null;
  synced: 0 | 1;
}

interface NoteRecord {
  id: string;
  bookId: string;
  position: BookPosition;
  noteType: "typed" | "handwritten";
  textContent: string | null;
  strokes: Stroke[] | null;
  penConfig: PenConfig | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  synced: 0 | 1;
}

interface SyncQueueRecord {
  id?: number;
  entityType: SyncLogEntry["entityType"];
  entityId: string;
  operation: SyncLogEntry["operation"];
  payload: Record<string, unknown> | null;
  deviceId: string | null;
  timestamp: string;
}

// ─── Utilities ───────────────────────────────────────────────────────────

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let cachedDeviceId: string | null = null;

function getDeviceId(): string {
  return cachedDeviceId ?? "web-default";
}

/**
 * Native's getDb() returns an expo-sqlite SQLiteDatabase handle that
 * we cannot produce on web. Callers that still reach for it (e.g.
 * sync.ts applyRemoteChanges) crash loudly — sync.ts has its own
 * web-safe path via sync.web.ts until #8 lands.
 */
export async function getDb(): Promise<never> {
  throw new Error(
    "local-db.getDb() is not available on web — use the IDB-backed helpers instead",
  );
}

/** Call once on app startup to load or generate a persistent device ID. */
export async function initDeviceId(): Promise<void> {
  let id = await Storage.getItem("deviceId");
  if (!id) {
    id = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await Storage.setItem("deviceId", id);
  }
  cachedDeviceId = id;
}

// ─── Reading Progress ────────────────────────────────────────────────────

function progressToPublic(row: ProgressRecord): ReadingProgress {
  return {
    id: row.id,
    bookId: row.bookId,
    userId: "",
    deviceId: row.deviceId,
    position: row.position,
    updatedAt: row.updatedAt,
  };
}

export async function getProgress(bookId: string): Promise<ReadingProgress | null> {
  const deviceId = getDeviceId();
  return tx([STORE.progress], "readonly", async ([store]) => {
    const idx = store.index("by_book_device");
    const row = await req<ProgressRecord | undefined>(idx.get([bookId, deviceId]));
    return row ? progressToPublic(row) : null;
  });
}

export async function upsertProgress(
  bookId: string,
  position: BookPosition,
): Promise<void> {
  const deviceId = getDeviceId();
  const now = new Date().toISOString();
  await tx([STORE.progress, STORE.syncQueue], "readwrite", async ([progress, queue]) => {
    const idx = progress.index("by_book_device");
    const existing = await req<ProgressRecord | undefined>(idx.get([bookId, deviceId]));
    const id = existing?.id ?? generateId();
    const record: ProgressRecord = {
      id,
      bookId,
      deviceId,
      position,
      updatedAt: now,
      synced: 0,
    };
    await req(progress.put(record));
    await enqueueInTx(queue, "progress", id, "update", { bookId, deviceId, position });
  });
  schedulePushSoon();
}

export async function getAllProgress(): Promise<Map<string, ReadingProgress>> {
  const deviceId = getDeviceId();
  return tx([STORE.progress], "readonly", async ([store]) => {
    const idx = store.index("by_device");
    const rows = await req<ProgressRecord[]>(idx.getAll(IDBKeyRange.only(deviceId)));
    const map = new Map<string, ReadingProgress>();
    for (const row of rows) map.set(row.bookId, progressToPublic(row));
    return map;
  });
}

// ─── Bookmarks ───────────────────────────────────────────────────────────

function bookmarkToPublic(row: BookmarkRecord): Bookmark {
  return {
    id: row.id,
    bookId: row.bookId,
    userId: "",
    position: row.position,
    label: row.label,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

export async function getBookmarks(bookId: string): Promise<Bookmark[]> {
  return tx([STORE.bookmarks], "readonly", async ([store]) => {
    const idx = store.index("by_book");
    const rows = await req<BookmarkRecord[]>(idx.getAll(IDBKeyRange.only(bookId)));
    return rows
      .filter((r) => r.deletedAt == null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(bookmarkToPublic);
  });
}

export async function createBookmark(
  bookId: string,
  position: BookPosition,
  label?: string,
): Promise<Bookmark> {
  const id = generateId();
  const now = new Date().toISOString();
  const record: BookmarkRecord = {
    id,
    bookId,
    position,
    label: label ?? null,
    createdAt: now,
    deletedAt: null,
    synced: 0,
  };
  await tx([STORE.bookmarks, STORE.syncQueue], "readwrite", async ([bookmarks, queue]) => {
    await req(bookmarks.put(record));
    await enqueueInTx(queue, "bookmark", id, "create", { bookId, position, label });
  });
  schedulePushSoon();
  return bookmarkToPublic(record);
}

export async function deleteBookmark(id: string): Promise<void> {
  const now = new Date().toISOString();
  await tx([STORE.bookmarks, STORE.syncQueue], "readwrite", async ([bookmarks, queue]) => {
    const existing = await req<BookmarkRecord | undefined>(bookmarks.get(id));
    if (!existing) return;
    const updated: BookmarkRecord = { ...existing, deletedAt: now, synced: 0 };
    await req(bookmarks.put(updated));
    await enqueueInTx(queue, "bookmark", id, "delete", null);
  });
  schedulePushSoon();
}

// ─── Highlights ──────────────────────────────────────────────────────────

function highlightToPublic(row: HighlightRecord): Highlight {
  return {
    id: row.id,
    bookId: row.bookId,
    userId: "",
    cfiRange: row.cfiRange,
    textContent: row.textContent,
    note: row.note,
    color: row.color,
    chapterLabel: row.chapterLabel,
    percentage: row.percentage,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

export async function getHighlights(bookId: string): Promise<Highlight[]> {
  return tx([STORE.highlights], "readonly", async ([store]) => {
    const idx = store.index("by_book");
    const rows = await req<HighlightRecord[]>(idx.getAll(IDBKeyRange.only(bookId)));
    return rows
      .filter((r) => r.deletedAt == null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(highlightToPublic);
  });
}

export async function createHighlight(
  bookId: string,
  cfiRange: string,
  color: Highlight["color"],
  textContent?: string,
  chapterLabel?: string | null,
  percentage?: number | null,
): Promise<Highlight> {
  const id = generateId();
  const now = new Date().toISOString();
  const record: HighlightRecord = {
    id,
    bookId,
    cfiRange,
    textContent: textContent ?? null,
    note: null,
    color,
    chapterLabel: chapterLabel ?? null,
    percentage: percentage ?? null,
    createdAt: now,
    deletedAt: null,
    synced: 0,
  };
  await tx([STORE.highlights, STORE.syncQueue], "readwrite", async ([highlights, queue]) => {
    await req(highlights.put(record));
    await enqueueInTx(queue, "highlight", id, "create", {
      bookId,
      cfiRange,
      color,
      textContent,
      chapterLabel: chapterLabel ?? null,
      percentage: percentage ?? null,
    });
  });
  schedulePushSoon();
  return highlightToPublic(record);
}

export async function deleteHighlight(id: string): Promise<void> {
  const now = new Date().toISOString();
  await tx([STORE.highlights, STORE.syncQueue], "readwrite", async ([highlights, queue]) => {
    const existing = await req<HighlightRecord | undefined>(highlights.get(id));
    if (!existing) return;
    const updated: HighlightRecord = { ...existing, deletedAt: now, synced: 0 };
    await req(highlights.put(updated));
    await enqueueInTx(queue, "highlight", id, "delete", null);
  });
  schedulePushSoon();
}

// ─── Notes ───────────────────────────────────────────────────────────────

function noteToPublic(row: NoteRecord): Note {
  return {
    id: row.id,
    bookId: row.bookId,
    userId: "",
    position: row.position,
    noteType: row.noteType,
    textContent: row.textContent,
    strokes: row.strokes,
    penConfig: row.penConfig,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export async function getNotes(bookId: string): Promise<Note[]> {
  return tx([STORE.notes], "readonly", async ([store]) => {
    const idx = store.index("by_book");
    const rows = await req<NoteRecord[]>(idx.getAll(IDBKeyRange.only(bookId)));
    return rows
      .filter((r) => r.deletedAt == null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(noteToPublic);
  });
}

export async function createNote(
  bookId: string,
  position: BookPosition,
  noteType: "typed" | "handwritten",
  textContent?: string,
  strokes?: Stroke[],
  penConfig?: PenConfig,
): Promise<Note> {
  const id = generateId();
  const now = new Date().toISOString();
  const record: NoteRecord = {
    id,
    bookId,
    position,
    noteType,
    textContent: textContent ?? null,
    strokes: strokes ?? null,
    penConfig: penConfig ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    synced: 0,
  };
  await tx([STORE.notes, STORE.syncQueue], "readwrite", async ([notes, queue]) => {
    await req(notes.put(record));
    await enqueueInTx(queue, "note", id, "create", {
      bookId,
      position,
      noteType,
      textContent,
      strokes,
      penConfig,
    });
  });
  schedulePushSoon();
  return noteToPublic(record);
}

export async function updateNote(
  id: string,
  updates: {
    textContent?: string;
    strokes?: Stroke[];
    penConfig?: PenConfig;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await tx([STORE.notes, STORE.syncQueue], "readwrite", async ([notes, queue]) => {
    const existing = await req<NoteRecord | undefined>(notes.get(id));
    if (!existing) return;
    const merged: NoteRecord = {
      ...existing,
      textContent: updates.textContent !== undefined ? updates.textContent : existing.textContent,
      strokes: updates.strokes !== undefined ? updates.strokes : existing.strokes,
      penConfig: updates.penConfig !== undefined ? updates.penConfig : existing.penConfig,
      updatedAt: now,
      synced: 0,
    };
    await req(notes.put(merged));
    await enqueueInTx(queue, "note", id, "update", updates);
  });
  schedulePushSoon();
}

export async function deleteNote(id: string): Promise<void> {
  const now = new Date().toISOString();
  await tx([STORE.notes, STORE.syncQueue], "readwrite", async ([notes, queue]) => {
    const existing = await req<NoteRecord | undefined>(notes.get(id));
    if (!existing) return;
    const updated: NoteRecord = { ...existing, deletedAt: now, synced: 0 };
    await req(notes.put(updated));
    await enqueueInTx(queue, "note", id, "delete", null);
  });
  schedulePushSoon();
}

// ─── Sync Queue ──────────────────────────────────────────────────────────

/**
 * In-transaction enqueue. Used by the mutation helpers above so a
 * single atomic transaction writes the mutated entity AND its queue
 * row — if the transaction aborts, neither change lands. Mirrors the
 * native behaviour where SQLite's INSERT INTO sync_queue runs inside
 * the same implicit transaction as the entity write.
 */
async function enqueueInTx(
  queue: IDBObjectStore,
  entityType: SyncLogEntry["entityType"],
  entityId: string,
  operation: SyncLogEntry["operation"],
  payload: Record<string, unknown> | null,
): Promise<void> {
  const deviceId = getDeviceId();
  const record: SyncQueueRecord = {
    entityType,
    entityId,
    operation,
    payload,
    deviceId,
    timestamp: new Date().toISOString(),
  };
  await req(queue.add(record));
}

function schedulePushSoon(): void {
  // Kick the debounced background push so cross-device sync sees
  // the write within ~1s. Lazy import mirrors the native file; the
  // optional chaining is there because sync.web.ts (today) doesn't
  // export schedulePush, and we don't want the missing symbol to
  // poison this code path before #8 lands.
  void import("./sync")
    .then((mod) => {
      const fn = (mod as unknown as { schedulePush?: () => void }).schedulePush;
      if (typeof fn === "function") fn();
    })
    .catch(() => {});
}

export async function getSyncQueue(): Promise<SyncLogEntry[]> {
  return tx([STORE.syncQueue], "readonly", async ([store]) => {
    const idx = store.index("by_ts");
    const rows = await req<SyncQueueRecord[]>(idx.getAll());
    // IDB's autoIncrement assigns an integer id at put() time and
    // returns it on every subsequent read, so `row.id` is always
    // defined here even though the record type marks it optional
    // (the optionality is for the insert path). A missing id means
    // the schema was populated by something other than addToSyncQueue
    // and we want to crash loudly, not silently delete key 0.
    return rows.map((row) => {
      if (row.id == null) {
        throw new Error(
          `Sync queue row missing id: ${row.entityType}:${row.entityId}`,
        );
      }
      return {
        id: row.id,
        entityType: row.entityType,
        entityId: row.entityId,
        operation: row.operation,
        payload: row.payload,
        deviceId: row.deviceId,
        timestamp: row.timestamp,
      };
    });
  });
}

export async function clearSyncQueue(upToId: number): Promise<void> {
  await tx([STORE.syncQueue], "readwrite", async ([store]) => {
    // IDBObjectStore.delete accepts an IDBKeyRange and removes every
    // row inside the range in a single request — far fewer round
    // trips than a key-by-key loop.
    await req(store.delete(IDBKeyRange.upperBound(upToId)));
  });
}

// ─── Books cache ─────────────────────────────────────────────────────────
//
// Offline mode ships on native only. On web the browser's HTTP cache +
// query cache already cover the re-open-without-network case well
// enough for the library screen, and the reader has its own OPFS book
// cache. These exports exist so cross-platform screens can import them
// without Metro blowing up; all of them are no-ops or empty returns.

export async function getCachedBooks(): Promise<Book[]> {
  return [];
}

export async function getCachedBook(_id: string): Promise<Book | null> {
  return null;
}

export async function upsertCachedBooks(_books: Book[]): Promise<void> {
  // No-op on web.
}

export async function upsertCachedBook(_book: Book): Promise<void> {
  // No-op on web.
}

export async function pruneCachedBooks(
  _serverIds: Iterable<string>,
): Promise<void> {
  // No-op on web.
}

export async function deleteCachedBook(_id: string): Promise<void> {
  // No-op on web.
}

// ─── Sync queue drain ───────────────────────────────────────────────────

/**
 * Remove a specific set of sync queue entries by numeric id. Called
 * after the server accepts a push. Runs inside a single readwrite
 * transaction so the delete set is atomic.
 */
export async function removeFromSyncQueue(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await tx([STORE.syncQueue], "readwrite", async ([store]) => {
    for (const id of ids) await req(store.delete(id));
  });
}

// ─── Remote change application ──────────────────────────────────────────
//
// Called by sync.ts after a successful pull. Writes land with
// synced: 1 so they don't bounce back through the push queue. The
// native local-db.ts has the same function exported — sync.ts calls
// whichever one Metro resolves based on platform.

export async function applyRemoteChange(change: SyncLogEntry): Promise<void> {
  try {
    switch (change.entityType) {
      case "progress":
        await _applyRemoteProgress(change);
        break;
      case "bookmark":
        await _applyRemoteBookmark(change);
        break;
      case "highlight":
        await _applyRemoteHighlight(change);
        break;
      case "note":
        await _applyRemoteNote(change);
        break;
    }
  } catch (err) {
    console.warn(
      `Failed to apply sync change ${change.entityType}:${change.entityId}:`,
      err,
    );
  }
}

async function _applyRemoteProgress(change: SyncLogEntry): Promise<void> {
  const payload = change.payload;
  if (!payload) return;
  await tx([STORE.progress], "readwrite", async ([store]) => {
    const record: ProgressRecord = {
      id: change.entityId,
      bookId: payload.bookId as string,
      deviceId:
        (payload.deviceId as string) ?? change.deviceId ?? "unknown",
      position: payload.position as BookPosition,
      updatedAt: change.timestamp,
      synced: 1,
    };
    await req(store.put(record));
  });
}

async function _applyRemoteBookmark(change: SyncLogEntry): Promise<void> {
  if (change.operation === "delete") {
    await tx([STORE.bookmarks], "readwrite", async ([store]) => {
      const existing = await req<BookmarkRecord | undefined>(
        store.get(change.entityId),
      );
      if (!existing) return;
      await req(
        store.put({ ...existing, deletedAt: change.timestamp, synced: 1 }),
      );
    });
    return;
  }
  const payload = change.payload;
  if (!payload) return;
  await tx([STORE.bookmarks], "readwrite", async ([store]) => {
    const record: BookmarkRecord = {
      id: change.entityId,
      bookId: payload.bookId as string,
      position: payload.position as BookPosition,
      label: (payload.label as string) ?? null,
      createdAt: change.timestamp,
      deletedAt: null,
      synced: 1,
    };
    await req(store.put(record));
  });
}

async function _applyRemoteHighlight(change: SyncLogEntry): Promise<void> {
  if (change.operation === "delete") {
    await tx([STORE.highlights], "readwrite", async ([store]) => {
      const existing = await req<HighlightRecord | undefined>(
        store.get(change.entityId),
      );
      if (!existing) return;
      await req(
        store.put({ ...existing, deletedAt: change.timestamp, synced: 1 }),
      );
    });
    return;
  }
  const payload = change.payload;
  if (!payload) return;
  await tx([STORE.highlights], "readwrite", async ([store]) => {
    const record: HighlightRecord = {
      id: change.entityId,
      bookId: payload.bookId as string,
      cfiRange: payload.cfiRange as string,
      textContent: (payload.textContent as string) ?? null,
      note: (payload.note as string) ?? null,
      color: ((payload.color as Highlight["color"]) ?? "yellow"),
      chapterLabel: (payload.chapterLabel as string | null) ?? null,
      percentage: (payload.percentage as number | null) ?? null,
      createdAt: change.timestamp,
      deletedAt: null,
      synced: 1,
    };
    await req(store.put(record));
  });
}

async function _applyRemoteNote(change: SyncLogEntry): Promise<void> {
  if (change.operation === "delete") {
    await tx([STORE.notes], "readwrite", async ([store]) => {
      const existing = await req<NoteRecord | undefined>(
        store.get(change.entityId),
      );
      if (!existing) return;
      await req(
        store.put({ ...existing, deletedAt: change.timestamp, synced: 1 }),
      );
    });
    return;
  }
  const payload = change.payload;
  if (!payload) return;
  await tx([STORE.notes], "readwrite", async ([store]) => {
    const now = change.timestamp;
    const record: NoteRecord = {
      id: change.entityId,
      bookId: payload.bookId as string,
      position: payload.position as BookPosition,
      noteType: (payload.noteType as NoteRecord["noteType"]) ?? "typed",
      textContent: (payload.textContent as string) ?? null,
      strokes: (payload.strokes as Stroke[] | null) ?? null,
      penConfig: (payload.penConfig as PenConfig | null) ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      synced: 1,
    };
    await req(store.put(record));
  });
}
