/**
 * Tiny Promise wrapper around IndexedDB. Just enough to back
 * local-db.web.ts and book-cache.web.ts — does not try to be a
 * general-purpose IDB library. If we ever need features beyond
 * put/get/getAll/delete/range scans, pull in `idb` instead.
 *
 * Schema is hard-coded here rather than split into migration files
 * because (a) it's small, (b) IndexedDB versioning is brittle across
 * browsers, and (c) web persistence is a new surface — we don't have
 * a corpus of existing user data to migrate yet. When we do, bump
 * DB_VERSION and add the new stores/indexes inside the upgrade
 * callback's version gate.
 */

const DB_NAME = "readr";
const DB_VERSION = 1;

// Object store names. Mirror the SQLite table names in local-db.ts so
// the two files track each other when reading side-by-side.
export const STORE = {
  progress: "reading_progress",
  bookmarks: "bookmarks",
  highlights: "highlights",
  notes: "notes",
  syncQueue: "sync_queue",
  downloadedBooks: "downloaded_books",
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      // reading_progress — keyed by synthetic `id`, with a compound
      // (bookId, deviceId) index for the "one row per device" query.
      if (!db.objectStoreNames.contains(STORE.progress)) {
        const s = db.createObjectStore(STORE.progress, { keyPath: "id" });
        s.createIndex("by_book_device", ["bookId", "deviceId"], { unique: true });
        s.createIndex("by_device", "deviceId", { unique: false });
      }

      // bookmarks, highlights, notes — keyed by id, with a book_id
      // index because the common query is "all bookmarks for a book".
      // Soft-delete flag stays on the row; the fetch functions filter
      // `deletedAt == null` in JS since IDB doesn't do WHERE IS NULL
      // efficiently anyway.
      for (const name of [STORE.bookmarks, STORE.highlights, STORE.notes] as StoreName[]) {
        if (!db.objectStoreNames.contains(name)) {
          const s = db.createObjectStore(name, { keyPath: "id" });
          s.createIndex("by_book", "bookId", { unique: false });
        }
      }

      // sync_queue — auto-incrementing numeric key (matches the native
      // SQLite INTEGER PRIMARY KEY AUTOINCREMENT). Timestamp index for
      // ordered scans.
      if (!db.objectStoreNames.contains(STORE.syncQueue)) {
        const s = db.createObjectStore(STORE.syncQueue, { keyPath: "id", autoIncrement: true });
        s.createIndex("by_ts", "timestamp", { unique: false });
      }

      // downloaded_books — keyed by bookId so lookups from book-cache
      // are O(1). Values store the metadata plus a handle pointing at
      // the cached blob (OPFS path, blob record, whatever the cache
      // layer decides).
      if (!db.objectStoreNames.contains(STORE.downloadedBooks)) {
        db.createObjectStore(STORE.downloadedBooks, { keyPath: "bookId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open IndexedDB"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked — another tab is holding an old version"));
  });
  return dbPromise;
}

/**
 * Run a callback inside a single transaction and return a promise
 * that resolves when the transaction commits. The callback receives
 * the requested object stores in the order they were named, so
 * multi-store writes stay atomic.
 */
export async function tx<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  run: (stores: IDBObjectStore[]) => T | Promise<T>,
): Promise<T> {
  const db = await openDb();
  const names = Array.isArray(stores) ? stores : [stores];
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(names, mode);
    const storeHandles = names.map((n) => t.objectStore(n));
    let result: T | undefined;
    // Run the user callback. We capture its return value, then wait
    // for the transaction's `complete` event so the caller's resolve
    // fires only after IDB has actually durably committed the work.
    Promise.resolve(run(storeHandles)).then(
      (r) => { result = r; },
      (err) => {
        reject(err);
        try { t.abort(); } catch { /* ignore */ }
      },
    );
    t.oncomplete = () => resolve(result as T);
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
    t.onerror = () => reject(t.error ?? new Error("IndexedDB transaction error"));
  });
}

/** Wrap an IDBRequest in a Promise. */
export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}
