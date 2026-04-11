/**
 * Web stub for the cover image cache. The native build stores cover
 * images in the document directory via expo-file-system and rewrites
 * books.cover_url to the file:// path so the library survives
 * presigned-URL expiry. On web we skip all of that — the browser's
 * HTTP cache handles repeat renders, and there is no offline mode to
 * support (the library queryFn on web doesn't fall back to a local
 * mirror). These exports exist only so library/book-detail screens
 * can import the helpers without Metro failing platform resolution.
 */

export async function cacheCover(
  _bookId: string,
  _remoteUrl: string | null | undefined,
): Promise<void> {
  // No-op on web.
}

export function cacheCoversInBackground(
  _books: { id: string; coverUrl?: string | null }[],
): void {
  // No-op on web.
}

export async function deleteCachedCover(_bookId: string): Promise<void> {
  // No-op on web.
}
