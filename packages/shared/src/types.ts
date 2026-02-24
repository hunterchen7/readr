export interface User {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  image: string | null;
  storageQuotaMb: number;
  storageUsedMb: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  sha256: string;
  s3Key: string;
  coverKey: string | null;
  size: number;
  format: "epub" | "pdf";
  refCount: number;
  createdAt: string;
}

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
  coverUrl?: string;
  downloadUrl?: string;
  format?: "epub" | "pdf";
  fileSize?: number;
}

export interface BookPosition {
  chapter?: number;
  cfi?: string;
  page?: number;
  percentage: number;
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
