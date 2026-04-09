import { create } from "zustand";
import { runSync } from "./sync";

export type SyncPhase = "idle" | "running" | "error";

interface SyncStatusState {
  phase: SyncPhase;
  lastError: string | null;
  lastSyncAt: number | null;
  pulled: number;
  pushed: number;
  conflicts: number;
  /** Run a sync cycle and update the store. Safe to call concurrently —
   *  a running cycle is a no-op. */
  sync: () => Promise<void>;
}

/**
 * Thin zustand wrapper around runSync() so any screen can subscribe to
 * "is a sync happening?" and trigger a manual pull/push. Library uses
 * this to show a chip in the header.
 */
export const useSyncStatus = create<SyncStatusState>((set, get) => ({
  phase: "idle",
  lastError: null,
  lastSyncAt: null,
  pulled: 0,
  pushed: 0,
  conflicts: 0,

  sync: async () => {
    if (get().phase === "running") return;
    set({ phase: "running", lastError: null });
    try {
      const result = await runSync();
      if (!result) {
        // Null means offline / unauthenticated. Reset silently.
        set({ phase: "idle", lastSyncAt: Date.now() });
        return;
      }
      set({
        phase: "idle",
        lastSyncAt: Date.now(),
        pulled: result.pulled,
        pushed: result.pushed,
        conflicts: result.conflicts.length,
      });
    } catch (err) {
      set({
        phase: "error",
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
