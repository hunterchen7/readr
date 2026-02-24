/**
 * Add/tombstone set merge for annotations (bookmarks, highlights, notes).
 *
 * Rules:
 * - Create: if entity doesn't exist, insert it. If it exists with deletedAt, it stays deleted (tombstone wins).
 * - Delete: set deletedAt. Tombstone is permanent.
 * - Update: apply if entity exists and is not tombstoned. LWW by timestamp for field conflicts.
 */

import type { SyncLogEntry } from "@readr/shared";

export type SetOperation = "create" | "update" | "delete";

export interface SetMergeInput {
  operation: SetOperation;
  entityId: string;
  timestamp: string;
  payload: Record<string, unknown> | null;
}

export interface ExistingEntity {
  id: string;
  deletedAt: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

export interface SetMergeResult {
  action: "insert" | "update" | "soft_delete" | "skip";
  reason?: string;
}

/**
 * Determine what action to take when merging an annotation change.
 */
export function setMerge(
  change: SetMergeInput,
  existing: ExistingEntity | null,
): SetMergeResult {
  switch (change.operation) {
    case "create": {
      if (!existing) {
        return { action: "insert" };
      }
      // Entity already exists
      if (existing.deletedAt) {
        // Tombstone wins — don't resurrect
        return { action: "skip", reason: "tombstoned" };
      }
      // Already exists and not deleted — skip duplicate create
      return { action: "skip", reason: "already_exists" };
    }

    case "update": {
      if (!existing) {
        // Can't update what doesn't exist — treat as insert
        return { action: "insert" };
      }
      if (existing.deletedAt) {
        return { action: "skip", reason: "tombstoned" };
      }
      // LWW for updates
      const existingTime = existing.updatedAt ?? existing.createdAt;
      if (existingTime && new Date(change.timestamp) <= new Date(existingTime)) {
        return { action: "skip", reason: "stale_update" };
      }
      return { action: "update" };
    }

    case "delete": {
      if (!existing) {
        // Nothing to delete
        return { action: "skip", reason: "not_found" };
      }
      if (existing.deletedAt) {
        // Already tombstoned
        return { action: "skip", reason: "already_deleted" };
      }
      return { action: "soft_delete" };
    }

    default:
      return { action: "skip", reason: "unknown_operation" };
  }
}

/**
 * Process a batch of sync changes and return the merge results.
 */
export function processBatch(
  changes: SetMergeInput[],
  existingMap: Map<string, ExistingEntity | null>,
): Array<{ change: SetMergeInput; result: SetMergeResult }> {
  return changes.map((change) => ({
    change,
    result: setMerge(change, existingMap.get(change.entityId) ?? null),
  }));
}
