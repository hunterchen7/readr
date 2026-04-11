/**
 * Web implementation of book-cache backed by the Origin Private File
 * System (OPFS) for the actual book blobs plus an IndexedDB metadata
 * row (via web-idb.ts's `downloaded_books` store) for the id → file
 * mapping, size, and download timestamp.
 *
 * The native file uses expo-file-system's document directory + a
 * downloaded_books SQLite row. Same shape, different backends.
 *
 * OPFS availability:
 *   - Chrome/Edge: >= 86
 *   - Safari: >= 15.2
 *   - Firefox: >= 111
 * Older browsers get a runtime error from downloadBook — the cache
 * becomes a no-op and the reader falls back to streaming from the
 * server on each open. The library/book-detail UX degrades
 * gracefully because getDownloadedBookIds returns an empty set.
 */
import { getBook } from "./api";
import { STORE, tx, req } from "./web-idb";

export interface DownloadedBook {
  bookId: string;
  fileId: string;
  format: "epub" | "pdf";
  /** Blob URL created via URL.createObjectURL for the reader to
   *  consume via its existing fetchBookFile(url) → Blob path. The
   *  caller should revoke it when done. */
  localPath: string;
  sizeBytes: number;
  downloadedAt: string;
}

interface DownloadedBookRecord {
  bookId: string;
  fileId: string;
  format: "epub" | "pdf";
  sizeBytes: number;
  downloadedAt: string;
}

const OPFS_DIR = "readr-books";

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    throw new Error("OPFS is not available in this browser");
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

function fileNameFor(bookId: string, format: "epub" | "pdf"): string {
  return `${bookId}.${format}`;
}

async function readCachedFile(
  bookId: string,
  format: "epub" | "pdf",
): Promise<File | null> {
  try {
    const dir = await opfsRoot();
    const fh = await dir.getFileHandle(fileNameFor(bookId, format));
    return await fh.getFile();
  } catch {
    return null;
  }
}

export async function getDownloadedBook(
  bookId: string,
): Promise<DownloadedBook | null> {
  const row = await tx([STORE.downloadedBooks], "readonly", async ([store]) => {
    return req<DownloadedBookRecord | undefined>(store.get(bookId));
  });
  if (!row) return null;

  // Verify the file still exists in OPFS — drop the stale metadata
  // row if the blob was evicted (quota pressure, manual clear).
  const file = await readCachedFile(row.bookId, row.format);
  if (!file) {
    await tx([STORE.downloadedBooks], "readwrite", async ([store]) => {
      await req(store.delete(bookId));
    });
    return null;
  }

  const blobUrl = URL.createObjectURL(file);
  return {
    bookId: row.bookId,
    fileId: row.fileId,
    format: row.format,
    localPath: blobUrl,
    sizeBytes: row.sizeBytes,
    downloadedAt: row.downloadedAt,
  };
}

export async function getDownloadedBookIds(): Promise<Set<string>> {
  const rows = await tx([STORE.downloadedBooks], "readonly", async ([store]) => {
    return req<DownloadedBookRecord[]>(store.getAll());
  });
  return new Set(rows.map((r) => r.bookId));
}

/**
 * Download a book binary into OPFS and record the metadata row.
 * `onProgress` receives a 0..1 fraction as bytes accumulate. The
 * browser's ReadableStream API lets us report real byte counts
 * instead of the "two-step 0 → 100" stub the in-memory stub had.
 */
