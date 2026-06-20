/**
 * Offline change queue — client-side only.
 * Manages queued changes for batch push when online.
 */

import type { SyncLogEntry } from "@readr/shared";

export interface QueuedChange {
  id: number;
  entry: SyncLogEntry;
}

function mergePayload(
  earlier: SyncLogEntry["payload"],
  later: SyncLogEntry["payload"],
): SyncLogEntry["payload"] {
  if (!earlier) return later;
  if (!later) return earlier;
  return { ...earlier, ...later };
}

/**
 * Deduplicate queued changes by collapsing each entity's local operation chain.
 *
 * Important cases:
 * - create → update stays a create with merged payload, so the server receives
 *   the full insert shape instead of a partial update for a missing entity.
 * - create/update → delete becomes a delete, so the server can accept and drain
 *   the local queue without trying to insert stale data first.
 */
export function deduplicateQueue(entries: SyncLogEntry[]): SyncLogEntry[] {
  const collapsed = new Map<string, SyncLogEntry>();

  for (const entry of entries) {
    const key = `${entry.entityType}:${entry.entityId}`;
    const existing = collapsed.get(key);

    if (!existing) {
      collapsed.set(key, entry);
      continue;
    }

    if (existing.operation === "delete") continue;

    if (entry.operation === "delete") {
      collapsed.delete(key);
      collapsed.set(key, {
        ...entry,
        payload: existing.operation === "create" ? existing.payload : null,
      });
      continue;
    }

    collapsed.delete(key);
    collapsed.set(key, {
      ...entry,
      operation: existing.operation === "create" ? "create" : entry.operation,
      payload: mergePayload(existing.payload, entry.payload),
    });
  }

  return Array.from(collapsed.values());
}

/**
 * Partition changes into entity-type groups for ordered processing.
 */
export function partitionByType(
  entries: SyncLogEntry[],
): Record<string, SyncLogEntry[]> {
  const partitions: Record<string, SyncLogEntry[]> = {};

  for (const entry of entries) {
    const list = partitions[entry.entityType];
    if (list) {
      list.push(entry);
    } else {
      partitions[entry.entityType] = [entry];
    }
  }

  return partitions;
}
