/**
 * Offline change queue — client-side only.
 * Manages queued changes for batch push when online.
 */

import type { SyncLogEntry } from "@readr/shared";

export interface QueuedChange {
  id: number;
  entry: SyncLogEntry;
}

/**
 * Deduplicate queued changes: for the same entity, keep only the latest operation.
 * This prevents sending stale intermediate states.
 */
export function deduplicateQueue(entries: SyncLogEntry[]): SyncLogEntry[] {
  const latest = new Map<string, SyncLogEntry>();

  for (const entry of entries) {
    const key = `${entry.entityType}:${entry.entityId}`;
    const existing = latest.get(key);

    if (!existing || new Date(entry.timestamp) > new Date(existing.timestamp)) {
      latest.set(key, entry);
    }
  }

  return Array.from(latest.values());
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
