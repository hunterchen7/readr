# 📖 Open Source E-Book Reader — Implementation Spec

> This document is the single source of truth for building the e-book reader app.
> It is designed to be followed sequentially by an AI coding agent (Claude Code).
> Each phase builds on the previous one. Do not skip phases.

## Project Overview

A cross-platform e-book reader with cloud sync, a web dashboard for file management, and AI-powered text-to-speech. Designed for the Supernote A5X's e-ink display but fully usable on phones. Open source and self-hostable.

**Targets:**
- Android APK (sideloaded onto Supernote A5X + phone)
- iOS app (phone)
- Web dashboard (file upload/management, accessible from any browser)

**Repository name:** `reader`
**License:** AGPL-3.0 (server), MIT (client packages)

---

## 1. Monorepo Structure

```
reader/
├── apps/
│   ├── mobile/                    # React Native (Expo) app
│   │   ├── app/                   # Expo Router file-based routes
│   │   │   ├── (auth)/            # Auth screens (login, register)
│   │   │   ├── (tabs)/            # Main tab navigator
│   │   │   │   ├── library/       # Book library grid/list
│   │   │   │   ├── reading/       # Active reading stats
│   │   │   │   └── settings/      # App settings
│   │   │   └── reader/            # Reader screen (EPUB + PDF)
│   │   │       └── [bookId].tsx
│   │   ├── components/
│   │   │   ├── reader/
│   │   │   │   ├── EpubReader.tsx
│   │   │   │   ├── PdfReader.tsx
│   │   │   │   ├── ReaderControls.tsx
│   │   │   │   ├── ContextMenu.tsx
│   │   │   │   ├── TableOfContents.tsx
│   │   │   │   └── reader-webview/
│   │   │   │       ├── epub.html   # Injected HTML for foliate-js WebView
│   │   │   │       └── pdf.html    # Injected HTML for pdf.js WebView
│   │   │   ├── notes/
│   │   │   │   ├── HandwritingCanvas.tsx  # Skia-based drawing
│   │   │   │   ├── TypedNoteEditor.tsx
│   │   │   │   ├── NotesList.tsx
│   │   │   │   └── PenToolbar.tsx
│   │   │   ├── audio/
│   │   │   │   ├── AudioPlayer.tsx
│   │   │   │   ├── PlaybackControls.tsx
│   │   │   │   └── TTSSettings.tsx
│   │   │   └── ui/                # Shared UI primitives
│   │   ├── contexts/
│   │   │   ├── DisplayContext.tsx  # E-ink mode detection + settings
│   │   │   ├── AuthContext.tsx
│   │   │   └── SyncContext.tsx
│   │   ├── hooks/
│   │   ├── lib/
│   │   │   ├── sync.ts            # Sync engine client
│   │   │   ├── storage.ts         # SQLite + file system helpers
│   │   │   ├── api.ts             # API client (typed)
│   │   │   └── tts.ts             # TTS client (server + on-device)
│   │   ├── app.json
│   │   ├── metro.config.js
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── web/                       # Web dashboard (React + Vite)
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── login.tsx
│   │   │   │   ├── library.tsx
│   │   │   │   ├── upload.tsx
│   │   │   │   ├── book.$bookId.tsx
│   │   │   │   ├── tts-queue.tsx
│   │   │   │   └── settings.tsx
│   │   │   ├── components/
│   │   │   │   ├── BookCard.tsx
│   │   │   │   ├── UploadDropzone.tsx
│   │   │   │   ├── MetadataEditor.tsx
│   │   │   │   └── TTSJobList.tsx
│   │   │   ├── lib/
│   │   │   │   └── api.ts         # Shared API client
│   │   │   ├── main.tsx
│   │   │   └── index.html
│   │   ├── vite.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── server/                    # Backend API (Node.js + Hono)
│       ├── src/
│       │   ├── index.ts           # App entry point
│       │   ├── routes/
│       │   │   ├── auth.ts        # better-auth routes
│       │   │   ├── books.ts       # CRUD + upload/download
│       │   │   ├── progress.ts    # Reading progress
│       │   │   ├── annotations.ts # Bookmarks, highlights, notes
│       │   │   ├── sync.ts        # Sync pull/push endpoints
│       │   │   ├── tts.ts         # TTS job management + audio streaming
│       │   │   └── lookup.ts      # Lookup provider CRUD
│       │   ├── db/
│       │   │   ├── schema.ts      # Drizzle schema (all tables)
│       │   │   ├── migrate.ts     # Migration runner
│       │   │   └── index.ts       # DB client export
│       │   ├── services/
│       │   │   ├── storage.ts     # R2/S3 abstraction (upload, download, presigned URLs)
│       │   │   ├── book-processor.ts  # Metadata extraction, cover gen
│       │   │   ├── tts-queue.ts   # BullMQ job producer
│       │   │   └── sync.ts        # Sync engine server-side logic
│       │   ├── middleware/
│       │   │   ├── auth.ts        # Auth middleware (extract user from session)
│       │   │   └── user-scope.ts  # Enforce user_id on all queries
│       │   └── lib/
│       │       ├── env.ts         # Environment variable validation (zod)
│       │       └── errors.ts      # Error types + handler
│       ├── drizzle.config.ts
│       ├── tsconfig.json
│       └── package.json
│
├── packages/
│   ├── shared/                    # Shared types + constants
│   │   ├── src/
│   │   │   ├── types.ts           # Book, User, Annotation, TTS types
│   │   │   ├── constants.ts       # Highlight colors, default providers, etc.
│   │   │   ├── validators.ts      # Zod schemas for API payloads
│   │   │   └── index.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── sync-engine/               # Lightweight sync logic (isomorphic)
│       ├── src/
│       │   ├── lww.ts             # Last-write-wins merge for progress
│       │   ├── set.ts             # Add/tombstone set merge for annotations
│       │   ├── queue.ts           # Offline change queue
│       │   └── index.ts
│       ├── tsconfig.json
│       └── package.json
│
├── services/
│   └── tts-worker/                # Python TTS inference service
│       ├── worker.py              # Main worker: pulls from Redis queue
│       ├── engines/
│       │   ├── chatterbox_engine.py   # Chatterbox (Turbo + Original)
│       │   ├── kokoro_engine.py       # Kokoro (fast streaming)
│       │   └── base.py                # Engine interface
│       ├── api.py                 # FastAPI server for real-time streaming
│       ├── requirements.txt
│       ├── Dockerfile
│       └── download_models.py     # Script to download model weights on first run
│
├── deploy/
│   ├── docker-compose.yml         # Simple self-host (all-in-one)
│   ├── docker-compose.dev.yml     # Development with hot reload
│   ├── docker-compose.gpu.yml     # Override to add TTS worker with GPU
│   ├── Dockerfile.server          # Node.js API server
│   ├── Dockerfile.web             # Nginx + static web build
│   ├── Dockerfile.tts             # Python TTS worker with CUDA
│   ├── Caddyfile                  # Reverse proxy config
│   ├── .env.example               # All required env vars documented
│   └── helm/
│       └── reader/
│           ├── Chart.yaml
│           ├── values.yaml
│           └── templates/
│               ├── deployment-api.yaml
│               ├── deployment-web.yaml
│               ├── deployment-tts.yaml
│               ├── service.yaml
│               ├── ingress.yaml
│               ├── configmap.yaml
│               └── secrets.yaml
│
├── docs/
│   ├── self-hosting.md
│   ├── api.md                     # Auto-generated from OpenAPI
│   └── contributing.md
│
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── .gitignore
├── .env.example
└── README.md
```

