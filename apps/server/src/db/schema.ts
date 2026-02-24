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
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique().notNull(),
  name: text("name"),
  emailVerified: boolean("email_verified").default(false),
  image: text("image"),
  storageQuotaMb: integer("storage_quota_mb").default(1024),
  storageUsedMb: integer("storage_used_mb").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// better-auth session and account tables
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  token: text("token").unique().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Content-addressable file storage
export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  sha256: text("sha256").unique().notNull(),
  s3Key: text("s3_key").notNull(),
  coverKey: text("cover_key"),
  size: bigint("size", { mode: "number" }).notNull(),
  format: text("format").notNull(), // 'epub' | 'pdf'
  refCount: integer("ref_count").default(1),
  createdAt: timestamp("created_at").defaultNow(),
});

export const books = pgTable(
  "books",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    fileId: uuid("file_id")
      .references(() => files.id)
      .notNull(),
    title: text("title"),
    author: text("author"),
    language: text("language"),
    totalChapters: integer("total_chapters"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
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
    userId: uuid("user_id")
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
  userId: uuid("user_id")
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
  userId: uuid("user_id")
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
  userId: uuid("user_id")
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
  userId: uuid("user_id")
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
  userId: uuid("user_id")
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
  userId: uuid("user_id")
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
  userId: uuid("user_id")
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
    userId: uuid("user_id")
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
