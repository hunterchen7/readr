import * as SecureStore from "expo-secure-store";
import type { SyncLogEntry, SyncConflict } from "@readr/shared";
import { deduplicateQueue } from "@readr/sync-engine";
import { getServerUrl } from "./api";
import { getSyncQueue, clearSyncQueue, getDb } from "./local-db";

const LAST_SYNC_KEY = "lastSyncTimestamp";

async function getLastSyncTimestamp(): Promise<string> {
  const ts = await SecureStore.getItemAsync(LAST_SYNC_KEY);
  // Default to epoch if never synced
  return ts ?? "1970-01-01T00:00:00.000Z";
}

async function setLastSyncTimestamp(ts: string): Promise<void> {
  await SecureStore.setItemAsync(LAST_SYNC_KEY, ts);
}

interface PullResponse {
  changes: SyncLogEntry[];
  serverTimestamp: string;
}

interface PushResponse {
  accepted: number;
  conflicts: SyncConflict[];
}

/**
 * Pull changes from the server since last sync.
 */
async function pullChanges(): Promise<PullResponse | null> {
  const serverUrl = await getServerUrl();
  if (!serverUrl) return null;

  const since = await getLastSyncTimestamp();
  const deviceId = "mobile-default";
  const params = new URLSearchParams({ since, deviceId });

  try {
    const res = await fetch(`${serverUrl}/api/sync/changes?${params}`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Push local changes to the server.
 */
async function pushChanges(changes: SyncLogEntry[]): Promise<PushResponse | null> {
  const serverUrl = await getServerUrl();
  if (!serverUrl) return null;

  try {
    const res = await fetch(`${serverUrl}/api/sync/push`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Apply remote changes to local SQLite database.
 */
async function applyRemoteChanges(changes: SyncLogEntry[]): Promise<void> {
  const database = await getDb();

  for (const change of changes) {
    try {
      switch (change.entityType) {
        case "progress":
          await applyProgressChange(database, change);
          break;
        case "bookmark":
          await applyBookmarkChange(database, change);
          break;
        case "highlight":
          await applyHighlightChange(database, change);
          break;
        case "note":
          await applyNoteChange(database, change);
          break;
      }
    } catch (err) {
      console.warn(`Failed to apply sync change ${change.entityType}:${change.entityId}:`, err);
    }
  }
}

async function applyProgressChange(
  database: Awaited<ReturnType<typeof getDb>>,
  change: SyncLogEntry,
): Promise<void> {
  const payload = change.payload;
  if (!payload) return;

  await database.runAsync(
    `INSERT INTO reading_progress (id, book_id, device_id, position, updated_at, synced)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(book_id, device_id) DO UPDATE SET
       position = excluded.position,
       updated_at = excluded.updated_at,
       synced = 1`,
    [
      change.entityId,
      payload.bookId as string,
      (payload.deviceId as string) ?? change.deviceId ?? "unknown",
      JSON.stringify(payload.position),
      change.timestamp,
    ],
  );
}

async function applyBookmarkChange(
  database: Awaited<ReturnType<typeof getDb>>,
  change: SyncLogEntry,
): Promise<void> {
  if (change.operation === "delete") {
    await database.runAsync(
      "UPDATE bookmarks SET deleted_at = ?, synced = 1 WHERE id = ?",
      [change.timestamp, change.entityId],
    );
    return;
  }

  const payload = change.payload;
  if (!payload) return;

  await database.runAsync(
    `INSERT OR REPLACE INTO bookmarks (id, book_id, position, label, created_at, synced)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [
      change.entityId,
      payload.bookId as string,
      JSON.stringify(payload.position),
      (payload.label as string) ?? null,
      change.timestamp,
    ],
  );
}

async function applyHighlightChange(
  database: Awaited<ReturnType<typeof getDb>>,
  change: SyncLogEntry,
): Promise<void> {
  if (change.operation === "delete") {
    await database.runAsync(
      "UPDATE highlights SET deleted_at = ?, synced = 1 WHERE id = ?",
      [change.timestamp, change.entityId],
    );
    return;
  }

  const payload = change.payload;
  if (!payload) return;

  await database.runAsync(
    `INSERT OR REPLACE INTO highlights (id, book_id, cfi_range, text_content, note, color, created_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      change.entityId,
      payload.bookId as string,
      payload.cfiRange as string,
      (payload.textContent as string) ?? null,
      (payload.note as string) ?? null,
      (payload.color as string) ?? "yellow",
      change.timestamp,
    ],
  );
}

async function applyNoteChange(
  database: Awaited<ReturnType<typeof getDb>>,
  change: SyncLogEntry,
): Promise<void> {
  if (change.operation === "delete") {
    await database.runAsync(
      "UPDATE notes SET deleted_at = ?, synced = 1 WHERE id = ?",
      [change.timestamp, change.entityId],
    );
    return;
  }

  const payload = change.payload;
  if (!payload) return;

  const now = change.timestamp;
  await database.runAsync(
    `INSERT OR REPLACE INTO notes (id, book_id, position, note_type, text_content, strokes, pen_config, created_at, updated_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      change.entityId,
      payload.bookId as string,
      JSON.stringify(payload.position),
      (payload.noteType as string) ?? "typed",
      (payload.textContent as string) ?? null,
      payload.strokes ? JSON.stringify(payload.strokes) : null,
      payload.penConfig ? JSON.stringify(payload.penConfig) : null,
      now,
      now,
    ],
  );
}

/**
 * Run a full sync cycle: pull remote changes, push local queue.
 * Call this on app open and on reconnect.
 */
export async function runSync(): Promise<{
  pulled: number;
  pushed: number;
  conflicts: SyncConflict[];
} | null> {
  // Step 1: Pull remote changes
  const pullResult = await pullChanges();
  if (!pullResult) return null;

  // Apply remote changes locally
  if (pullResult.changes.length > 0) {
    await applyRemoteChanges(pullResult.changes);
  }

  // Step 2: Push local queue
  const queue = await getSyncQueue();
  let pushResult: PushResponse | null = null;

  if (queue.length > 0) {
    const deduplicated = deduplicateQueue(queue);
    pushResult = await pushChanges(deduplicated);

    if (pushResult) {
      // Clear the queue up to the latest entry
      const maxId = Math.max(...queue.map((e) => e.id ?? 0));
      if (maxId > 0) {
        await clearSyncQueue(maxId);
      }
    }
  }

  // Update last sync timestamp
  await setLastSyncTimestamp(pullResult.serverTimestamp);

  return {
    pulled: pullResult.changes.length,
    pushed: pushResult?.accepted ?? 0,
    conflicts: pushResult?.conflicts ?? [],
  };
}
