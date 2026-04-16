import * as SQLite from "expo-sqlite";
import * as Storage from "./storage";
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

    -- Local mirror of the server's /api/books rows so the library, book
    -- detail, and reader can render without hitting the server. Every
    -- successful listBooks() upserts here. cover_url stays remote until
    -- the cover-cache pass rewrites it to a file:// path.
    --
    -- user_id + metadata_json round-trip the full shape of @readr/shared
    -- Book so rowToBook() doesn't have to lie about values it doesn't
    -- store. download_url is cached for completeness but stripped on
    -- read — presigned R2 URLs expire and can't be reused offline
    -- anyway, so handing one back would only waste a failing request.
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      file_id TEXT,
      title TEXT,
      author TEXT,
      language TEXT,
      total_chapters INTEGER,
      metadata_json TEXT,
      cover_url TEXT,
      download_url TEXT,
      format TEXT,
      file_size INTEGER,
      uploaded_at TEXT,
      last_synced_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_progress_book ON reading_progress(book_id);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id);
    CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id);
    CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_ts ON sync_queue(timestamp);
  `);

  // Additive migrations for columns added after v1. SQLite doesn't
  // support `ADD COLUMN IF NOT EXISTS`, so we just swallow the error
  // when the column already exists — keeps this file idempotent
  // without a full version-tracking table.
  await addColumnIfMissing(database, "highlights", "chapter_label", "TEXT");
  await addColumnIfMissing(database, "highlights", "percentage", "REAL");

  // books table columns added after offline-mode's first cut so
  // rowToBook() can round-trip the full @readr/shared Book shape
  // instead of synthesizing empty userId / null metadata.
  await addColumnIfMissing(database, "books", "user_id", "TEXT");
  await addColumnIfMissing(database, "books", "metadata_json", "TEXT");
  await addColumnIfMissing(database, "books", "download_url", "TEXT");
  await addColumnIfMissing(database, "notes", "canvas_image", "TEXT");

  // One-time migration for entities created before `generateId()` was
  // switched to UUID v4. Legacy IDs look like `1775770007700-eia8fhb`
  // and fail the server's `z.string().uuid()` sync validator, which
  // means the entire push payload 400s and nothing drains. Reassign
  // fresh UUIDs to any stragglers and re-enqueue their creates.
  await migrateLegacyIds(database);

  // Backfill `finished: true` into reading_progress.position JSON for
  // any row at 100% that predates the explicit flag. SQLite's
  // json_set is available since 3.38; the WHERE filters out rows that
  // already have the flag so this is a one-shot no-op after running.
  await backfillFinishedFlag(database);
}

async function backfillFinishedFlag(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  try {
    await database.runAsync(
      `UPDATE reading_progress
         SET position = json_set(position, '$.finished', json('true')),
             synced = 0
       WHERE json_extract(position, '$.percentage') >= 100
         AND COALESCE(json_extract(position, '$.finished'), 0) <> 1`,
    );
  } catch {
    // Older sqlite or malformed JSON — non-fatal, the client-side
    // derivation (pct >= 100 → finished) keeps the UI honest.
  }
}

async function addColumnIfMissing(
  database: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  try {
    await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  } catch {
    // Column already exists — nothing to do.
  }
}

// Reassign UUIDs to legacy annotations and drain any stale sync_queue
// entries that reference them. Idempotent — once every row has a
// UUID, the SELECTs return nothing and this becomes a no-op.
async function migrateLegacyIds(database: SQLite.SQLiteDatabase): Promise<void> {
  // A proper UUID v4 is exactly 36 chars (including dashes). Anything
  // shorter or longer is a legacy id — matches the old format
  // `<timestamp>-<random>` which is ~23 chars.
  const isLegacy = "length(id) <> 36 OR id NOT LIKE '%-%-%-%-%'";
  const tables: Array<{ name: "bookmark" | "highlight" | "note"; sql: string }> = [
    { name: "bookmark", sql: "bookmarks" },
    { name: "highlight", sql: "highlights" },
    { name: "note", sql: "notes" },
  ];

  for (const { name, sql } of tables) {
    const rows = await database.getAllAsync<{ id: string }>(
      `SELECT id FROM ${sql} WHERE ${isLegacy}`,
    );
    for (const { id: oldId } of rows) {
      const newId = generateId();
      await database.runAsync(`UPDATE ${sql} SET id = ? WHERE id = ?`, [newId, oldId]);
      // Drop any pending queue entries that still reference the old id.
      await database.runAsync(
        "DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ?",
        [name, oldId],
      );
      // Re-queue a fresh create so the server gets the annotation.
      const payload = await buildAnnotationPayload(database, name, newId);
      if (payload) {
        await database.runAsync(
          "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, device_id, timestamp) VALUES (?, ?, 'create', ?, ?, ?)",
          [name, newId, JSON.stringify(payload), getDeviceId(), new Date().toISOString()],
        );
      }
    }
  }

  // Any remaining queue entries with legacy entity_ids are orphaned —
  // the entity they reference either doesn't exist anymore or was
  // just re-id'd above. Drop them so pushes stop 400-ing on the
  // UUID validator. This also sweeps up the progress queue's legacy
  // entity_ids, which are just local tracking — progress is keyed on
  // (bookId, deviceId) server-side, not entity_id, so dropping them
  // is safe. Any future page flip will re-queue a fresh entry.
  await database.runAsync(
    `DELETE FROM sync_queue WHERE length(entity_id) <> 36 OR entity_id NOT LIKE '%-%-%-%-%'`,
  );
}

async function buildAnnotationPayload(
  database: SQLite.SQLiteDatabase,
  kind: "bookmark" | "highlight" | "note",
  id: string,
): Promise<Record<string, unknown> | null> {
  if (kind === "bookmark") {
    const row = await database.getFirstAsync<{
      book_id: string;
      position: string;
      label: string | null;
    }>("SELECT book_id, position, label FROM bookmarks WHERE id = ?", [id]);
    if (!row) return null;
    return {
      bookId: row.book_id,
      position: JSON.parse(row.position),
      label: row.label,
    };
  }
  if (kind === "highlight") {
    const row = await database.getFirstAsync<{
      book_id: string;
      cfi_range: string;
      text_content: string | null;
      color: string;
      chapter_label: string | null;
      percentage: number | null;
    }>(
      "SELECT book_id, cfi_range, text_content, color, chapter_label, percentage FROM highlights WHERE id = ?",
      [id],
    );
    if (!row) return null;
    return {
      bookId: row.book_id,
      cfiRange: row.cfi_range,
      textContent: row.text_content,
      color: row.color,
      chapterLabel: row.chapter_label,
      percentage: row.percentage,
    };
  }
  // note
  const row = await database.getFirstAsync<{
    book_id: string;
    position: string;
    note_type: string;
    text_content: string | null;
    strokes: string | null;
    pen_config: string | null;
  }>(
    "SELECT book_id, position, note_type, text_content, strokes, pen_config FROM notes WHERE id = ?",
    [id],
  );
  if (!row) return null;
  return {
    bookId: row.book_id,
    position: JSON.parse(row.position),
    noteType: row.note_type,
    textContent: row.text_content,
    strokes: row.strokes ? JSON.parse(row.strokes) : null,
    penConfig: row.pen_config ? JSON.parse(row.pen_config) : null,
  };
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
  let id = await Storage.getItem("deviceId");
  if (!id) {
    id = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await Storage.setItem("deviceId", id);
  }
  cachedDeviceId = id;
}

// ─── Reading Progress ────────────────────────────────────────────────────

export async function getProgress(bookId: string): Promise<ReadingProgress | null> {
  const database = await getDb();
  // Return the most recently updated progress row for this book
  // across ALL devices. Progress is stored per-device (LWW-safe,
  // each device can overwrite its own row), but when we restore
  // the reader we want the latest read-through from any device so
  // you can pick up reading on a new device without losing place.
  const row = await database.getFirstAsync<{
    id: string;
    book_id: string;
    device_id: string;
    position: string;
    updated_at: string;
  }>(
    "SELECT * FROM reading_progress WHERE book_id = ? ORDER BY updated_at DESC LIMIT 1",
    [bookId],
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
  // Return the most recently updated progress row per book across
  // ALL devices — the library shouldn't hide progress from other
  // devices just because they wrote it. Ordering ASC lets the Map's
  // overwrite semantics keep the final (latest) entry per book.
  const rows = await database.getAllAsync<{
    id: string;
    book_id: string;
    device_id: string;
    position: string;
    updated_at: string;
  }>("SELECT * FROM reading_progress ORDER BY updated_at ASC");
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
    chapter_label: string | null;
    percentage: number | null;
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
    chapterLabel: row.chapter_label,
    percentage: row.percentage,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }));
}

export async function createHighlight(
  bookId: string,
  cfiRange: string,
  color: Highlight["color"],
  textContent?: string,
  chapterLabel?: string | null,
  percentage?: number | null,
): Promise<Highlight> {
  const database = await getDb();
  const id = generateId();
  const now = new Date().toISOString();

  await database.runAsync(
    "INSERT INTO highlights (id, book_id, cfi_range, text_content, color, chapter_label, percentage, created_at, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
    [id, bookId, cfiRange, textContent ?? null, color, chapterLabel ?? null, percentage ?? null, now],
  );

  await addToSyncQueue("highlight", id, "create", {
    bookId,
    cfiRange,
    color,
    textContent,
    chapterLabel: chapterLabel ?? null,
    percentage: percentage ?? null,
  });

  return {
    id,
    bookId,
    userId: "",
    cfiRange,
    textContent: textContent ?? null,
    note: null,
    color,
    chapterLabel: chapterLabel ?? null,
    percentage: percentage ?? null,
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
    canvasImage: (row as Record<string, unknown>).canvas_image as string | null ?? null,
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
  canvasImage?: string | null,
): Promise<Note> {
  const database = await getDb();
  const id = generateId();
  const now = new Date().toISOString();

  await database.runAsync(
    `INSERT INTO notes (id, book_id, position, note_type, text_content, strokes, pen_config, canvas_image, created_at, updated_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      id,
      bookId,
      JSON.stringify(position),
      noteType,
      textContent ?? null,
      strokes ? JSON.stringify(strokes) : null,
      penConfig ? JSON.stringify(penConfig) : null,
      canvasImage ?? null,
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
    canvasImage: canvasImage ?? null,
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
    canvasImage?: string | null;
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
  if (updates.canvasImage !== undefined) {
    sets.push("canvas_image = ?");
    params.push(updates.canvasImage ?? null);
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

// ─── Books cache ─────────────────────────────────────────────────────────
//
// Local mirror of /api/books for offline mode. Library, book detail, and
// reader read from here first; the server is consulted in the background
// (or not at all when offline). cover_url is the server's presigned URL
// until C5 rewrites it to a file:// path that survives the presign expiry.

interface BookRow {
  id: string;
  user_id: string | null;
  file_id: string | null;
  title: string | null;
  author: string | null;
  language: string | null;
  total_chapters: number | null;
  metadata_json: string | null;
  cover_url: string | null;
  download_url: string | null;
  format: string | null;
  file_size: number | null;
  uploaded_at: string | null;
  last_synced_at: string;
}

function rowToBook(row: BookRow): import("@readr/shared").Book {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      // Corrupted JSON — treat as no metadata. Better than crashing
      // the library screen.
    }
  }
  // Deliberately skip download_url. Presigned R2 URLs expire, and the
  // cache fallback path only fires when the network is flaky or down —
  // handing back a stale URL would just waste a failing request.
  // Callers that need a downloadable handle go through book-cache.ts
  // and hit the network anyway.
  return {
    id: row.id,
    userId: row.user_id ?? "",
    fileId: row.file_id ?? "",
    title: row.title,
    author: row.author,
    language: row.language,
    totalChapters: row.total_chapters,
    metadata,
    uploadedAt: row.uploaded_at ?? "",
    coverUrl: row.cover_url,
    format: (row.format as "epub" | "pdf" | undefined) ?? undefined,
    fileSize: row.file_size ?? undefined,
  };
}

