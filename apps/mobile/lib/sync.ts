import * as Storage from "./storage";
import type { SyncLogEntry, SyncConflict } from "@readr/shared";
import { deduplicateQueue } from "@readr/sync-engine";
import { getServerUrl, getToken } from "./api";
import { getSyncQueue, getDb } from "./local-db";

const LAST_SYNC_KEY = "lastSyncTimestamp";

async function getLastSyncTimestamp(): Promise<string> {
  const ts = await Storage.getItem(LAST_SYNC_KEY);
  // Default to epoch if never synced
  return ts ?? "1970-01-01T00:00:00.000Z";
}

async function setLastSyncTimestamp(ts: string): Promise<void> {
  await Storage.setItem(LAST_SYNC_KEY, ts);
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

function hasKey(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function jsonOrNull(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

// 30s upper bound on every sync request so a hung server doesn't keep
// a fetch alive indefinitely. The bare `fetch` calls below can't borrow
// apiFetch's wrapper because they read the JSON body manually and want
// to swallow non-2xx as null instead of throwing.
const SYNC_TIMEOUT_MS = 30_000;

function withTimeout(): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
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

  const { signal, cancel } = withTimeout();
  try {
    const res = await fetch(`${serverUrl}/api/sync/changes?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  } finally {
    cancel();
  }
}

/**
 * Push local changes to the server.
 */
async function pushChanges(changes: SyncLogEntry[]): Promise<PushResponse | null> {
  const serverUrl = await getServerUrl();
  const token = await getToken();
  if (!serverUrl || !token) return null;

  const { signal, cancel } = withTimeout();
  try {
    const res = await fetch(`${serverUrl}/api/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ changes }),
      signal,
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  } finally {
    cancel();
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

  if (change.operation === "update") {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (hasKey(payload, "label")) {
      sets.push("label = ?");
      params.push((payload.label as string | null) ?? null);
    }
    sets.push("synced = 1");
    if (params.length > 0) {
      params.push(change.entityId);
      await database.runAsync(
        `UPDATE bookmarks SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    }
    return;
  }

  if (typeof payload.bookId !== "string" || !payload.position) return;

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

  if (change.operation === "update") {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (hasKey(payload, "textContent")) {
      sets.push("text_content = ?");
      params.push((payload.textContent as string | null) ?? null);
    }
    if (hasKey(payload, "note")) {
      sets.push("note = ?");
      params.push((payload.note as string | null) ?? null);
    }
    if (hasKey(payload, "color")) {
      sets.push("color = ?");
      params.push((payload.color as string | null) ?? "yellow");
    }
    if (hasKey(payload, "chapterLabel")) {
      sets.push("chapter_label = ?");
      params.push((payload.chapterLabel as string | null) ?? null);
    }
    if (hasKey(payload, "percentage")) {
      sets.push("percentage = ?");
      params.push((payload.percentage as number | null) ?? null);
    }
    sets.push("synced = 1");
    if (params.length > 0) {
      params.push(change.entityId);
      await database.runAsync(
        `UPDATE highlights SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    }
    return;
  }

  if (
    typeof payload.bookId !== "string" ||
    typeof payload.cfiRange !== "string"
  ) {
    return;
  }

  await database.runAsync(
    `INSERT OR REPLACE INTO highlights
       (id, book_id, cfi_range, text_content, note, color, chapter_label, percentage, created_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      change.entityId,
      payload.bookId as string,
      payload.cfiRange as string,
      (payload.textContent as string) ?? null,
      (payload.note as string) ?? null,
      (payload.color as string) ?? "yellow",
      (payload.chapterLabel as string) ?? null,
      (payload.percentage as number) ?? null,
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

  if (change.operation === "update") {
    const sets: string[] = ["updated_at = ?", "synced = 1"];
    const params: (string | null)[] = [change.timestamp];
    if (hasKey(payload, "textContent")) {
      sets.unshift("text_content = ?");
      params.unshift((payload.textContent as string | null) ?? null);
    }
    if (hasKey(payload, "strokes")) {
      sets.unshift("strokes = ?");
      params.unshift(jsonOrNull(payload.strokes));
    }
    if (hasKey(payload, "penConfig")) {
      sets.unshift("pen_config = ?");
      params.unshift(jsonOrNull(payload.penConfig));
    }
    if (hasKey(payload, "canvasImage")) {
      sets.unshift("canvas_image = ?");
      params.unshift((payload.canvasImage as string | null) ?? null);
    }
    params.push(change.entityId);
    await database.runAsync(
      `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`,
      params,
    );
    return;
  }

  if (typeof payload.bookId !== "string" || !payload.position) return;

  const now = change.timestamp;
  await database.runAsync(
    `INSERT OR REPLACE INTO notes
       (id, book_id, position, note_type, text_content, strokes, pen_config, canvas_image, created_at, updated_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      change.entityId,
      payload.bookId as string,
      JSON.stringify(payload.position),
      (payload.noteType as string) ?? "typed",
      (payload.textContent as string) ?? null,
      jsonOrNull(payload.strokes),
      jsonOrNull(payload.penConfig),
      (payload.canvasImage as string | null) ?? null,
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