---

## 2. Technology Stack — Exact Packages

### Monorepo
```
pnpm (>=9)
turborepo (latest)
typescript (~5.6)
```

### Mobile App (`apps/mobile`)
```json
{
  "dependencies": {
    "expo": "~52",
    "expo-router": "~4",
    "expo-sqlite": "~15",
    "expo-file-system": "~18",
    "expo-speech": "~13",                          // OS-native TTS (Siri/Google) for on-device fallback
    "react-native": "~0.76",
    "react-native-webview": "^13",
    "@niccolosalvato/react-native-pdf-viewer": "^1",
    "@shopify/react-native-skia": "^1",
    "react-native-track-player": "^4",
    "react-native-inappbrowser-reborn": "^3",
    "react-native-gesture-handler": "~2.20",
    "react-native-reanimated": "~3.16",
    "zustand": "^5",
    "@better-auth/expo": "latest",
    "zod": "^3"
  }
}
```

### Web Dashboard (`apps/web`)
```json
{
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "@tanstack/react-router": "^1",
    "@tanstack/react-query": "^5",
    "tailwindcss": "^4",
    "shadcn": "latest",
    "tus-js-client": "^4",
    "@better-auth/react": "latest",
    "zod": "^3"
  },
  "devDependencies": {
    "vite": "^6",
    "@vitejs/plugin-react": "^4",
    "typescript": "~5.6"
  }
}
```

### Backend API (`apps/server`)
```json
{
  "dependencies": {
    "hono": "^4",
    "@hono/node-server": "^1",
    "better-auth": "latest",
    "drizzle-orm": "^0.39",
    "postgres": "^3",
    "@aws-sdk/client-s3": "^3",
    "@aws-sdk/s3-request-presigner": "^3",
    "bullmq": "^5",
    "ioredis": "^5",
    "epub-metadata": "^3",
    "pdf-parse": "^1",
    "sharp": "^0.33",
    "zod": "^3",
    "@hono/zod-openapi": "^0.18",
    "tus-node-server": "^1"
  },
  "devDependencies": {
    "drizzle-kit": "^0.30",
    "tsx": "^4",
    "typescript": "~5.6"
  }
}
```

### TTS Worker (`services/tts-worker`)
```
# requirements.txt
chatterbox-tts>=0.1
kokoro>=0.9
fastapi>=0.115
uvicorn>=0.34
redis>=5
boto3>=1.35
pydub>=0.25
torch>=2.4
torchaudio>=2.4
```

---

## 3. Environment Variables

```bash
# .env.example

# === Database ===
DATABASE_URL=postgresql://reader:password@localhost:5432/reader

# === Redis ===
REDIS_URL=redis://localhost:6379

# === S3-Compatible Storage (Cloudflare R2) ===
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_BUCKET=reader-files
S3_ACCESS_KEY=<r2-access-key-id>
S3_SECRET_KEY=<r2-secret-access-key>
S3_REGION=auto                           # R2 uses "auto"
S3_FORCE_PATH_STYLE=true                # Required for R2

# === Auth (better-auth) ===
BETTER_AUTH_SECRET=<random-32-char-string>
BETTER_AUTH_URL=http://localhost:3000     # Backend URL (internal)
PUBLIC_URL=http://localhost               # Public-facing URL (Tailscale hostname in prod, e.g. https://my-server.tailnet-abc.ts.net)
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost,http://localhost:8080,exp://localhost:8081

# === TTS Worker ===
TTS_ENABLED=true                          # Set false if no GPU available
TTS_DEFAULT_ENGINE=chatterbox-turbo       # chatterbox | chatterbox-turbo | kokoro
TTS_MODEL_DIR=/models                     # Where model weights are stored
TTS_STREAM_ENGINE=kokoro                  # Engine used for real-time streaming

# === App Config ===
PORT=3000
NODE_ENV=development
LOG_LEVEL=debug
MAX_UPLOAD_SIZE_MB=500
DEFAULT_STORAGE_QUOTA_MB=1024            # 1 GB default for new users, overridable per user in DB
```

---

## 4. Database Schema (Drizzle)

File: `apps/server/src/db/schema.ts`

