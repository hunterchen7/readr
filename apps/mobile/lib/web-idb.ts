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
// v2: add a `by_book` index on reading_progress so getProgress()
// can find the latest row across all devices without scanning.
const DB_VERSION = 2;

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
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      const upgradeTx = req.transaction;

      // reading_progress — keyed by synthetic `id`, with a compound
      // (bookId, deviceId) index for the "one row per device" query
      // and a bare bookId index for "latest row across devices".
      if (!db.objectStoreNames.contains(STORE.progress)) {
        const s = db.createObjectStore(STORE.progress, { keyPath: "id" });
        s.createIndex("by_book_device", ["bookId", "deviceId"], { unique: true });
        s.createIndex("by_device", "deviceId", { unique: false });
        s.createIndex("by_book", "bookId", { unique: false });
      } else if (oldVersion < 2 && upgradeTx) {
        // Existing install — the store exists without the new index.
        // onupgradeneeded gives us a `versionchange` transaction we
        // can reach into to mutate the schema in-place.
        const s = upgradeTx.objectStore(STORE.progress);
        if (!s.indexNames.contains("by_book")) {
          s.createIndex("by_book", "bookId", { unique: false });
        }
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
    req.onsuccess = () => {
      const db = req.result;
      // Another tab bumped DB_VERSION and is waiting for us to
      // close the old connection. Close it so their upgrade can
      // proceed and drop our cached promise so the next openDb()
      // re-opens at the new version.
      db.onversionchange = () => {
        try { db.close(); } catch { /* ignore */ }
        if (dbPromise === pending) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("failed to open IndexedDB"));
    req.onblocked = () =>
      reject(
        new Error(
          "IndexedDB open blocked — another tab is holding an old version. Reload all Readr tabs to continue.",
        ),
      );
  });
  // Uncache a rejected open attempt so callers can retry (e.g.
  // transient `onblocked` from another tab that later closed). A
  // cached rejection would wedge the whole app until reload.
  pending.catch(() => {
    if (dbPromise === pending) dbPromise = null;
  });
  dbPromise = pending;
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
