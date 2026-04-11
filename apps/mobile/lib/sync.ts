import * as SecureStore from "expo-secure-store";
import type { SyncLogEntry, SyncConflict } from "@readr/shared";
import { deduplicateQueue } from "@readr/sync-engine";
import { getServerUrl, getToken } from "./api";
import { getSyncQueue, getDb } from "./local-db";

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
  acceptedEntities?: Array<Pick<SyncLogEntry, "entityType" | "entityId">>;
  conflicts: SyncConflict[];
}

/**
 * Pull changes from the server since last sync.
 */
async function pullChanges(): Promise<PullResponse | null> {
  const serverUrl = await getServerUrl();
  const token = await getToken();
  if (!serverUrl || !token) return null;

  const since = await getLastSyncTimestamp();
  const deviceId = "mobile-default";
  const params = new URLSearchParams({ since, deviceId });

  try {
    const res = await fetch(`${serverUrl}/api/sync/changes?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
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
  const token = await getToken();
  if (!serverUrl || !token) return null;

  try {
    const res = await fetch(`${serverUrl}/api/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
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
 * Push the local sync queue to the server without pulling. Cheaper
 * than runSync(): one round trip, no remote-change application. Used
 * by the debounced "push on every write" trigger so a page flip costs
 * one POST instead of a full pull+push cycle. Returns null on
 * network/auth failure — the queue is left intact so the next push
 * (or the next runSync on launch) will retry the pending entries.
 */
export async function pushPending(): Promise<{ pushed: number; conflicts: SyncConflict[] } | null> {
  const queue = await getSyncQueue();
  if (queue.length === 0) return { pushed: 0, conflicts: [] };

  const deduplicated = deduplicateQueue(queue);
  const pushResult = await pushChanges(deduplicated);
  if (!pushResult) return null;

  // Drop accepted entries from the local queue. Anything not in the
  // accepted set stays put — either the server rejected it (conflict)
  // or it's a new entry that was queued after the request started.
  const acceptedKeys = new Set(
    (pushResult.acceptedEntities ?? []).map((entry) => `${entry.entityType}:${entry.entityId}`),
  );
  if (acceptedKeys.size > 0) {
    const db = await getDb();
    const idsToRemove = queue
      .filter((entry) => acceptedKeys.has(`${entry.entityType}:${entry.entityId}`))
      .map((e) => e.id)
      .filter((id): id is number => id != null);
    for (const id of idsToRemove) {
      await db.runAsync("DELETE FROM sync_queue WHERE id = ?", [id]);
    }
  }

  return { pushed: pushResult.accepted ?? 0, conflicts: pushResult.conflicts ?? [] };
}

// Debounced opportunistic-push trigger. Every local write
// (page flip, bookmark, note, highlight) calls schedulePush(); we
// coalesce rapid bursts so a 10-page sprint costs one POST, not ten.
//
// Offline behaviour: pushPending() returns null on network failure
// without touching the queue, so writes accumulate locally and the
// next successful push (or the next runSync on launch) drains them.
let _pushTimer: ReturnType<typeof setTimeout> | null = null;
let _pushInFlight = false;
const PUSH_DEBOUNCE_MS = 800;

export function schedulePush(): void {
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(async () => {
    _pushTimer = null;
    if (_pushInFlight) {
      // Another push started already — re-arm so any writes that
      // happened after that push started still get a chance.
      schedulePush();
      return;
    }
    _pushInFlight = true;
    try {
      await pushPending();
    } catch {
      // Swallow — pushPending already returns null on failure and
      // leaves the queue intact. We just don't want a thrown error to
      // become an unhandled promise rejection in the JS console.
    } finally {
      _pushInFlight = false;
    }
  }, PUSH_DEBOUNCE_MS);
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
      const acceptedKeys = new Set(
        (pushResult.acceptedEntities ?? []).map((entry) => `${entry.entityType}:${entry.entityId}`),
      );

      if (acceptedKeys.size > 0) {
        const db = await getDb();
        const idsToRemove = queue
          .filter((entry) => acceptedKeys.has(`${entry.entityType}:${entry.entityId}`))
          .map((e) => e.id)
          .filter((id): id is number => id != null);

        for (const id of idsToRemove) {
          await db.runAsync("DELETE FROM sync_queue WHERE id = ?", [id]);
        }
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
