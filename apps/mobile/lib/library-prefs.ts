import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

export type LibrarySort = "recent" | "lastRead" | "title" | "author";
export type LibrarySortDir = "asc" | "desc";
export type LibraryFilter =
  | "all"
  | "reading"
  | "unread"
  | "finished"
  | "downloaded";
export type LibraryView = "grid" | "list";

/** Direction the server returns for each sort field by default. */
export const SORT_SERVER_DEFAULT_DIR: Record<LibrarySort, LibrarySortDir> = {
  recent: "desc",
  lastRead: "desc",
  title: "asc",
  author: "asc",
};

interface LibraryPrefsState {
  sort: LibrarySort;
  sortDir: LibrarySortDir;
  filter: LibraryFilter;
  view: LibraryView;
  _hydrated: boolean;

  setSort: (sort: LibrarySort) => void;
  setSortDir: (dir: LibrarySortDir) => void;
  setFilter: (filter: LibraryFilter) => void;
  setView: (view: LibraryView) => void;
  hydrate: () => Promise<void>;
}

const KEY = "libraryPrefs";

interface Persisted {
  sort: LibrarySort;
  sortDir: LibrarySortDir;
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
  sortDir: SORT_SERVER_DEFAULT_DIR.recent,
  filter: "all",
  view: "grid",
  _hydrated: false,

  setSort: (sort) => {
    // When switching sort field, reset direction to that field's natural default.
    const sortDir = SORT_SERVER_DEFAULT_DIR[sort];
    set({ sort, sortDir });
    const { filter, view } = get();
    save({ sort, sortDir, filter, view });
  },
  setSortDir: (sortDir) => {
    set({ sortDir });
    const { sort, filter, view } = get();
    save({ sort, sortDir, filter, view });
  },
  setFilter: (filter) => {
    set({ filter });
    const { sort, sortDir, view } = get();
    save({ sort, sortDir, filter, view });
  },
  setView: (view) => {
    set({ view });
    const { sort, sortDir, filter } = get();
    save({ sort, sortDir, filter, view });
  },

  hydrate: async () => {
    if (get()._hydrated) return;
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Persisted>;
        const sort = parsed.sort ?? "recent";
        set({
          sort,
          sortDir: parsed.sortDir ?? SORT_SERVER_DEFAULT_DIR[sort],
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
