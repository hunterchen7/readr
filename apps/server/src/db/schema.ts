import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  jsonb,
  boolean,
  serial,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  // The id IS the bearer token — a long random string generated on the
  // client on first launch. There are no passwords, no sessions.
  id: text("id").primaryKey(),
  // Optional metadata the user can set (shown on the Settings screen).
  name: text("name"),
  // Optional recovery email. Nullable because attaching an email is
  // opt-in and the token is still the only auth factor. email is
  // verified via a 6-digit code sent through Resend; emailVerifiedAt
  // is stamped on successful verification. Not unique: two users on
  // different devices could legitimately share the same personal
  // email.
  email: text("email"),
  emailVerifiedAt: timestamp("email_verified_at"),
  storageQuotaMb: integer("storage_quota_mb").default(1024),
  storageUsedMb: integer("storage_used_mb").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Pending email verification codes. Short-lived (~15 min), single use.
// Intentionally not linked to a userId for the recovery flow — the
// recovery endpoint takes an email and sends a code without revealing
// whether the email is registered, so the row may or may not point at
// an existing user by the time it's consumed.
export const emailVerifications = pgTable("email_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  code: text("code").notNull(), // 6-digit zero-padded
  purpose: text("purpose").notNull(), // 'attach' | 'recover'
  userId: text("user_id"), // set for 'attach', null for 'recover' until we look it up
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Content-addressable file storage.
//
// A `files` row represents one physical EPUB/PDF identified by its content
// hash. Metadata (title/author/language/cover) is extracted once on first
// upload and stored here so every user that uploads the same file shares
// the same metadata — no duplication, no inconsistency.
//
// The hash is SHA-256. When the user referred to "md5", they meant
// "content hash" colloquially; SHA-256 is stronger and already plumbed
// through, so we stick with it.
export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  sha256: text("sha256").unique().notNull(),
  s3Key: text("s3_key").notNull(),
  coverKey: text("cover_key"),
  size: bigint("size", { mode: "number" }).notNull(),
  format: text("format").notNull(), // 'epub' | 'pdf'
  refCount: integer("ref_count").default(1),

  // Extracted metadata — shared across users.
  title: text("title"),
  author: text("author"),
  language: text("language"),
  totalChapters: integer("total_chapters"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at").defaultNow(),
});

// A `books` row is a user's reference to a file. All user-specific state
// (progress, highlights, notes, collections) hangs off the book id. User-
// facing title/author come from the joined files row.
export const books = pgTable(
  "books",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    fileId: uuid("file_id")
      .references(() => files.id)
      .notNull(),
    // Optional per-user overrides. Null = inherit from files.*.
    // Useful if the user wants to rename a book in their own library.
    titleOverride: text("title_override"),
    authorOverride: text("author_override"),
    uploadedAt: timestamp("uploaded_at").defaultNow(),
  },
  (table) => [
    index("books_user_idx").on(table.userId),
    uniqueIndex("books_user_file_idx").on(table.userId, table.fileId),
  ],
);

export const readingProgress = pgTable(
  "reading_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .references(() => books.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    deviceId: text("device_id").notNull(),
    position: jsonb("position").notNull().$type<{
      chapter?: number;
      cfi?: string;
      page?: number;
      percentage: number;
    }>(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("progress_unique_idx").on(
      table.bookId,
      table.userId,
      table.deviceId,
    ),
  ],
);

export const bookmarks = pgTable("bookmarks", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id")
    .references(() => books.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  position: jsonb("position").notNull(),
  label: text("label"),
  createdAt: timestamp("created_at").defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export const highlights = pgTable("highlights", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id")
    .references(() => books.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  cfiRange: text("cfi_range").notNull(),
  textContent: text("text_content"),
  note: text("note"),
  color: text("color").default("yellow"),
  createdAt: timestamp("created_at").defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id")
    .references(() => books.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  position: jsonb("position").notNull(),
  noteType: text("note_type").notNull(),
  textContent: text("text_content"),
  strokes: jsonb("strokes").$type<
    {
      points: { x: number; y: number; pressure: number }[];
      color: string;
      width: number;
    }[]
  >(),
  penConfig: jsonb("pen_config").$type<{ color: string; width: number }>(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export const lookupProviders = pgTable("lookup_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  icon: text("icon"),
  urlTemplate: text("url_template").notNull(),
  enabled: boolean("enabled").default(true),
  sortOrder: integer("sort_order").default(0),
  isBuiltin: boolean("is_builtin").default(false),
});

export const ttsJobs = pgTable("tts_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id")
    .references(() => books.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  status: text("status").notNull().default("queued"),
  engine: text("engine").default("chatterbox-turbo"),
  chaptersTotal: integer("chapters_total"),
  chaptersDone: integer("chapters_done").default(0),
  voiceConfig: jsonb("voice_config").$type<{
    voiceId?: string;
    exaggeration?: number;
    speed?: number;
  }>(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const ttsAudioChunks = pgTable("tts_audio_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .references(() => ttsJobs.id, { onDelete: "cascade" })
    .notNull(),
  chapterIndex: integer("chapter_index").notNull(),
  audioKey: text("audio_key").notNull(),
  durationMs: integer("duration_ms"),
  format: text("format").default("opus"),
});

// Collections / tags
export const collections = pgTable("collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color"),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const bookCollections = pgTable(
  "book_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .references(() => books.id, { onDelete: "cascade" })
      .notNull(),
    collectionId: uuid("collection_id")
      .references(() => collections.id, { onDelete: "cascade" })
      .notNull(),
    addedAt: timestamp("added_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("book_collection_unique_idx").on(table.bookId, table.collectionId),
  ],
);

// Reading stats
export const readingSessions = pgTable("reading_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  bookId: uuid("book_id")
    .references(() => books.id, { onDelete: "cascade" })
    .notNull(),
  startedAt: timestamp("started_at").notNull(),
  endedAt: timestamp("ended_at"),
  durationMinutes: integer("duration_minutes"),
  pagesRead: integer("pages_read"),
  startPercentage: integer("start_percentage"),
  endPercentage: integer("end_percentage"),
});

export const syncLog = pgTable(
  "sync_log",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    operation: text("operation").notNull(),
    payload: jsonb("payload"),
    deviceId: text("device_id"),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
  },
  (table) => [index("sync_log_user_ts_idx").on(table.userId, table.timestamp)],
);
