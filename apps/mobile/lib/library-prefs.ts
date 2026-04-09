import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

export type LibrarySort = "recent" | "lastRead" | "title" | "author";
export type LibraryFilter =
  | "all"
  | "reading"
  | "unread"
  | "finished"
  | "downloaded";
export type LibraryView = "grid" | "list";

interface LibraryPrefsState {
  sort: LibrarySort;
  filter: LibraryFilter;
  view: LibraryView;
  _hydrated: boolean;

  setSort: (sort: LibrarySort) => void;
  setFilter: (filter: LibraryFilter) => void;
  setView: (view: LibraryView) => void;
  hydrate: () => Promise<void>;
}

const KEY = "libraryPrefs";

interface Persisted {
  sort: LibrarySort;
  filter: LibraryFilter;
  view: LibraryView;
}

async function save(state: Persisted) {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(state));
  } catch {
    // Non-fatal — the UI keeps working with in-memory state.
  }
}

/**
 * Persisted library UI preferences — sort/filter/view mode. Stored in
 * SecureStore alongside the bearer token because they're per-device.
 * Hydrate() is called from the root layout on app launch.
 */
export const useLibraryPrefs = create<LibraryPrefsState>((set, get) => ({
  sort: "recent",
  filter: "all",
  view: "grid",
  _hydrated: false,

  setSort: (sort) => {
    set({ sort });
    const { filter, view } = get();
    save({ sort, filter, view });
  },
  setFilter: (filter) => {
    set({ filter });
    const { sort, view } = get();
    save({ sort, filter, view });
  },
  setView: (view) => {
    set({ view });
    const { sort, filter } = get();
    save({ sort, filter, view });
  },

  hydrate: async () => {
    if (get()._hydrated) return;
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Persisted>;
        set({
          sort: parsed.sort ?? "recent",
          filter: parsed.filter ?? "all",
          view: parsed.view ?? "grid",
          _hydrated: true,
        });
        return;
      }
    } catch {
      // Ignore — fall through to defaults.
    }
    set({ _hydrated: true });
  },
}));