export async function getCachedBooks(): Promise<import("@readr/shared").Book[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<BookRow>(
    "SELECT * FROM books ORDER BY uploaded_at DESC",
  );
  return rows.map(rowToBook);
}

export async function getCachedBook(
  id: string,
): Promise<import("@readr/shared").Book | null> {
  const database = await getDb();
  const row = await database.getFirstAsync<BookRow>(
    "SELECT * FROM books WHERE id = ?",
    [id],
  );
  return row ? rowToBook(row) : null;
}

/**
 * Upsert a list of books from the server into the local cache. Called from
 * the listBooks() React Query onSuccess. We DON'T delete books that didn't
 * come back, because the server response might be filtered (search, sort)
 * and we'd nuke the offline library on every search.
 *
 * The reconciliation pass — actually deleting books that the server has
 * removed — runs from `pruneCachedBooks()` after a clean unfiltered fetch.
 */
export async function upsertCachedBooks(
  books: import("@readr/shared").Book[],
): Promise<void> {
  if (books.length === 0) return;
  const database = await getDb();
  const now = new Date().toISOString();
  // Use a single transaction to keep the upsert atomic and fast.
  await database.withTransactionAsync(async () => {
    for (const b of books) {
      await database.runAsync(
        `INSERT INTO books
           (id, user_id, file_id, title, author, language, total_chapters,
            metadata_json, cover_url, download_url, format, file_size,
            uploaded_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           user_id        = excluded.user_id,
           file_id        = excluded.file_id,
           title          = excluded.title,
           author         = excluded.author,
           language       = excluded.language,
           total_chapters = excluded.total_chapters,
           metadata_json  = excluded.metadata_json,
           -- Keep a previously-cached file:// cover instead of clobbering
           -- it with a fresh presigned URL. The cover-cache pass owns
           -- the rewrite; this just preserves whatever it produced.
           cover_url      = CASE
                              WHEN books.cover_url LIKE 'file://%' THEN books.cover_url
                              ELSE excluded.cover_url
                            END,
           download_url   = excluded.download_url,
           format         = excluded.format,
           file_size      = excluded.file_size,
           uploaded_at    = excluded.uploaded_at,
           last_synced_at = excluded.last_synced_at`,
        [
          b.id,
          b.userId ?? null,
          b.fileId ?? null,
          b.title ?? null,
          b.author ?? null,
          b.language ?? null,
          b.totalChapters ?? null,
          b.metadata ? JSON.stringify(b.metadata) : null,
          b.coverUrl ?? null,
          b.downloadUrl ?? null,
          b.format ?? null,
          b.fileSize ?? null,
          b.uploadedAt ?? null,
          now,
        ],
      );
    }
  });
}

/**
 * Drop cached books whose ids don't appear in the given set. Call this
 * only after a clean unfiltered listBooks() so we don't nuke offline
 * entries that the server merely filtered out.
 *
 * Refuses to wipe the whole table on an empty input. A flaky listBooks()
 * that returned `{ books: [] }` instead of throwing would otherwise
 * erase the user's offline library; if they genuinely have zero books
 * on the server the next downloadBook() / upsertCachedBook() will be
 * the authoritative source, and a stale row costs nothing to keep until
 * then. Callers that really mean "wipe everything" should do so
 * explicitly via DELETE.
 */
export async function pruneCachedBooks(serverIds: Iterable<string>): Promise<void> {
  const database = await getDb();
  const ids = Array.from(serverIds);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await database.runAsync(
    `DELETE FROM books WHERE id NOT IN (${placeholders})`,
    ids,
  );
}

export async function deleteCachedBook(id: string): Promise<void> {
  const database = await getDb();
  await database.runAsync("DELETE FROM books WHERE id = ?", [id]);
}

/** Single-book convenience wrapper around upsertCachedBooks. */
export async function upsertCachedBook(
  book: import("@readr/shared").Book,
): Promise<void> {
  await upsertCachedBooks([book]);
}
