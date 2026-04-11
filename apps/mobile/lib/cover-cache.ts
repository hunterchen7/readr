/**
 * Per-book cover image cache. Server returns presigned R2 URLs that
 * expire (and are unreachable offline anyway). We download each cover
 * once into the app's document directory and rewrite the cached
 * `books.cover_url` to a stable `file://` URL so the library renders
 * offline and survives URL expiry.
 *
 * Downloads run in the background after every successful listBooks()
 * via `cacheCoversInBackground()` — never blocks the UI.
 */
import * as FileSystem from "expo-file-system/legacy";
import { getDb } from "./local-db";

const COVERS_DIR = `${FileSystem.documentDirectory}covers/`;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(COVERS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(COVERS_DIR, { intermediates: true });
  }
}

function localPathFor(bookId: string): string {
  return `${COVERS_DIR}${bookId}.jpg`;
}

/**
 * Download a single cover and rewrite the books.cover_url in SQLite to
 * the local file:// URL. No-op if the cover is already cached or the
 * remote URL is missing/already a file://.
 *
 * Errors are swallowed — a missing cover is a cosmetic problem, not a
 * data integrity one. The library renders the title text fallback.
 */
export async function cacheCover(bookId: string, remoteUrl: string | null | undefined): Promise<void> {
  if (!remoteUrl || remoteUrl.startsWith("file://")) return;
  try {
    await ensureDir();
    const localPath = localPathFor(bookId);
    const info = await FileSystem.getInfoAsync(localPath);
    if (!info.exists) {
      const result = await FileSystem.downloadAsync(remoteUrl, localPath);
      if (result.status < 200 || result.status >= 300) {
        // Drop the partial file so the next attempt starts clean.
        await FileSystem.deleteAsync(localPath, { idempotent: true });
        return;
      }
    }
    const database = await getDb();
    await database.runAsync(
      "UPDATE books SET cover_url = ? WHERE id = ?",
      [localPath, bookId],
    );
  } catch (err) {
    console.warn(`cacheCover(${bookId}) failed:`, err);
  }
}

/**
 * Background-cache covers for a list of books. Returns immediately —
 * the actual downloads happen async. Idempotent: books that already
 * have a `file://` cover_url are skipped.
 *
 * Limited concurrency so we don't slam R2 with 50 parallel requests
 * when the library first loads.
 */
export function cacheCoversInBackground(
  books: { id: string; coverUrl?: string | null }[],
): void {
  const targets = books.filter(
    (b) => !!b.coverUrl && !b.coverUrl.startsWith("file://"),
  );
  if (targets.length === 0) return;
  void (async () => {
    const CONCURRENCY = 3;
    const queue = [...targets];
    async function worker() {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) return;
        await cacheCover(next.id, next.coverUrl);
      }
    }
    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
  })();
}

/** Delete the cached cover file for a book. Used by deleteBook. */
export async function deleteCachedCover(bookId: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(localPathFor(bookId), { idempotent: true });
  } catch {
    // No-op — best-effort cleanup.
  }
}
