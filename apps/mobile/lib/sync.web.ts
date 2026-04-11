/**
 * Web stub for the sync engine. On native, runSync pulls remote
 * changes into SQLite, then pushes queued local mutations back up.
 * None of that works in the browser today: local-db is a no-op on
 * web (no expo-sqlite), so the queue is always empty and there's no
 * local row to reconcile remote changes against.
 *
 * Instead of wiring up an in-memory sync path, we just short-circuit
 * to "nothing to do". The library's sync chip shows an idle state and
 * the server remains the source of truth for everything the web
 * build cares about (books, uploads, progress fetched via the query).
 */
import type { SyncConflict } from "@readr/shared";

export async function runSync(): Promise<{
  pulled: number;
  pushed: number;
  conflicts: SyncConflict[];
} | null> {
  return { pulled: 0, pushed: 0, conflicts: [] };
}