```typescript
import { pgTable, uuid, text, timestamp, integer, bigint, jsonb, boolean, serial, uniqueIndex, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique().notNull(),
  name: text("name"),
  emailVerified: boolean("email_verified").default(false),
  image: text("image"),
  storageQuotaMb: integer("storage_quota_mb").default(1024),  // 1 GB default, admin can increase per user
  storageUsedMb: integer("storage_used_mb").default(0),       // Tracked on upload/delete
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// better-auth requires these tables — the exact schema depends on
// the better-auth version. Use `npx @better-auth/cli generate` to
// produce the session, account, and verification tables. Merge them
// into this file after generation.

// Content-addressable file storage — deduplicates across all users.
// Multiple books can reference the same file if the content hash matches.
export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  sha256: text("sha256").unique().notNull(),    // SHA-256 hash of file content
  s3Key: text("s3_key").notNull(),              // S3 object key: files/{sha256}.{ext}
  coverKey: text("cover_key"),                  // S3 key: covers/{sha256}.jpg
  size: bigint("size", { mode: "number" }).notNull(),
  format: text("format").notNull(),             // 'epub' | 'pdf'
  refCount: integer("ref_count").default(1),    // Number of books referencing this file
  createdAt: timestamp("created_at").defaultNow(),
});

export const books = pgTable("books", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  fileId: uuid("file_id").references(() => files.id).notNull(),  // Reference to deduplicated file
  title: text("title"),
  author: text("author"),
  language: text("language"),
  totalChapters: integer("total_chapters"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  uploadedAt: timestamp("uploaded_at").defaultNow(),
}, (table) => [
  index("books_user_idx").on(table.userId),
  uniqueIndex("books_user_file_idx").on(table.userId, table.fileId),  // Prevent same user adding same file twice
]);

export const readingProgress = pgTable("reading_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").references(() => books.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  deviceId: text("device_id").notNull(),
  position: jsonb("position").notNull().$type<{
    chapter?: number;
    cfi?: string;          // EPUB CFI string
    page?: number;         // PDF page number
    percentage: number;    // 0-100 overall progress
  }>(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("progress_unique_idx").on(table.bookId, table.userId, table.deviceId),
]);

export const bookmarks = pgTable("bookmarks", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").references(() => books.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  position: jsonb("position").notNull(),
  label: text("label"),
  createdAt: timestamp("created_at").defaultNow(),
  deletedAt: timestamp("deleted_at"),            // Soft delete for CRDT tombstones
});

export const highlights = pgTable("highlights", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").references(() => books.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  cfiRange: text("cfi_range").notNull(),
  textContent: text("text_content"),
  note: text("note"),
  color: text("color").default("yellow"),        // yellow | green | blue | pink | purple
  createdAt: timestamp("created_at").defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").references(() => books.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  position: jsonb("position").notNull(),
  noteType: text("note_type").notNull(),          // 'typed' | 'handwritten'
  textContent: text("text_content"),              // For typed notes
  strokes: jsonb("strokes").$type<{
    points: { x: number; y: number; pressure: number }[];
    color: string;
    width: number;
  }[]>(),
  penConfig: jsonb("pen_config").$type<{ color: string; width: number }>(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export const lookupProviders = pgTable("lookup_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  icon: text("icon"),                             // Emoji or icon key
  urlTemplate: text("url_template").notNull(),    // Must contain {{query}}
  enabled: boolean("enabled").default(true),
  sortOrder: integer("sort_order").default(0),
  isBuiltin: boolean("is_builtin").default(false),
});

export const ttsJobs = pgTable("tts_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").references(() => books.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status: text("status").notNull().default("queued"), // queued | processing | done | failed
  engine: text("engine").default("chatterbox-turbo"),
  chaptersTotal: integer("chapters_total"),
  chaptersDone: integer("chapters_done").default(0),
  voiceConfig: jsonb("voice_config").$type<{
    voiceId?: string;
    exaggeration?: number;    // 0-1, Chatterbox emotion control
    speed?: number;           // 0.5-2.0
  }>(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const ttsAudioChunks = pgTable("tts_audio_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => ttsJobs.id, { onDelete: "cascade" }).notNull(),
  chapterIndex: integer("chapter_index").notNull(),
  audioKey: text("audio_key").notNull(),          // S3 key
  durationMs: integer("duration_ms"),
  format: text("format").default("opus"),
});

export const syncLog = pgTable("sync_log", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  entityType: text("entity_type").notNull(),      // bookmark | highlight | note | progress
  entityId: uuid("entity_id").notNull(),
  operation: text("operation").notNull(),          // create | update | delete
  payload: jsonb("payload"),
  deviceId: text("device_id"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
}, (table) => [
  index("sync_log_user_ts_idx").on(table.userId, table.timestamp),
]);
```

---

## 5. API Routes

All routes require authentication except `/auth/*`. All data access is scoped to the authenticated user.

**Security:** R2 is not publicly accessible by default. File access uses short-lived presigned URLs (15 min expiry) generated by the backend after verifying authentication and user ownership. Presigned URLs point directly to R2's endpoint — no proxying needed.

### Auth
```
POST   /api/auth/sign-up             # Email + password registration
POST   /api/auth/sign-in/email       # Email + password login
POST   /api/auth/sign-out            # Logout
GET    /api/auth/session              # Get current session
POST   /api/auth/forget-password     # Password reset
```
*Routes are handled by better-auth. Mount via `app.on(["POST", "GET"], "/api/auth/**", (c) => auth.handler(c.req.raw))`.*

### Books
```
GET    /api/books                     # List user's books
       Query: ?sort=recent|title|author&search=<term>
       Response: { books: Book[] }

POST   /api/books                     # Upload new book
       Body: multipart/form-data { file: File }
       Response: { book: Book }
       Notes: Accept .epub and .pdf. Max 500MB.
              After upload, queue background job for metadata extraction.

GET    /api/books/:id                 # Get book metadata + presigned download URL
       Response: { book: Book, downloadUrl: string }
       Notes: downloadUrl is a 15-min presigned S3 URL.

DELETE /api/books/:id                 # Delete book + all associated data + S3 files (if refCount=0)

PATCH  /api/books/:id/metadata        # Update title, author, tags
       Body: { title?: string, author?: string, metadata?: object }
```

### Reading Progress
```
GET    /api/books/:id/progress        # Get all device positions for this book
       Response: { positions: ReadingProgress[] }

PUT    /api/books/:id/progress        # Upsert reading position for current device
       Body: { deviceId: string, position: { chapter?, cfi?, page?, percentage } }
```

### Annotations (Bookmarks, Highlights, Notes)
```
GET    /api/books/:id/annotations     # All annotations for a book
       Query: ?type=bookmark|highlight|note
       Response: { bookmarks: Bookmark[], highlights: Highlight[], notes: Note[] }

POST   /api/books/:id/bookmarks       # Create bookmark
POST   /api/books/:id/highlights      # Create highlight
POST   /api/books/:id/notes           # Create note (typed or handwritten)
       Body for handwritten: { position, noteType: "handwritten", strokes: [...], penConfig }

PATCH  /api/annotations/:id           # Update any annotation
DELETE /api/annotations/:id           # Soft delete (sets deletedAt)
```

### Sync
```
GET    /api/sync/changes              # Pull changes since last sync
       Query: ?since=<ISO timestamp>&deviceId=<string>
       Response: { changes: SyncLogEntry[], serverTimestamp: string }

POST   /api/sync/push                 # Push local changes
       Body: { changes: SyncLogEntry[] }
       Response: { accepted: number, conflicts: SyncConflict[] }
       Notes: Server applies LWW for progress, CRDT merge for annotations.
```

