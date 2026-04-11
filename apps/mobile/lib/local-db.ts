import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
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

let db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  // Use sync open — openDatabaseAsync + prepareAsync NPEs on Android 16 (API 36).
  // openDatabaseSync returns the same SQLiteDatabase type and the async
  // methods (execAsync, runAsync, getAllAsync) work fine on the sync handle.
  db = SQLite.openDatabaseSync("readr.db");
  await db.execAsync(`PRAGMA journal_mode = WAL;`);
  await runMigrations(db);
  return db;
}

async function runMigrations(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS reading_progress (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      position TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0,
      UNIQUE(book_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      position TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS highlights (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      cfi_range TEXT NOT NULL,
      text_content TEXT,
      note TEXT,
      color TEXT NOT NULL DEFAULT 'yellow',
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      position TEXT NOT NULL,
      note_type TEXT NOT NULL DEFAULT 'typed',
      text_content TEXT,
      strokes TEXT,
      pen_config TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload TEXT,
      device_id TEXT,
      timestamp TEXT NOT NULL
    );

    -- Locally-cached book binaries. The server returns a presigned URL
    -- for a given bookId; when the user taps Download we fetch it into
    -- the app's document directory and record the local path here. The
    -- reader prefers the local file if present.
    CREATE TABLE IF NOT EXISTS downloaded_books (
      book_id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      format TEXT NOT NULL,
      local_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      downloaded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_progress_book ON reading_progress(book_id);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id);
    CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id);
    CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_ts ON sync_queue(timestamp);
  `);
}

function generateId(): string {
  // Must produce valid UUID v4 — the server schema uses uuid primary keys
  // and the sync validator requires z.string().uuid().
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Manual UUID v4 fallback for Hermes/older RN runtimes.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let cachedDeviceId: string | null = null;

function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  // Synchronous — read from cache. The async init sets it on app start.
  return cachedDeviceId ?? "mobile-default";
}

/** Call once on app startup to load or generate a persistent device ID. */
export async function initDeviceId(): Promise<void> {
  let id = await SecureStore.getItemAsync("deviceId");
  if (!id) {
    id = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await SecureStore.setItemAsync("deviceId", id);
  }
  cachedDeviceId = id;
}

// ─── Reading Progress ────────────────────────────────────────────────────

export async function getProgress(bookId: string): Promise<ReadingProgress | null> {
  const database = await getDb();
  const deviceId = getDeviceId();
  const row = await database.getFirstAsync<{
    id: string;
    book_id: string;
    device_id: string;
    position: string;
    updated_at: string;
  }>(
    "SELECT * FROM reading_progress WHERE book_id = ? AND device_id = ?",
    [bookId, deviceId],
  );
  if (!row) return null;
  return {
    id: row.id,
    bookId: row.book_id,
    userId: "", // Local only, userId comes from server
    deviceId: row.device_id,
    position: JSON.parse(row.position) as BookPosition,
    updatedAt: row.updated_at,
  };
}

export async function upsertProgress(
  bookId: string,
  position: BookPosition,
): Promise<void> {
  const database = await getDb();
  const deviceId = getDeviceId();
  const now = new Date().toISOString();

  // Use the existing row's id if one exists so the sync queue entity ID is
  // stable across repeated updates to the same book. This lets
  // deduplicateQueue() collapse consecutive page-turn events into a single
  // push instead of flooding the server.
  const existing = await database.getFirstAsync<{ id: string }>(
    "SELECT id FROM reading_progress WHERE book_id = ? AND device_id = ?",
    [bookId, deviceId],
  );
  const id = existing?.id ?? generateId();

  await database.runAsync(
    `INSERT INTO reading_progress (id, book_id, device_id, position, updated_at, synced)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(book_id, device_id) DO UPDATE SET
       position = excluded.position,
       updated_at = excluded.updated_at,
       synced = 0`,
    [id, bookId, deviceId, JSON.stringify(position), now],
  );

  await addToSyncQueue("progress", id, "update", {
    bookId,
    deviceId,
    position,
  });
}

export async function getAllProgress(): Promise<Map<string, ReadingProgress>> {
  const database = await getDb();
  const deviceId = getDeviceId();
  const rows = await database.getAllAsync<{
    id: string;
    book_id: string;
    device_id: string;
    position: string;
    updated_at: string;
  }>(
    "SELECT * FROM reading_progress WHERE device_id = ?",
    [deviceId],
  );
  const map = new Map<string, ReadingProgress>();
  for (const row of rows) {
    map.set(row.book_id, {
      id: row.id,
      bookId: row.book_id,
      userId: "",
      deviceId: row.device_id,
      position: JSON.parse(row.position) as BookPosition,
      updatedAt: row.updated_at,
    });
  }
  return map;
}

// ─── Bookmarks ───────────────────────────────────────────────────────────

export async function getBookmarks(bookId: string): Promise<Bookmark[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<{
    id: string;
    book_id: string;
    position: string;
    label: string | null;
    created_at: string;
    deleted_at: string | null;
  }>(
    "SELECT * FROM bookmarks WHERE book_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
    [bookId],
  );
  return rows.map((row) => ({
    id: row.id,
    bookId: row.book_id,
    userId: "",
    position: JSON.parse(row.position) as BookPosition,
    label: row.label,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }));
}

export async function createBookmark(
  bookId: string,
  position: BookPosition,
  label?: string,
): Promise<Bookmark> {
  const database = await getDb();
  const id = generateId();
  const now = new Date().toISOString();

  await database.runAsync(
    "INSERT INTO bookmarks (id, book_id, position, label, created_at, synced) VALUES (?, ?, ?, ?, ?, 0)",
    [id, bookId, JSON.stringify(position), label ?? null, now],
  );

  await addToSyncQueue("bookmark", id, "create", {
    bookId,
    position,
    label,
  });

  return {
    id,
    bookId,
    userId: "",
    position,
    label: label ?? null,
    createdAt: now,
    deletedAt: null,
  };
}

export async function deleteBookmark(id: string): Promise<void> {
  const database = await getDb();
  const now = new Date().toISOString();

  await database.runAsync(
    "UPDATE bookmarks SET deleted_at = ?, synced = 0 WHERE id = ?",
    [now, id],
  );

  await addToSyncQueue("bookmark", id, "delete", null);
}

// ─── Highlights ──────────────────────────────────────────────────────────

export async function getHighlights(bookId: string): Promise<Highlight[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<{
    id: string;
    book_id: string;
    cfi_range: string;
    text_content: string | null;
    note: string | null;
    color: string;
    created_at: string;
    deleted_at: string | null;
  }>(
    "SELECT * FROM highlights WHERE book_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
    [bookId],
  );
  return rows.map((row) => ({
    id: row.id,
    bookId: row.book_id,
    userId: "",
    cfiRange: row.cfi_range,
    textContent: row.text_content,
    note: row.note,
    color: row.color as Highlight["color"],
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }));
}

export async function createHighlight(
  bookId: string,
  cfiRange: string,
  color: Highlight["color"],
  textContent?: string,
): Promise<Highlight> {
  const database = await getDb();
  const id = generateId();
  const now = new Date().toISOString();

  await database.runAsync(
    "INSERT INTO highlights (id, book_id, cfi_range, text_content, color, created_at, synced) VALUES (?, ?, ?, ?, ?, ?, 0)",
    [id, bookId, cfiRange, textContent ?? null, color, now],
  );

  await addToSyncQueue("highlight", id, "create", {
    bookId,
    cfiRange,
    color,
    textContent,
  });

  return {
    id,
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

export async function deleteHighlight(id: string): Promise<void> {
  const database = await getDb();
  const now = new Date().toISOString();

  await database.runAsync(
    "UPDATE highlights SET deleted_at = ?, synced = 0 WHERE id = ?",
    [now, id],
  );

  await addToSyncQueue("highlight", id, "delete", null);
}

// ─── Notes ───────────────────────────────────────────────────────────────

export async function getNotes(bookId: string): Promise<Note[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<{
    id: string;
    book_id: string;
    position: string;
    note_type: string;
    text_content: string | null;
    strokes: string | null;
    pen_config: string | null;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
  }>(
    "SELECT * FROM notes WHERE book_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
    [bookId],
  );
  return rows.map((row) => ({
    id: row.id,
    bookId: row.book_id,
    userId: "",
    position: JSON.parse(row.position) as BookPosition,
    noteType: row.note_type as "typed" | "handwritten",
    textContent: row.text_content,
    strokes: row.strokes ? (JSON.parse(row.strokes) as Stroke[]) : null,
    penConfig: row.pen_config ? (JSON.parse(row.pen_config) as PenConfig) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }));
}

export async function createNote(
  bookId: string,
  position: BookPosition,
  noteType: "typed" | "handwritten",
  textContent?: string,
  strokes?: Stroke[],
  penConfig?: PenConfig,
): Promise<Note> {
  const database = await getDb();
  const id = generateId();
  const now = new Date().toISOString();

  await database.runAsync(
    `INSERT INTO notes (id, book_id, position, note_type, text_content, strokes, pen_config, created_at, updated_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      id,
      bookId,
      JSON.stringify(position),
      noteType,
      textContent ?? null,
      strokes ? JSON.stringify(strokes) : null,
      penConfig ? JSON.stringify(penConfig) : null,
      now,
      now,
    ],
  );

  await addToSyncQueue("note", id, "create", {
    bookId,
    position,
    noteType,
    textContent,
    strokes,
    penConfig,
  });

  return {
    id,
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
  id: string,
  updates: {
    textContent?: string;
    strokes?: Stroke[];
    penConfig?: PenConfig;
  },
): Promise<void> {
  const database = await getDb();
  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?", "synced = 0"];
  const params: (string | null)[] = [now];

  if (updates.textContent !== undefined) {
    sets.push("text_content = ?");
    params.push(updates.textContent);
  }
  if (updates.strokes !== undefined) {
    sets.push("strokes = ?");
    params.push(JSON.stringify(updates.strokes));
  }
  if (updates.penConfig !== undefined) {
    sets.push("pen_config = ?");
    params.push(JSON.stringify(updates.penConfig));
  }

  params.push(id);
  await database.runAsync(
    `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`,
    params,
  );

  await addToSyncQueue("note", id, "update", updates);
}

export async function deleteNote(id: string): Promise<void> {
  const database = await getDb();
  const now = new Date().toISOString();

  await database.runAsync(
    "UPDATE notes SET deleted_at = ?, synced = 0 WHERE id = ?",
    [now, id],
  );

  await addToSyncQueue("note", id, "delete", null);
}

// ─── Sync Queue ──────────────────────────────────────────────────────────

async function addToSyncQueue(
  entityType: SyncLogEntry["entityType"],
  entityId: string,
  operation: SyncLogEntry["operation"],
  payload: Record<string, unknown> | null,
): Promise<void> {
  const database = await getDb();
  const deviceId = getDeviceId();
  const now = new Date().toISOString();

  await database.runAsync(
    "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, device_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    [entityType, entityId, operation, payload ? JSON.stringify(payload) : null, deviceId, now],
  );

  // Kick the debounced background push so cross-device sync sees this
  // write within ~1s. Lazy import to avoid a circular dep with sync.ts
  // (sync.ts imports getSyncQueue/getDb from this file).
  void import("./sync").then((mod) => mod.schedulePush()).catch(() => {});
}

export async function getSyncQueue(): Promise<SyncLogEntry[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<{
    id: number;
    entity_type: string;
    entity_id: string;
    operation: string;
    payload: string | null;
    device_id: string | null;
    timestamp: string;
  }>("SELECT * FROM sync_queue ORDER BY timestamp ASC");

  return rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type as SyncLogEntry["entityType"],
    entityId: row.entity_id,
    operation: row.operation as SyncLogEntry["operation"],
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null,
    deviceId: row.device_id,
    timestamp: row.timestamp,
  }));
}

export async function clearSyncQueue(upToId: number): Promise<void> {
  const database = await getDb();
  await database.runAsync("DELETE FROM sync_queue WHERE id <= ?", [upToId]);
}
