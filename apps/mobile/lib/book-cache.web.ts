/**
 * Web stub for book-cache. On web, books stream straight from the server
 * via the presigned download URL — there is no offline copy, no local
 * document directory, and nothing to download ahead of time. The library
 * screen is the only caller on web and just needs:
 *   - getDownloadedBookIds() — we return an empty set so every row
 *     shows the "not downloaded" state. library.tsx has a Platform.OS
 *     branch that, on web, routes tap → book detail instead of starting
 *     a download, so `downloaded` being false is harmless.
 *   - downloadBook() / deleteDownloadedBook() / clearAllDownloads() —
 *     throw if ever called; there's no valid implementation on web.
 */

export interface DownloadedBook {
  bookId: string;
  fileId: string;
  format: "epub" | "pdf";
  localPath: string;
  sizeBytes: number;
  downloadedAt: string;
}

export async function getDownloadedBook(
  _bookId: string,
): Promise<DownloadedBook | null> {
  return null;
}

export async function getDownloadedBookIds(): Promise<Set<string>> {
  return new Set();
}

export async function downloadBook(
  _bookId: string,
  _onProgress?: (fraction: number) => void,
): Promise<DownloadedBook> {
  throw new Error("downloadBook is not supported on web");
}

export async function deleteDownloadedBook(_bookId: string): Promise<void> {
  // No-op on web.
}

export async function clearAllDownloads(): Promise<number> {
  return 0;
}