### TTS
```
GET    /api/tts/status                 # TTS service availability
       Response: {
         available: boolean,            // true if TTS worker is reachable
         engines: string[],             // e.g. ["chatterbox", "chatterbox-turbo", "kokoro"]
         streamingAvailable: boolean,   // true if Kokoro streaming endpoint is reachable
         queueDepth: number             // Number of pending jobs in the queue
       }
       Notes: API server checks by pinging the TTS worker health endpoint
              and inspecting the BullMQ queue. Clients use this to decide
              whether to show server TTS UI or default to expo-speech.

POST   /api/tts/generate              # Queue TTS generation for a book
       Body: { bookId, engine?: string, voiceConfig?: object }
       Response: { job: TTSJob }

GET    /api/tts/jobs                   # List user's TTS jobs
       Response: { jobs: TTSJob[] }

GET    /api/tts/jobs/:id              # Job status + progress
       Response: { job: TTSJob, chunks: TTSAudioChunk[] }

DELETE /api/tts/jobs/:id              # Cancel job + delete generated audio

GET    /api/tts/audio/:bookId/:chapter  # Get presigned URL for chapter audio
       Response: { url: string } (15-min presigned S3 URL, or 404 if not yet generated)

POST   /api/tts/stream                # Real-time TTS (Kokoro)
       Body: { text: string, voiceConfig?: object }
       Response: chunked audio/opus stream
       Notes: Uses Kokoro for low-latency. For when pre-gen isn't available.
```

### Lookup Providers
```
GET    /api/lookup-providers          # List user's providers
POST   /api/lookup-providers          # Add custom provider
PATCH  /api/lookup-providers/:id      # Update (reorder, enable/disable)
DELETE /api/lookup-providers/:id      # Delete (only non-builtin)
POST   /api/lookup-providers/reset    # Reset to defaults
```

---

## 6. Mobile App — Key Implementation Details

### Server Connection

The mobile app needs an explicit server URL since it's not served from the same origin as the backend.

- **Login screen** includes a "Server URL" text field (e.g., `https://my-server.tailnet-abc.ts.net`). Stored in `expo-secure-store` and persisted across app restarts.
- All API calls prefix this URL: `${serverUrl}/api/books`, `${serverUrl}/api/sync/changes`, etc.
- `@better-auth/expo` is initialized with the same `serverUrl` as its `baseURL`.
- Presigned R2 URLs returned by the API point directly to Cloudflare — the mobile app fetches them over the public internet, no Tailscale needed for downloads.
- If the server is unreachable, the app works in offline mode (local SQLite data, queued sync changes).

### E-Ink Optimization (Supernote Mode)

The Supernote A5X is a 10.3" e-ink Android tablet. E-ink constraints: slow refresh (~300ms full, ~120ms partial), no color, ghosting.

**`DisplayContext.tsx`** — provides `isEink` boolean and display settings:
```typescript
interface DisplaySettings {
  isEink: boolean;
  animationsEnabled: boolean;
  highContrast: boolean;
  minTapTarget: number;           // 48dp phone, 64dp e-ink
  scrollMode: "smooth" | "paginated";
  refreshMode: "normal" | "a2";   // A2 = fastest 1-bit partial refresh
}
```

**Detection:** Check `NativeModules.PlatformConstants.Brand` / `Model` for "Ratta" (Supernote manufacturer), or let users toggle in settings. Default to auto-detect.

**When `isEink` is true:**
- Disable ALL animations (`LayoutAnimation` and `Animated` durations → 0)
- Force pure black on white palette (no grays for text, no color)
- Use A2 refresh mode hints where Android exposes them
- Larger tap targets (48dp → 64dp minimum)
- Pagination-only scrolling (full page turns, no smooth scroll)
- Minimal UI chrome — maximize reading area
- Debounce rapid taps (300ms) since e-ink can't keep up

### EPUB Reader

Render EPUBs in a `WebView` using **foliate-js** (actively maintained epub.js alternative):

1. Bundle `epub-webview/index.html` with foliate-js loaded from local assets
2. Load the EPUB file from local filesystem into the WebView
3. Communicate between RN ↔ WebView via `postMessage` / `onMessage`:
   - RN → WebView: `{ type: "setTheme", payload: { fontSize: 18, bg: "#fff" } }`
   - RN → WebView: `{ type: "goToChapter", payload: { cfi: "..." } }`
   - WebView → RN: `{ type: "selectionChanged", payload: { text, cfi, rect } }`
   - WebView → RN: `{ type: "progressUpdated", payload: { cfi, percentage } }`
   - WebView → RN: `{ type: "tocLoaded", payload: { chapters: [...] } }`
4. Pagination via CSS multi-column layout (works well for e-ink page turns)
5. Theme injection via CSS custom properties

### PDF Reader

Render PDFs in a `WebView` using **pdf.js** — unified WebView approach with EPUB:
- Same `postMessage` bridge pattern as EPUB reader
- Full control over rendering for e-ink optimization (A2 refresh hints, no native scroll conflicts)
- Consistent text selection and context menu behavior across both formats

Features: zoom, margin cropping, horizontal/vertical scroll, night mode (CSS filter).

### Text Selection Context Menu

When text is selected in the reader:

1. **EPUB:** WebView fires `selectionchange` → `postMessage` to RN with `{ text, cfi, rect }`
2. **PDF:** WebView fires `selectionchange` → same `postMessage` bridge as EPUB
3. RN renders a native `<ContextMenu>` component near the selection

**Context menu actions:**
- 🖍 Highlight (opens color picker: yellow, green, blue, pink, purple)
- 🔖 Bookmark
- 📝 Note (opens note editor — handwriting or keyboard)
- 📋 Copy
- 🔍 Look Up → submenu of configured providers

**E-ink mode:** Menu appears below selection (not floating), larger tap targets, instant show/hide (no animation).

**Highlight rendering on e-ink** (no color available):
- Yellow → solid underline
- Green → dashed underline
- Blue → double underline
- Pink → dotted underline
- Purple → wavy underline

**Lookup providers** — stored in user settings, synced across devices:
```typescript
interface LookupProvider {
  id: string;
  name: string;
  icon: string;
  urlTemplate: string;   // e.g. "https://en.wikipedia.org/wiki/Special:Search?search={{query}}"
  enabled: boolean;
  order: number;
}
```
Default providers: Google, Wikipedia, Translate, Dictionary.
Users can add custom providers with any URL containing `{{query}}`.
Lookups open in an in-app WebView modal (via `react-native-inappbrowser-reborn`).