export async function downloadBook(
  bookId: string,
  onProgress?: (fraction: number) => void,
): Promise<DownloadedBook> {
  const { book } = await getBook(bookId);
  if (!book.downloadUrl) throw new Error("Book has no downloadable URL");
  const format = (book.format ?? "epub") as "epub" | "pdf";

  const res = await fetch(book.downloadUrl);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  const contentLength = Number(res.headers.get("content-length") ?? "0");
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Download stream not available");

  // Typed as BlobPart[] because TS lib.dom.d.ts rejects
  // Uint8Array<ArrayBufferLike> as a BlobPart — the underlying
  // buffer could theoretically be a SharedArrayBuffer. In practice
  // fetch streams hand out ArrayBuffer-backed bytes, so the cast
  // is safe; the explicit type just keeps the compiler happy.
  const chunks: BlobPart[] = [];
  let received = 0;
  // Pull chunks until the stream closes, pushing progress each
  // time. We build the full Blob in memory before writing to OPFS —
  // streaming writes need createSyncAccessHandle which is
  // worker-only, and most books fit comfortably in RAM (<20 MB).
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      if (onProgress) {
        const frac = contentLength > 0 ? received / contentLength : 0;
        onProgress(Math.min(1, frac));
      }
    }
  }
  if (onProgress && contentLength === 0) onProgress(1);

  const blob = new Blob(chunks, {
    type:
      res.headers.get("content-type") ??
      (format === "pdf" ? "application/pdf" : "application/epub+zip"),
  });

  // Write to OPFS via createWritable + write(blob). Fallback path
  // is createSyncAccessHandle in a worker, which we don't need at
  // this scale. On Safari < 17 createWritable may not exist on the
  // public file handle API; if so, the write throws and we surface
  // it to the caller.
  //
  // `getFileHandle({create:true})` creates an empty file as soon as
  // it resolves, so any failure in the subsequent writable path
  // would leave an orphan zero-byte entry in OPFS. Wrap the whole
  // write in a try/catch that deletes the entry on failure so we
  // never accumulate garbage across failed downloads.
  const fileName = fileNameFor(bookId, format);
  const dir = await opfsRoot();
  const fh = await dir.getFileHandle(fileName, { create: true });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writable = await (fh as any).createWritable();
    try {
      await writable.write(blob);
    } finally {
      // close() must run even on write() failure so the draft isn't
      // locked; swallow its own errors — the outer catch handles
      // teardown if it throws.
      try { await writable.close(); } catch { /* ignore */ }
    }
  } catch (err) {
    try { await dir.removeEntry(fileName); } catch { /* ignore */ }
    throw err;
  }

  const record: DownloadedBookRecord = {
    bookId,
    fileId: book.fileId,
    format,
    sizeBytes: blob.size,
    downloadedAt: new Date().toISOString(),
  };
  await tx([STORE.downloadedBooks], "readwrite", async ([store]) => {
    await req(store.put(record));
  });

  // Hand back a blob URL the reader can open immediately without
  // a second round trip through OPFS.
  const localPath = URL.createObjectURL(blob);
  return {
    bookId,
    fileId: book.fileId,
    format,
    localPath,
    sizeBytes: blob.size,
    downloadedAt: record.downloadedAt,
  };
}

export async function deleteDownloadedBook(bookId: string): Promise<void> {
  const row = await tx([STORE.downloadedBooks], "readonly", async ([store]) => {
    return req<DownloadedBookRecord | undefined>(store.get(bookId));
  });
  if (row) {
    try {
      const dir = await opfsRoot();
      await dir.removeEntry(fileNameFor(bookId, row.format));
    } catch {
      // File may already be gone — nothing to do.
    }
  }
  await tx([STORE.downloadedBooks], "readwrite", async ([store]) => {
    await req(store.delete(bookId));
  });
}

export async function clearAllDownloads(): Promise<number> {
  const rows = await tx([STORE.downloadedBooks], "readonly", async ([store]) => {
    return req<DownloadedBookRecord[]>(store.getAll());
  });
  try {
    const dir = await opfsRoot();
    for (const row of rows) {
      try {
        await dir.removeEntry(fileNameFor(row.bookId, row.format));
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  await tx([STORE.downloadedBooks], "readwrite", async ([store]) => {
    for (const row of rows) await req(store.delete(row.bookId));
  });
  return rows.length;
}
