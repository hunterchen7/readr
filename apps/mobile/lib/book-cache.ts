// expo-file-system v19 moved the procedural API (documentDirectory,
// createDownloadResumable, getInfoAsync, ...) behind /legacy while the
// new class-based API settles. Legacy is the right choice for one-shot
// downloads where we just want a file on disk.
import * as FileSystem from "expo-file-system/legacy";
import { getDb } from "./local-db";
import { getBook } from "./api";

/**
 * Per-book local cache. When the user taps "Download" in the library, we
 * fetch the book binary via the server's presigned URL and save it to
 * the app's document directory as
 *   <documentDirectory>/books/<bookId>.<format>
 * The downloaded_books table records (bookId, fileId, format, path,
 * size). The reader prefers the local file via file:// so offline
 * opens work and re-opens are instant.
 */

const BOOKS_DIR = FileSystem.documentDirectory + "books/";

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(BOOKS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(BOOKS_DIR, { intermediates: true });
  }
}

export interface DownloadedBook {
  bookId: string;
  fileId: string;
  format: "epub" | "pdf";
  localPath: string;
  sizeBytes: number;
  downloadedAt: string;
}

export async function getDownloadedBook(
  bookId: string,
): Promise<DownloadedBook | null> {
  const database = await getDb();
  const row = await database.getFirstAsync<{
    book_id: string;
    file_id: string;
    format: string;
    local_path: string;
    size_bytes: number;
    downloaded_at: string;
  }>(
    "SELECT * FROM downloaded_books WHERE book_id = ?",
    [bookId],
  );
  if (!row) return null;
  // Guard against the file being deleted out from under us.
  const info = await FileSystem.getInfoAsync(row.local_path);
  if (!info.exists) {
    await database.runAsync("DELETE FROM downloaded_books WHERE book_id = ?", [
      bookId,
    ]);
    return null;
  }
  return {
    bookId: row.book_id,
    fileId: row.file_id,
    format: row.format as "epub" | "pdf",
    localPath: row.local_path,
    sizeBytes: row.size_bytes,
    downloadedAt: row.downloaded_at,
  };
}

export async function getDownloadedBookIds(): Promise<Set<string>> {
  const database = await getDb();
  const rows = await database.getAllAsync<{ book_id: string }>(
    "SELECT book_id FROM downloaded_books",
  );
  return new Set(rows.map((r) => r.book_id));
}

/**
 * Fetch the book binary and save it locally. Progresses from 0..1 are
 * pushed through the optional onProgress callback so the library card
 * can render a progress bar on the download button.
 */
export async function downloadBook(
  bookId: string,
  onProgress?: (fraction: number) => void,
): Promise<DownloadedBook> {
  await ensureDir();
  const { book } = await getBook(bookId);
  if (!book.downloadUrl) throw new Error("Book has no downloadable URL");
  const format = (book.format ?? "epub") as "epub" | "pdf";
  const localPath = `${BOOKS_DIR}${bookId}.${format}`;

  const downloadResumable = FileSystem.createDownloadResumable(
    book.downloadUrl,
    localPath,
    {},
    (progress) => {
      if (progress.totalBytesExpectedToWrite > 0 && onProgress) {
        onProgress(
          progress.totalBytesWritten / progress.totalBytesExpectedToWrite,
        );
      }
    },
  );

  const result = await downloadResumable.downloadAsync();
  if (!result) throw new Error("Download was cancelled");
  const info = await FileSystem.getInfoAsync(result.uri);
  const sizeBytes =
    info.exists && "size" in info ? (info.size as number) : 0;

  const database = await getDb();
  await database.runAsync(
    `INSERT INTO downloaded_books
       (book_id, file_id, format, local_path, size_bytes, downloaded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET
       file_id=excluded.file_id,
       format=excluded.format,
       local_path=excluded.local_path,
       size_bytes=excluded.size_bytes,
       downloaded_at=excluded.downloaded_at`,
    [
      bookId,
      book.fileId,
      format,
      result.uri,
      sizeBytes,
      new Date().toISOString(),
    ],
  );

  return {
    bookId,
    fileId: book.fileId,
    format,
    localPath: result.uri,
    sizeBytes,
    downloadedAt: new Date().toISOString(),
  };
}

export async function deleteDownloadedBook(bookId: string): Promise<void> {
  const existing = await getDownloadedBook(bookId);
  if (existing) {
    await FileSystem.deleteAsync(existing.localPath, { idempotent: true });
  }
  const database = await getDb();
  await database.runAsync("DELETE FROM downloaded_books WHERE book_id = ?", [
    bookId,
  ]);
}