### Handwritten Notes

For the Supernote A5X stylus and other stylus-equipped devices.

**Input mode detection:**
- E-ink + stylus detected → canvas first (no keyboard)
- Phone without stylus → keyboard first
- Any device → toggle button (✏️ ↔ ⌨️) to switch

**Canvas:** `@shopify/react-native-skia`
- Draw with `<Canvas>` + `<Path>` elements
- Track `{ x, y, pressure }` per point per stroke
- Pen toolbar: 2-3 sizes, color picker, eraser
- On e-ink: draw strokes via A2 partial refresh for real-time ink, full refresh on canvas close

**Storage format:**
```typescript
interface HandwrittenNote {
  id: string;
  bookId: string;
  position: BookPosition;
  strokes: Stroke[];
  penConfig: { color: string; width: number };
  createdAt: Date;
  updatedAt: Date;
}

interface Stroke {
  points: { x: number; y: number; pressure: number }[];
  color: string;
  width: number;
}
```
Stroke data is compact (2-10KB per note). Synced via CRDT pipeline. Preview thumbnails regenerated client-side from stroke data.

**Note list display:** Shows thumbnail previews of handwritten notes alongside typed notes. Tap to open full canvas for editing.

### Audio Player

Use **react-native-track-player** for background audio:
- Chapter-by-chapter playback from presigned S3 URLs (fetched via `/api/tts/audio/:bookId/:chapter`)
- Playback speed control (0.5x–3x)
- Sleep timer (15m, 30m, 45m, 1h, end of chapter)
- Lock screen controls (play/pause, skip chapter)
- "Read from here" button: starts TTS at current reading position
- Position sync: listening position updates reading position and vice versa
- Quality indicator: "HD" (Chatterbox server) vs "Device" (expo-speech on-device)

### Offline & Storage

- **SQLite** (`expo-sqlite`) for: book metadata cache, reading positions, bookmarks, highlights, notes (including stroke data), offline sync queue
- **File system** (`expo-file-system`) for: cached book files (EPUB/PDF), downloaded audio files
- On launch: check connectivity → if online, run sync → pull remote changes, push local queue
- Books download fully on first open for offline reading

---

## 7. Web Dashboard — Key Implementation Details

React SPA for managing library from any browser. Initially metadata/management only; web-based reader planned for Phase 6.

**Stack:** React 19 + Vite + TanStack Router + TanStack Query + Tailwind CSS + shadcn/ui

### Pages

1. **Login/Register** — better-auth integration with `@better-auth/react`
2. **Library** — Grid/list toggle of all books. Shows cover, title, author, reading progress bar, format badge
3. **Upload** — Drag-and-drop zone using `tus-js-client` for resumable chunked uploads. Shows progress bar. Accepts .epub and .pdf
4. **Book Detail** — Metadata display + edit (title, author, tags, cover). Reading progress per device. Annotations list. TTS status.
5. **TTS Queue** — List of all TTS jobs with status (queued/processing/done/failed), progress bar per book, engine info, playback preview
6. **Settings** — Account, connected devices, storage usage, lookup providers, TTS defaults

### Deployment

The web dashboard is a static Vite build. In Docker, it's served by Nginx in its own container. Caddy routes `/` to it. All API calls use relative URLs (`/api/...`) so no build-time API URL config is needed — same-origin via Caddy.

---

## 8. Backend — Key Implementation Details

### Auth Setup (better-auth)

```typescript
// apps/server/src/routes/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  trustedOrigins: process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",") ?? [],
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 min — reduces DB queries for session validation
    },
  },
  // Add OAuth later: Google, GitHub
});
```

Generate the required auth tables: `npx @better-auth/cli generate --config apps/server/src/routes/auth.ts`

### User-Scoped Data Access

Every query that touches user data MUST be scoped. The auth middleware extracts `userId` from the session and puts it on the Hono context. All route handlers use `c.get("userId")`.

Implement per-table scoping helpers:
```typescript
// apps/server/src/middleware/user-scope.ts
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";

// Each table that has a userId column gets a scoping helper
export const scopeToUser = {
  books: (qb: any, userId: string) => qb.where(eq(schema.books.userId, userId)),
  bookmarks: (qb: any, userId: string) => qb.where(eq(schema.bookmarks.userId, userId)),
  highlights: (qb: any, userId: string) => qb.where(eq(schema.highlights.userId, userId)),
  notes: (qb: any, userId: string) => qb.where(eq(schema.notes.userId, userId)),
  readingProgress: (qb: any, userId: string) => qb.where(eq(schema.readingProgress.userId, userId)),
  ttsJobs: (qb: any, userId: string) => qb.where(eq(schema.ttsJobs.userId, userId)),
  lookupProviders: (qb: any, userId: string) => qb.where(eq(schema.lookupProviders.userId, userId)),
} as const;

// Usage: scopeToUser.books(db.select().from(schema.books), userId)
```

### File Upload Flow (Content-Addressable Deduplication)

1. Client uploads file via `POST /api/books` (multipart) or via tus protocol for large files
2. Server computes SHA-256 hash of the uploaded file while streaming
3. **Dedup check:** Query `files` table for matching `sha256`
   - **Hit:** Increment `refCount`, skip S3 upload, create `books` row referencing existing `files` row
   - **Miss:** Upload to R2 at `files/{sha256}.{ext}`, create `files` row, then create `books` row
