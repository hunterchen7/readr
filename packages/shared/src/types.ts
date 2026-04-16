/**
 * A user row. There's no email / password / OAuth metadata — users are
 * identified purely by their bearer token (which is also the primary
 * key). Name is an optional display label set on first registration.
 */
export interface User {
  id: string;
  name: string | null;
  storageQuotaMb: number;
  storageUsedMb: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A content-addressable file row. One row per SHA-256 of book bytes,
 * shared across every user that has uploaded this file. Title/author/
 * language/cover all live here because they're extracted once and are
 * the same for everyone.
 */
export interface FileRecord {
  id: string;
  sha256: string;
  /** MD5 of the file bytes, for cross-reference with external services. */
  md5: string | null;
  s3Key: string;
  coverKey: string | null;
  size: number;
  format: "epub" | "pdf";
  refCount: number;
  title: string | null;
  author: string | null;
  language: string | null;
  totalChapters: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * The user-facing Book. `title`/`author`/`language`/`totalChapters`/
 * `metadata` are effective values computed server-side as
 * `coalesce(books.title_override, files.title)` etc., so clients never
 * have to join tables themselves.
 */
export interface Book {
  id: string;
  userId: string;
  fileId: string;
  title: string | null;
  author: string | null;
  language: string | null;
  totalChapters: number | null;
  metadata: Record<string, unknown> | null;
  uploadedAt: string;
  // Joined fields (optional, present in API responses)
  coverUrl?: string | null;
  downloadUrl?: string | null;
  format?: "epub" | "pdf";
  fileSize?: number;
}

export interface BookPosition {
  chapter?: number;
  /** Display label of the containing TOC entry — stable across font/
   *  margin changes, unlike `page`, so it's the right thing to show
   *  in bookmark / note lists. */
  chapterLabel?: string;
  cfi?: string;
  page?: number;
  percentage: number;
  /** User-set "I've finished this" flag. Orthogonal to percentage —
   *  the position fields above still reflect where the user actually
   *  stopped reading, so Continue on a finished book returns there. */
  finished?: boolean;
}

export interface ReadingProgress {
  id: string;
  bookId: string;
  userId: string;
  deviceId: string;
  position: BookPosition;
  updatedAt: string;
}

export interface Bookmark {
  id: string;
  bookId: string;
  userId: string;
  position: BookPosition;
  label: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface Highlight {
  id: string;
  bookId: string;
  userId: string;
  cfiRange: string;
  textContent: string | null;
  note: string | null;
  color: HighlightColor;
  /** Captured at creation time so the bookmarks/notes drawer can show
   *  a stable "chapter · %" label even though the Highlight is pinned
   *  to a CFI range, not a BookPosition. */
  chapterLabel: string | null;
  percentage: number | null;
  createdAt: string;
  deletedAt: string | null;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

export interface Stroke {
  points: StrokePoint[];
  color: string;
  width: number;
}

export interface PenConfig {
  color: string;
  width: number;
}

export interface Note {
  id: string;
  bookId: string;
  userId: string;
  position: BookPosition;
  noteType: "typed" | "handwritten";
  textContent: string | null;
  strokes: Stroke[] | null;
  penConfig: PenConfig | null;
  /** Base64 PNG data URI of the canvas as captured from the
   *  display framebuffer (includes kernel-drawn strokes). Used
   *  on Supernote as the authoritative visual instead of Skia
   *  re-rendering from stroke data. */
  canvasImage: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LookupProvider {
  id: string;
  userId: string;
  name: string;
  icon: string | null;
  urlTemplate: string;
  enabled: boolean;
  sortOrder: number;
  isBuiltin: boolean;
}

export interface TTSJob {
  id: string;
  bookId: string;
  userId: string;
  status: "queued" | "processing" | "done" | "failed";
  engine: string;
  chaptersTotal: number | null;
  chaptersDone: number;
  voiceConfig: VoiceConfig | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface VoiceConfig {
  voiceId?: string;
  exaggeration?: number;
  speed?: number;
}

export interface TTSAudioChunk {
  id: string;
  jobId: string;
  chapterIndex: number;
  audioKey: string;
  durationMs: number | null;
  format: string;
}

export interface SyncLogEntry {
  id?: number;
  userId?: string;
  entityType: "bookmark" | "highlight" | "note" | "progress";
  entityId: string;
  operation: "create" | "update" | "delete";
  payload: Record<string, unknown> | null;
  deviceId: string | null;
  timestamp: string;
}

export interface SyncConflict {
  entityType: string;
  entityId: string;
  resolution: "server_wins" | "client_wins";
  serverValue: Record<string, unknown>;
}

export interface TTSStatus {
  available: boolean;
  engines: string[];
  streamingAvailable: boolean;
  queueDepth: number;
}