4. Check user's `storageQuotaMb` — reject upload if `storageUsedMb + fileSizeMb > storageQuotaMb`
   (deduped files still count toward the uploading user's quota)
5. Server extracts metadata (title, author, cover, language, chapter list):
   - EPUB: use `epub-metadata` npm package + custom parsing for TOC
   - PDF: use `pdf-parse` for metadata, `sharp` for cover from first page
6. Server generates cover thumbnail (300px wide) and uploads to R2 at `covers/{sha256}.jpg` (also deduped)
7. Server stores metadata in Postgres, updates user's `storageUsedMb`
8. If TTS auto-generation is enabled, queue a BullMQ job

**On book delete:** Decrement `files.refCount`. Only delete the R2 object when `refCount` reaches 0. Update user's `storageUsedMb` accordingly.

### Sync Engine (Server Side)

**Pull:** `GET /api/sync/changes?since=<timestamp>`
- Query `sync_log` for all entries where `user_id = currentUser AND timestamp > since`
- Return changes + current server timestamp

**Push:** `POST /api/sync/push`
- For each change in the payload:
  - **progress:** LWW — accept if `change.timestamp > existing.updatedAt`, otherwise discard
  - **bookmark/highlight/note:** CRDT set — apply create/delete. Conflicts are impossible with tombstone-based sets (add wins, delete is permanent via `deletedAt`)
- Write accepted changes to the actual tables AND to `sync_log`
- Return `{ accepted, conflicts }`

### BullMQ Job Queue

```typescript
// apps/server/src/services/tts-queue.ts
import { Queue } from "bullmq";
import { redis } from "../lib/redis";

export const ttsQueue = new Queue("tts", { connection: redis });

export async function queueTTSJob(bookId: string, userId: string, config: TTSConfig) {
  // Extract chapter texts from the book file (EPUB chapters or PDF pages)
  const chapters = await extractChapters(bookId);

  const job = await db.insert(ttsJobs).values({
    bookId, userId,
    status: "queued",
    engine: config.engine ?? "chatterbox-turbo",
    chaptersTotal: chapters.length,
    voiceConfig: config.voiceConfig,
  }).returning();

  // Add one sub-job per chapter for granular progress
  for (const [i, chapter] of chapters.entries()) {
    await ttsQueue.add("generate-chapter", {
      jobId: job[0].id,
      bookId,
      userId,
      chapterIndex: i,
      text: chapter.text,
      engine: config.engine ?? "chatterbox-turbo",
      voiceConfig: config.voiceConfig,
    });
  }

  return job[0];
}
```

---

## 9. TTS Pipeline

### Architecture
```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  API Server  │────▶│  BullMQ     │────▶│  TTS Worker  │────▶│ Cloudflare R2│
│  (Node.js)   │     │  (Redis)    │     │  (Python/GPU) │     │   (audio)    │
└─────────────┘     └─────────────┘     └──────────────┘     └──────────────┘
```

### Model Tiers

| Tier | Engine | Params | Use Case | Latency | Quality |
|------|--------|--------|----------|---------|---------|
| HD (server) | Chatterbox Original | 0.5B | Pre-generated audiobook narration | ~2-5s/sentence | ★★★★★ |
| Fast (server) | Chatterbox Turbo | 350M | Pre-gen when speed > quality | ~1-2s/sentence | ★★★★ |
| Stream (server) | Kokoro | 82M | Real-time playback, pre-gen not ready | <0.3s/sentence | ★★★ |
| Offline (device) | expo-speech (OS-native) | 0 (OS-provided) | No server connection | real-time CPU | ★★–★★★★ (varies by device/voice) |

### TTS Worker (`services/tts-worker/worker.py`)

Python service that:
1. Connects to Redis and listens for jobs from the `tts` queue
2. Loads the appropriate engine (Chatterbox or Kokoro) based on job config
3. Processes text chapter-by-chapter, sentence-by-sentence
4. Generates audio (24kHz WAV → encoded to Opus at 64kbps)
5. Uploads to R2 at `{userId}/tts/{bookId}/{chapterIndex}.opus`
6. Updates job progress in Postgres via a callback URL or direct DB connection

### Streaming Endpoint (`services/tts-worker/api.py`)

FastAPI server that provides real-time TTS and health checks:
```
GET  /health
     Response: { status: "ok", engines: ["chatterbox", "chatterbox-turbo", "kokoro"], gpu: true }
     Notes: Returns loaded engines and GPU availability. The API server
            pings this endpoint to populate /api/tts/status.

POST /tts/stream
     Body: { text: string, voice_config: object }
     Response: chunked audio/opus
```
Uses Kokoro for lowest latency. Streams audio chunks as they're generated.

### Model Download

`services/tts-worker/download_models.py` — run on first startup:
- Downloads Chatterbox weights from HuggingFace
- Downloads Kokoro weights from HuggingFace
- Stores in `TTS_MODEL_DIR` (default `/models`, mounted as a Docker volume)
- Skips if already present

Self-hosters without a GPU simply don't run the TTS worker. `GET /api/tts/status` returns `{ available: false }` when the worker's `/health` endpoint is unreachable. Clients check this on launch and fall back to on-device `expo-speech` (OS-native TTS).

---

## 10. Infrastructure & Deployment

### Docker Compose — Simple Self-Host

```yaml
# deploy/docker-compose.yml
services:
  api:
    build:
      context: .
      dockerfile: deploy/Dockerfile.server
    ports: ["3000:3000"]
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started

  web:
    build:
      context: .
      dockerfile: deploy/Dockerfile.web
    ports: ["8080:80"]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: reader
      POSTGRES_PASSWORD: password
      POSTGRES_DB: reader
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U reader"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data

  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config

volumes:
  pgdata:
  redisdata:
  caddy_data:
  caddy_config:
```

```yaml
# deploy/docker-compose.gpu.yml (overlay for TTS worker)
services:
  tts-worker:
    build:
      context: .
      dockerfile: deploy/Dockerfile.tts
    env_file: .env
    volumes:
      - tts-models:/models
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    depends_on:
      - redis

volumes:
  tts-models:
```

Usage:
- With GPU TTS: `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d`
- Without GPU: `docker compose up -d` (skips TTS worker, clients use on-device expo-speech)

### Caddyfile
```
{$DOMAIN:localhost} {
  handle /api/* {
    reverse_proxy api:3000
  }
  handle {
    reverse_proxy web:8080
  }
}
```

### Helm Chart

Provide in `deploy/helm/reader/`. Key values:

```yaml
# values.yaml
replicaCount:
  api: 2                  # No sticky sessions needed — sessions are in Postgres
  web: 2
  ttsWorker: 1

# IMPORTANT: BETTER_AUTH_SECRET must be identical across all API replicas.
# Set via K8s Secret, injected into all API pods.

image:
  api: ghcr.io/yourname/reader-server:latest
  web: ghcr.io/yourname/reader-web:latest
  tts: ghcr.io/yourname/reader-tts:latest

postgresql:
  enabled: true           # Uses CloudNativePG or Bitnami subchart
  auth:
    database: reader

redis:
  enabled: true           # Bitnami Redis subchart

r2:
  endpoint: ""            # Cloudflare R2 endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  bucket: reader-files
  region: auto

tts:
  enabled: true
  gpu:
    enabled: true
    type: nvidia.com/gpu
    count: 1
  modelStorage: 10Gi      # PVC for model weights

ingress:
  enabled: true
  className: nginx
  host: reader.example.com
  tls: true
  # Ingress rules: /api/* → api service, /* → web service
```

### Client Connectivity

How the mobile app and web dashboard connect to the deployed backend:

**Networking:** Use [Tailscale](https://tailscale.com) to expose the server to your devices over a private mesh VPN. Install Tailscale on the server machine and on each client device (phone, Supernote, laptop). The server gets a stable hostname like `my-server.tailnet-abc.ts.net`. Enable HTTPS certs via `tailscale cert`. No ports exposed to the public internet, no router config needed. Free for personal use.

**Web dashboard** — same-origin, no extra config needed.
- Caddy serves the static web build on `/` and proxies `/api/*` to the backend. The web `api.ts` client uses relative URLs (`/api/books`, `/api/sync/changes`, etc.) — no CORS, no separate API URL.
- In development, Vite's `server.proxy` forwards `/api` to `localhost:3000`.

```typescript
// apps/web/vite.config.ts (dev proxy)
export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
```

**Mobile app** — configurable server URL.
- The login screen includes a "Server URL" field (e.g., `https://my-server.tailnet-abc.ts.net`). Stored in `expo-secure-store`.
- All API calls prefix this URL: `${serverUrl}/api/books`, `${serverUrl}/api/sync/changes`, etc.
- `@better-auth/expo` is initialized with the same `serverUrl` as its `baseURL`.
- Presigned R2 URLs point directly to Cloudflare's R2 endpoint — clients fetch them without going through the server or Tailscale.

```typescript
// apps/mobile/lib/api.ts
import * as SecureStore from "expo-secure-store";

const getServerUrl = () => SecureStore.getItemAsync("serverUrl");

export async function apiFetch(path: string, init?: RequestInit) {
  const serverUrl = await getServerUrl();
  if (!serverUrl) throw new Error("Server URL not configured");
  return fetch(`${serverUrl}${path}`, {
    ...init,
    credentials: "include", // Send session cookie
  });
}
```

**Presigned URL generation** — the server uses `S3_ENDPOINT` (Cloudflare R2) to generate presigned URLs. Since R2 endpoints are publicly routable, clients can fetch them directly — no proxy layer needed:

```typescript
// apps/server/src/services/storage.ts
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,      // https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  region: process.env.S3_REGION,          // "auto"
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
});

export async function getPresignedDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }), { expiresIn: 900 }); // 15 min
}
```

**Network topology summary:**
```
┌───────────────────────────────────────────────────────────┐
│  Client (browser / mobile app)                            │
│  Tailscale: https://my-server.tailnet-abc.ts.net          │
│    /api/*  → API calls (via Tailscale → Caddy → API)      │
│    /*      → Web dashboard (via Tailscale → Caddy → Nginx) │
│                                                           │
│  R2 presigned URLs → direct to Cloudflare (public internet)│
└──────────────────┬────────────────────┬───────────────────┘
                   │ Tailscale VPN      │ Public HTTPS
┌──────────────────▼──────────────┐  ┌──▼──────────────────┐
│  Caddy (reverse proxy)          │  │  Cloudflare R2      │
│    /api/*  → api:3000           │  │  (object storage)   │
│    /*      → web:8080           │  └─────────────────────┘
└──────────────┬──────────┬───────┘
         ┌─────▼──┐  ┌───▼────┐
         │ API    │  │  Web   │
         │ :3000  │  │ :8080  │
         └────────┘  └────────┘
```

---

## 11. Development Phases

### Phase 1 — Foundation (Weeks 1–3)
**Goal: Upload an EPUB via web, read it on the mobile app**

1. Initialize monorepo: `pnpm init`, `pnpm-workspace.yaml`, `turbo.json`
2. Create `packages/shared` with TypeScript types and Zod validators
3. Set up `apps/server`:
   - Hono app with health check route
   - Drizzle + Postgres connection, schema file, migrations
   - better-auth setup (email/password)
   - S3 client (R2 compatible) — single client using `S3_ENDPOINT` for both uploads and presigned URLs
   - Book upload endpoint (multipart → S3 + metadata extraction)
   - Book list, get, delete endpoints
   - Book download via presigned URLs (15-min expiry, S3 not publicly exposed)
4. Set up `apps/web`:
   - Vite + React + TanStack Router + TanStack Query
   - Tailwind + shadcn/ui
   - Vite dev proxy: `/api` → `localhost:3000` (see Section 10, Client Connectivity)
   - Login/register pages (better-auth React client)
   - API client using relative URLs (`/api/...`) — no build-time config needed
   - Library page (book grid with covers)
   - Upload page (drag-and-drop with tus-js-client)
5. Set up `apps/mobile`:
   - Expo project with Expo Router
   - Auth screens with "Server URL" field (stored in expo-secure-store)
   - API client prefixing all calls with the configured server URL
   - Library tab (fetch books from API, display grid)
   - Book download to device storage
   - Basic EPUB reader (foliate-js in WebView)
6. Create `deploy/docker-compose.dev.yml` for local development

### Phase 2 — Reader Polish (Weeks 4–6)
**Goal: A pleasant reading experience with annotations**

1. EPUB reader enhancements:
   - Theme engine (font size, family, line height, margins, background color)
   - CSS injection via postMessage bridge
   - Pagination (CSS multi-column)
   - Table of contents overlay
   - In-book search
2. PDF reader: pdf.js in WebView (same bridge pattern as EPUB) with zoom, scroll modes, night mode
3. E-ink mode:
   - `DisplayContext` with auto-detection (Ratta/Supernote)
   - Disable animations, force high contrast, larger tap targets
   - Paginated-only navigation
4. Text selection context menu:
   - WebView `selectionchange` → `postMessage` → native `<ContextMenu>`
   - Highlight (color picker), bookmark, copy, note, look up
   - Configurable lookup providers with `{{query}}` URL templates
   - In-app browser for lookups
   - E-ink highlight rendering (underline styles instead of colors)
5. Notes:
   - Typed note editor (TextInput with save)
   - Handwriting canvas (`@shopify/react-native-skia`)
   - Input mode detection (stylus → canvas, no stylus → keyboard)
   - Pen toolbar (size, color, eraser, mode toggle)
   - Stroke storage as vector paths
   - Note list with handwriting thumbnails
6. Reading progress: track position in SQLite, persist on page change
7. Bookmarks: create/list/delete, navigate to position

### Phase 3 — Sync (Weeks 7–8)
**Goal: Seamless cross-device experience**

1. Server sync endpoints (`/api/sync/changes`, `/api/sync/push`)
2. `packages/sync-engine` (lightweight, no external CRDT library):
   - LWW merge for reading progress (timestamp comparison)
   - Add/tombstone set merge for bookmarks, highlights, notes
   - Offline change queue (SQLite-backed)
3. Mobile sync integration:
   - On app open: pull changes since last sync timestamp
   - On data change: add to local queue + push if online
   - On reconnect: flush queue
   - Sync handwritten note stroke data (compact, 2-10KB)
   - Regenerate handwriting thumbnails client-side after sync
4. Lookup provider settings sync
5. Test: make highlight on phone, see it on Supernote after sync

### Phase 4a — TTS: Pre-Generated Audio (Weeks 9–10)
**Goal: Queue a book for TTS, listen to the result**

1. `services/tts-worker`:
   - Python service with Redis queue consumer
   - Chatterbox engine (Turbo + Original) integration
   - `download_models.py` for first-run setup
   - Chapter processing: text → audio → S3 upload
   - Progress reporting back to Postgres
2. Server TTS routes:
   - Job CRUD, audio streaming from S3
   - BullMQ producer integration
3. Mobile audio player:
   - `react-native-track-player` setup
   - Chapter-by-chapter playback from presigned S3 URLs
   - Playback speed, sleep timer, chapter navigation
   - Lock screen controls
   - Chatterbox emotion/exaggeration controls exposed in UI
4. Web dashboard: TTS queue page (job status, progress, playback preview)

### Phase 4b — TTS: Streaming & On-Device Fallback (Weeks 11–12)
**Goal: Real-time TTS and offline listening**

1. Kokoro streaming engine in `services/tts-worker`:
   - FastAPI server for real-time streaming (`api.py`)
   - Server-side `/api/tts/stream` proxying to Kokoro
2. "Read from here" button: starts streaming TTS at current reading position
3. On-device fallback: `expo-speech` (OS-native TTS — Siri voices on iOS, Google TTS on Android)
   - Zero bundle size cost, works in Expo managed workflow
   - Prompt users to download Enhanced/Premium voices in device Settings for better quality
   - Handle iOS Silent Mode quirk via `expo-av` workaround
4. Position sync between reading position and playback position
5. UI: quality tier indicator ("HD" / "Standard" / "Streaming")

### Phase 5 — Production Hardening (Weeks 13–14)
**Goal: Ready for self-hosters and open source release**

1. Docker: production `docker-compose.yml`, GPU overlay, Dockerfiles
2. Helm chart with all templates and documented values
3. CI/CD: GitHub Actions
   - Build + test on PR
   - Build Docker images on release tag
   - Push to GHCR
   - Build mobile APK (EAS Build)
4. Security: rate limiting (Hono middleware — per-user upload limit: max 5 concurrent uploads, 20/hour), input validation (Zod on all endpoints), CORS config
5. Operational: health checks, structured logging (pino), storage quotas per user
6. Documentation: `self-hosting.md`, API docs (OpenAPI auto-generated), `contributing.md`, `README.md`

### Phase 6 — Nice-to-Haves (Ongoing)
- Web-based reader (EPUB + PDF in browser, using same foliate-js/pdf.js as mobile WebView)
- Export annotations (highlights + notes) as Markdown/PDF
- Collections / shelves / tags
- Reading stats & streaks
- OPDS catalog support (import from Calibre)
- Book format conversion (server-side via Calibre CLI)
- Social features (share highlights, reading lists)
- iOS build + TestFlight

---

## 12. Key Technical Decisions Summary

| Decision | Choice | Rationale |
|---|---|---|
| Mobile framework | React Native + Expo (~52) | Cross-platform, Expo for build infra, dev client for native modules |
| Backend framework | Hono (Node.js) | Fast, lightweight, TS-native, good DX, OpenAPI support |
| Auth | better-auth | TS-native, self-hostable, supports RN + web, email + OAuth |
| Database | PostgreSQL 16 + Drizzle ORM | Reliable, JSONB for flexible data, Drizzle is fully type-safe |
| Object storage | Cloudflare R2 (S3-compatible) | Free egress, S3 API, presigned URLs work from any network |
| Job queue | BullMQ + Redis | Battle-tested, progress tracking, concurrency control, Bull Board for monitoring |
| TTS (high quality) | Chatterbox Original (0.5B) | Best open-source quality, MIT license, emotion control, 23 langs |
| TTS (fast server) | Chatterbox Turbo (350M) | Same family, distilled decoder (10→1 step), lower VRAM |
| TTS (streaming) | Kokoro (82M) | Sub-0.3s latency, Apache 2.0, perfect for real-time fallback |
| TTS (on-device) | expo-speech (OS-native) | Zero bundle cost, Siri/Google voices, works in Expo managed workflow |
| EPUB rendering | foliate-js in WebView | Actively maintained, full CSS control, pagination, CFI positioning |
| PDF rendering | pdf.js in WebView | Unified WebView approach with EPUB, consistent e-ink control and text selection |
| Drawing canvas | @shopify/react-native-skia | GPU-accelerated, pressure-sensitive, works on e-ink |
| Sync strategy | LWW (progress) + add/tombstone sets (annotations) | Simple custom implementation, no heavy CRDT library needed |
| Monorepo | Turborepo + pnpm | Fast caching, task parallelism, proven with RN |
| Networking | Tailscale | Private mesh VPN, no public exposure, free for personal use |
| Self-host (simple) | Docker Compose + Caddy | One command, auto HTTPS |
| Self-host (scale) | Helm chart | K8s standard, GPU scheduling for TTS |

---

## 13. Open Source Considerations

- **License:** AGPL-3.0 for server code (modifications must be shared). MIT for client packages and shared code.
- **Repo:** Single monorepo on GitHub under `reader/`
- **Releases:** Use GitHub Releases. Tag format: `v0.1.0`. Publish Docker images to GHCR on tag.
- **Model weights:** Never bundle in Docker images. `download_models.py` fetches on first run. Document model licenses separately.
- **CI:** GitHub Actions for build, test, lint. EAS Build for Android APK on release.
- **Community:** GitHub Discussions (support), Issues (bugs), PR templates, contributing guide.
