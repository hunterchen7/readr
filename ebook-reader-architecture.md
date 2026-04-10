# Readr -- Architecture Document

> This document is the source of truth for the Readr e-book reader project.
> It describes what actually exists in the codebase as of the date below.
> Planned-but-not-yet-implemented features are called out in a dedicated
> section at the bottom.
>
> **Last updated:** 2026-04-10

---

## 1. Project Overview

Readr is a cross-platform e-book reader with cloud sync, a web dashboard for
file management, and optional AI-powered text-to-speech. The mobile reader is
built for the Supernote A5X e-ink display but works on any Android/iOS phone.

**Targets:**

- Android APK (sideloaded onto Supernote A5X, or any Android phone)
- iOS app (phone/tablet)
- Web dashboard (file upload, library management, reader)

**Repository name:** `readr`
**License:** AGPL-3.0 (server), MIT (client packages)

---

## 2. Monorepo Structure

```
readr/
  apps/
    mobile/          React Native (Expo SDK 54, expo-router)
    web/             React + Vite + TanStack Router/Query + Tailwind v4
    server/          Hono API on Node.js
  packages/
    shared/          Shared types, constants, Zod validators
    sync-engine/     Isomorphic LWW merge, set merge, queue dedup
  services/
    tts-worker/      Python FastAPI + BullMQ Redis queue worker
  deploy/
    docker-compose.yml       Full production stack
    docker-compose.dev.yml   Infrastructure only (Postgres, Redis, MinIO)
    docker-compose.gpu.yml   TTS worker with GPU passthrough
    Dockerfile.server        API server container
    Dockerfile.web           Web client (Vite build -> nginx)
    Caddyfile                Optional reverse proxy
    nginx.conf               SPA + static asset config for web container
    CLOUDFLARE.md            Cloudflare tunnel deployment notes
    OLARES.md                Olares box deployment notes
  package.json               Root workspace config
  pnpm-workspace.yaml        Workspace package list
  turbo.json                 Turborepo task config
  tsconfig.base.json         Shared TS config
  CLAUDE.md                  AI coding agent guidelines
```

**Tooling:**

| Tool        | Version / Notes                                     |
|-------------|-----------------------------------------------------|
| pnpm        | 10.27.0 (corepack-managed)                          |
| Turborepo   | v2                                                  |
| TypeScript  | ~5.6, strict mode                                   |
| React       | 19.1.0 (pnpm override across all workspaces)        |
| Node.js     | 22 (Dockerfile base image)                          |

---

## 3. Authentication

Readr uses a bearer-token model. There are no passwords, no sessions, and no
OAuth. The token IS the user's primary key.

### How it works

1. **First launch (mobile):** The client generates a long random alphanumeric
   string (minimum 16 chars, `[A-Za-z0-9_-]+`), POSTs it to
   `POST /api/register`, and stores it in SecureStore.
2. **Every subsequent request:** The client sends `Authorization: Bearer <token>`.
3. **Server auth middleware** (`apps/server/src/middleware/auth.ts`): Extracts
   the token from the header, does an index seek on `users.id` (the PK).
   Returns 401 if the token doesn't match a row.
4. **Token = user ID:** The `users.id` column is `text`, not UUID. The token
   string is the primary key. `c.get("userId")` in route handlers returns
   the token itself.

### Email flows (optional)

Email is an opt-in recovery/login mechanism powered by **Resend**. The feature
is entirely disabled when `RESEND_API_KEY` is unset. When enabled:

- **Attach email** (authenticated): `POST /api/email/attach` sends a 6-digit
  OTP. `POST /api/email/verify` stamps `emailVerifiedAt` on the user row.
- **Recover token** (unauthenticated): `POST /api/email/recover/start` sends
  an OTP to a verified email. `POST /api/email/recover/finish` consumes the
  code and emails the device token to the user.
- **Email login** (unauthenticated): `POST /api/email/login` sends an OTP.
  If no verified user exists for the email, one is auto-created with a
  generated token. `POST /api/email/login/verify` returns the bearer token.

Verification codes are 6-digit zero-padded strings, cryptographically random,
stored in the `email_verifications` table, and expire after 15 minutes.

### Rate limiting

In-memory token-bucket rate limiter (`apps/server/src/middleware/rate-limit.ts`):

| Preset    | Window   | Max requests | Key                    |
|-----------|----------|--------------|------------------------|
| `api`     | 1 minute | 120          | userId or IP           |
| `upload`  | 1 hour   | 20           | userId or IP           |

Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`) are set on every response. Returns 429 when exceeded.

---

## 4. Database

**Engine:** PostgreSQL 16 (Alpine image in Docker)
**ORM:** Drizzle ORM 0.41+ with `postgres` driver (postgres.js)
**Schema file:** `apps/server/src/db/schema.ts`
**Connection:** `apps/server/src/db/index.ts`

### Tables

#### `users`

| Column            | Type        | Notes                                      |
|-------------------|-------------|---------------------------------------------|
| `id`              | text PK     | The bearer token itself                     |
| `name`            | text        | Optional display name                       |
| `email`           | text        | Optional recovery email (not unique)        |
| `email_verified_at` | timestamp | Stamped on successful OTP verification     |
| `storage_quota_mb`  | integer   | Default 1024                               |
| `storage_used_mb`   | integer   | Default 0, updated on upload/delete        |
| `created_at`      | timestamp   | DEFAULT now()                               |
| `updated_at`      | timestamp   | DEFAULT now()                               |

#### `email_verifications`

| Column       | Type        | Notes                                           |
|--------------|-------------|-------------------------------------------------|
| `id`         | uuid PK     | DEFAULT random                                  |
| `email`      | text        | NOT NULL                                        |
| `code`       | text        | 6-digit zero-padded                             |
| `purpose`    | text        | `'attach'` / `'recover'` / `'login'`            |
| `user_id`    | text        | Set for attach, null for recover until consumed  |
| `expires_at` | timestamp   | 15 minutes from creation                        |
| `consumed_at`| timestamp   | Stamped on use                                  |
| `created_at` | timestamp   | DEFAULT now()                                   |

#### `files`

Content-addressable file storage. One row per SHA-256 hash of book bytes,
shared across all users. Metadata is extracted once on first upload.

| Column           | Type     | Notes                                        |
|------------------|----------|----------------------------------------------|
| `id`             | uuid PK  | DEFAULT random                               |
| `sha256`         | text     | UNIQUE, NOT NULL                             |
| `s3_key`         | text     | `files/<sha256>.<format>`                    |
| `cover_key`      | text     | `covers/<sha256>.jpg` (nullable)             |
| `size`           | bigint   | File size in bytes                           |
| `format`         | text     | `'epub'` or `'pdf'`                          |
| `ref_count`      | integer  | Number of books rows pointing here           |
| `title`          | text     | Extracted from EPUB OPF / PDF Info dict      |
| `author`         | text     | Extracted from Dublin Core / PDF Info dict    |
| `language`       | text     | Extracted metadata                           |
| `total_chapters` | integer  | EPUB spine itemref count / PDF page count    |
| `metadata`       | jsonb    | Additional raw metadata                      |
| `created_at`     | timestamp| DEFAULT now()                                |

#### `books`

Per-user reference to a file. User-facing title/author come from the joined
`files` row with optional per-user overrides via `title_override` /
`author_override`.

| Column           | Type     | Notes                                        |
|------------------|----------|----------------------------------------------|
| `id`             | uuid PK  | DEFAULT random                               |
| `user_id`        | text FK  | -> users.id, CASCADE delete                  |
| `file_id`        | uuid FK  | -> files.id                                  |
| `title_override` | text     | Per-user rename, null = inherit from files    |
| `author_override`| text     | Per-user rename, null = inherit from files    |
| `uploaded_at`    | timestamp| DEFAULT now()                                |

**Indexes:** `books_user_idx(user_id)`, `books_user_file_idx(user_id, file_id)` UNIQUE

#### `reading_progress`

| Column      | Type     | Notes                                             |
|-------------|----------|---------------------------------------------------|
| `id`        | uuid PK  | DEFAULT random                                    |
| `book_id`   | uuid FK  | -> books.id, CASCADE delete                       |
| `user_id`   | text FK  | -> users.id, CASCADE delete                       |
| `device_id` | text     | NOT NULL                                          |
| `position`  | jsonb    | `{ chapter?, cfi?, page?, percentage }`           |
| `updated_at`| timestamp| DEFAULT now()                                     |

**Unique index:** `progress_unique_idx(book_id, user_id, device_id)`

#### `bookmarks`

| Column      | Type      | Notes                                       |
|-------------|-----------|---------------------------------------------|
| `id`        | uuid PK   | DEFAULT random                              |
| `book_id`   | uuid FK   | -> books.id, CASCADE delete                 |
| `user_id`   | text FK   | -> users.id, CASCADE delete                 |
| `position`  | jsonb     | BookPosition object                         |
| `label`     | text      | Optional user label                         |
| `created_at`| timestamp | DEFAULT now()                               |
| `deleted_at`| timestamp | Soft-delete tombstone                       |

#### `highlights`

| Column       | Type      | Notes                                      |
|--------------|-----------|--------------------------------------------|
| `id`         | uuid PK   | DEFAULT random                             |
| `book_id`    | uuid FK   | -> books.id, CASCADE delete                |
| `user_id`    | text FK   | -> users.id, CASCADE delete                |
| `cfi_range`  | text      | EPUB CFI range string, NOT NULL            |
| `text_content`| text     | Selected text                              |
| `note`       | text      | Optional note attached to highlight        |
| `color`      | text      | Default `'yellow'`, one of 5 colors        |
| `created_at` | timestamp | DEFAULT now()                              |
| `deleted_at` | timestamp | Soft-delete tombstone                      |

**Highlight colors:** `yellow`, `green`, `blue`, `pink`, `purple`

#### `notes`

| Column       | Type      | Notes                                      |
|--------------|-----------|--------------------------------------------|
| `id`         | uuid PK   | DEFAULT random                             |
| `book_id`    | uuid FK   | -> books.id, CASCADE delete                |
| `user_id`    | text FK   | -> users.id, CASCADE delete                |
| `position`   | jsonb     | BookPosition object                        |
| `note_type`  | text      | `'typed'` or `'handwritten'`               |
| `text_content`| text     | Text for typed notes                       |
| `strokes`    | jsonb     | Array of `{ points[], color, width }`      |
| `pen_config` | jsonb     | `{ color, width }`                         |
| `created_at` | timestamp | DEFAULT now()                              |
| `updated_at` | timestamp | DEFAULT now()                              |
| `deleted_at` | timestamp | Soft-delete tombstone                      |

Stroke points contain `{ x, y, pressure }`. Handwriting strokes are rendered
client-side as SVG paths.

#### `lookup_providers`

Per-user configurable search/lookup URLs shown in the reader context menu.

| Column        | Type     | Notes                                       |
|---------------|----------|---------------------------------------------|
| `id`          | uuid PK  | DEFAULT random                              |
| `user_id`     | text FK  | -> users.id, CASCADE delete                 |
| `name`        | text     | NOT NULL                                    |
| `icon`        | text     | Emoji or icon identifier                    |
| `url_template`| text     | Must contain `{{query}}`                    |
| `enabled`     | boolean  | Default true                                |
| `sort_order`  | integer  | Default 0                                   |
| `is_builtin`  | boolean  | Default false                               |

**Built-in providers** (defined in `packages/shared/src/constants.ts`):
Google, Wikipedia, Google Translate, Merriam-Webster Dictionary.

#### `tts_jobs`

| Column          | Type      | Notes                                    |
|-----------------|-----------|------------------------------------------|
| `id`            | uuid PK   | DEFAULT random                           |
| `book_id`       | uuid FK   | -> books.id, CASCADE delete              |
| `user_id`       | text FK   | -> users.id, CASCADE delete              |
| `status`        | text      | `queued` / `processing` / `done` / `failed` |
| `engine`        | text      | Default `'chatterbox-turbo'`             |
| `chapters_total`| integer   | Total chapters to process                |
| `chapters_done` | integer   | Default 0                                |
| `voice_config`  | jsonb     | `{ voiceId?, exaggeration?, speed? }`    |
| `error`         | text      | Error message if failed                  |
| `created_at`    | timestamp | DEFAULT now()                            |
| `completed_at`  | timestamp | Stamped when all chapters are done       |

#### `tts_audio_chunks`

| Column         | Type     | Notes                                      |
|----------------|----------|--------------------------------------------|
| `id`           | uuid PK  | DEFAULT random                             |
| `job_id`       | uuid FK  | -> tts_jobs.id, CASCADE delete             |
| `chapter_index`| integer  | NOT NULL                                   |
| `audio_key`    | text     | S3 key, NOT NULL                           |
| `duration_ms`  | integer  | Audio duration in milliseconds             |
| `format`       | text     | Default `'opus'`                           |

#### `collections`

| Column       | Type      | Notes                                      |
|--------------|-----------|--------------------------------------------|
| `id`         | uuid PK   | DEFAULT random                             |
| `user_id`    | text FK   | -> users.id, CASCADE delete                |
| `name`       | text      | NOT NULL                                   |
| `description`| text      | Optional                                   |
| `color`      | text      | Optional color identifier                  |
| `sort_order` | integer   | Default 0                                  |
| `created_at` | timestamp | DEFAULT now()                              |

#### `book_collections`

Join table between books and collections.

| Column         | Type      | Notes                                    |
|----------------|-----------|------------------------------------------|
| `id`           | uuid PK   | DEFAULT random                           |
| `book_id`      | uuid FK   | -> books.id, CASCADE delete              |
| `collection_id`| uuid FK   | -> collections.id, CASCADE delete        |
| `added_at`     | timestamp | DEFAULT now()                            |

**Unique index:** `book_collection_unique_idx(book_id, collection_id)`

#### `reading_sessions`

| Column            | Type      | Notes                                  |
|-------------------|-----------|----------------------------------------|
| `id`              | uuid PK   | DEFAULT random                         |
| `user_id`         | text FK   | -> users.id, CASCADE delete            |
| `book_id`         | uuid FK   | -> books.id, CASCADE delete            |
| `started_at`      | timestamp | NOT NULL                               |
| `ended_at`        | timestamp | Nullable                               |
| `duration_minutes`| integer   | Session length                         |
| `pages_read`      | integer   | Nullable                               |
| `start_percentage`| integer   | 0-100, nullable                        |
| `end_percentage`  | integer   | 0-100, nullable                        |

#### `sync_log`

Append-only log of all sync operations. Used by the pull endpoint to send
changes to clients.

| Column       | Type      | Notes                                       |
|--------------|-----------|---------------------------------------------|
| `id`         | serial PK | Auto-incrementing                            |
| `user_id`    | text FK   | -> users.id, CASCADE delete                  |
| `entity_type`| text      | `bookmark` / `highlight` / `note` / `progress` |
| `entity_id`  | uuid      | NOT NULL                                     |
| `operation`  | text      | `create` / `update` / `delete`               |
| `payload`    | jsonb     | Full entity payload                          |
| `device_id`  | text      | Origin device                                |
| `timestamp`  | timestamp | DEFAULT now(), NOT NULL                      |

**Index:** `sync_log_user_ts_idx(user_id, timestamp)`

### Migrations

Drizzle Kit is used for schema management:

```bash
pnpm --filter @readr/server db:generate   # Generate migration SQL
pnpm --filter @readr/server db:migrate    # Apply migrations
pnpm --filter @readr/server db:push       # Push schema directly (dev)
pnpm --filter @readr/server db:studio     # Open Drizzle Studio
```

---

## 5. API Server

**Framework:** Hono v4 on Node.js 22, served via `@hono/node-server`
**Entry point:** `apps/server/src/index.ts`
**Run command (dev):** `tsx watch --env-file=.env src/index.ts`

### Middleware stack (applied in order)

1. `hono/logger` -- Request logging on all routes
2. `hono/cors` -- Wildcard CORS for `/api/*` (bearer token, not cookies)
3. **Auth middleware** -- Applied to `/api/*` AFTER public routes
4. **Rate limiter** -- Applied to `/api/*` AFTER auth

### Route map

Public (no auth required):

| Method | Path                         | Handler file      | Description                        |
|--------|------------------------------|-------------------|------------------------------------|
| GET    | `/health`                    | index.ts          | Health check, version, uptime      |
| POST   | `/api/register`              | register.ts       | Create user row (idempotent)       |
| GET    | `/api/email/status`          | email.ts          | Is email feature enabled?          |
| POST   | `/api/email/login`           | email.ts          | Start email login (send OTP)       |
| POST   | `/api/email/login/verify`    | email.ts          | Verify OTP, returns bearer token   |
| POST   | `/api/email/recover/start`   | email.ts          | Start token recovery (send OTP)    |
| POST   | `/api/email/recover/finish`  | email.ts          | Verify OTP, emails token to user   |

Authenticated (require `Authorization: Bearer <token>`):

| Method | Path                                    | Handler file      | Description                              |
|--------|-----------------------------------------|-------------------|------------------------------------------|
| GET    | `/api/books`                            | books.ts          | List library (sort, search, format filter)|
| POST   | `/api/books`                            | books.ts          | Upload book (multipart/form-data)        |
| GET    | `/api/books/:id`                        | books.ts          | Book detail + signed download/cover URLs |
| PATCH  | `/api/books/:id/metadata`               | books.ts          | Per-user rename (title/author override)  |
| DELETE | `/api/books/:id`                        | books.ts          | Delete from library, decrement refcount  |
| GET    | `/api/books/:id/progress`               | progress.ts       | Reading positions for a book             |
| PUT    | `/api/books/:id/progress`               | progress.ts       | Upsert reading position (per device)     |
| GET    | `/api/books/:id/annotations`            | annotations.ts    | All annotations (bookmarks+highlights+notes) |
| POST   | `/api/books/:id/bookmarks`              | annotations.ts    | Create bookmark                          |
| POST   | `/api/books/:id/highlights`             | annotations.ts    | Create highlight                         |
| POST   | `/api/books/:id/notes`                  | annotations.ts    | Create note                              |
| PATCH  | `/api/annotations/:id`                  | annotations.ts    | Update any annotation type               |
| DELETE | `/api/annotations/:id`                  | annotations.ts    | Soft-delete any annotation type          |
| GET    | `/api/sync/changes`                     | sync.ts           | Pull changes since timestamp             |
| POST   | `/api/sync/push`                        | sync.ts           | Push local changes                       |
| GET    | `/api/tts/status`                       | tts.ts            | TTS availability, engines, queue depth   |
| POST   | `/api/tts/generate`                     | tts.ts            | Queue batch TTS job                      |
| GET    | `/api/tts/jobs`                         | tts.ts            | List user's TTS jobs                     |
| GET    | `/api/tts/jobs/:id`                     | tts.ts            | Job detail + audio chunks                |
| DELETE | `/api/tts/jobs/:id`                     | tts.ts            | Delete job and audio chunks              |
| GET    | `/api/tts/audio/:bookId/:chapter`       | tts.ts            | Presigned URL for chapter audio          |
| POST   | `/api/tts/stream`                       | tts.ts            | Proxy streaming TTS via Kokoro           |
| GET    | `/api/collections`                      | collections.ts    | List collections                         |
| POST   | `/api/collections`                      | collections.ts    | Create collection                        |
| PATCH  | `/api/collections/:id`                  | collections.ts    | Update collection                        |
| DELETE | `/api/collections/:id`                  | collections.ts    | Delete collection + join rows            |
| POST   | `/api/collections/:id/books`            | collections.ts    | Add book to collection                   |
| DELETE | `/api/collections/:id/books/:bookId`    | collections.ts    | Remove book from collection              |
| GET    | `/api/collections/:id/books`            | collections.ts    | List books in collection                 |
| POST   | `/api/stats/sessions`                   | stats.ts          | Log a reading session                    |
| GET    | `/api/stats/summary`                    | stats.ts          | Total time, streak, weekly, book count   |
| GET    | `/api/stats/daily`                      | stats.ts          | Daily reading minutes (last 30 days)     |
| GET    | `/api/export/annotations/:bookId`       | export.ts         | Export annotations (markdown or JSON)    |
| POST   | `/api/email/attach`                     | email.ts          | Attach recovery email (send OTP)         |
| POST   | `/api/email/verify`                     | email.ts          | Verify attach OTP                        |

### Services

**`apps/server/src/services/storage.ts`** -- S3-compatible object storage
via `@aws-sdk/client-s3`. Provides `uploadFile`, `getPresignedDownloadUrl`,
`deleteFile`. When `S3_PUBLIC_ENDPOINT` is set, returns direct URLs instead
of signed URLs (used for publicly-readable buckets behind CF tunnel).

**`apps/server/src/services/book-processor.ts`** -- Metadata extraction:
- EPUB: JSZip + fast-xml-parser. Reads `META-INF/container.xml` to find the
  OPF, parses Dublin Core metadata (title, author, language), counts spine
  itemrefs for chapter count, extracts cover image (EPUB 3 `properties="cover-image"`,
  EPUB 2 `<meta name="cover">`, or heuristic ID match).
- PDF: `pdf-parse` for Info dict, `pdftoppm` (poppler-utils, installed in
  Docker image) for page-1 cover rendering.
- Covers are normalized to 600x900 progressive JPEG via `sharp`.
- Content hashing via SHA-256 for deduplication.

**`apps/server/src/services/email.ts`** -- Resend SDK wrapper. Feature-gated
on `RESEND_API_KEY` + `RESEND_FROM` env vars.

**`apps/server/src/services/tts-queue.ts`** -- BullMQ queue named `tts`.
Creates DB job row and enqueues per-chapter sub-jobs.

**`apps/server/src/lib/redis.ts`** -- IORedis connection with
`maxRetriesPerRequest: null` (required by BullMQ).

**`apps/server/src/lib/errors.ts`** -- `AppError` class with status code.
Helpers: `notFound`, `badRequest`, `forbidden`, `conflict`, `payloadTooLarge`.

**`apps/server/src/middleware/user-scope.ts`** -- `scopeToUser` object with
per-table Drizzle `eq()` helpers. Every data query must use these to ensure
user isolation.

### Book upload flow

1. Client sends `POST /api/books` with `multipart/form-data` file field.
2. Server validates format (epub/pdf only), checks size (<= MAX_UPLOAD_SIZE_MB),
   checks storage quota.
3. Computes SHA-256 hash of the file buffer.
4. If a `files` row with that hash exists: reuse it, increment `ref_count`.
   Reject if user already has a `books` row pointing at this file (409 Conflict).
5. If new file: upload to S3 (`files/<sha256>.<format>`), extract metadata,
   upload cover (`covers/<sha256>.jpg`), insert `files` row.
6. Insert `books` row linking user to file.
7. Update user's `storage_used_mb`.
8. Return full book object with presigned download and cover URLs.

### Book delete flow

1. Delete the `books` row.
2. Decrement `files.ref_count`.
3. If ref_count reaches 0: delete S3 objects and the `files` row.
4. Decrease user's `storage_used_mb`.

---

## 6. Mobile App

**Framework:** React Native with Expo SDK 54, expo-router (file-based routing)
**Entry point:** `apps/mobile/app/_layout.tsx`

### Screen structure

```
app/
  _layout.tsx            Root layout (QueryClient, SafeAreaProvider, DisplayProvider)
  index.tsx              Auth redirect
  (auth)/
    _layout.tsx          Auth group layout
    login.tsx            Login screen (server URL + token or email login)
  (tabs)/
    _layout.tsx          Tab bar layout
    library.tsx          Book grid/list with search, sort, format filter
    stats.tsx            Reading statistics dashboard
    settings.tsx         Settings (account, display, e-ink toggle, email attach)
  book/
    [bookId].tsx         Book detail screen (metadata, download, delete, annotations)
  reader/
    [bookId].tsx         Full-screen reader (WebView-based)
```

### Reader architecture

The reader is a full-screen WebView that loads an HTML document generated by
`epub-html.ts` or `pdf-html.ts`. The rendering engine is **foliate-js**,
bundled as an IIFE via esbuild (zero CDN dependencies).

**Key files:**
- `apps/mobile/components/reader/epub-html.ts` -- Generates the reader HTML
- `apps/mobile/components/reader/pdf-html.ts` -- PDF reader HTML
- `apps/mobile/app/reader/[bookId].tsx` -- Reader screen with WebView

**WebView bridge protocol:** Simple JSON `postMessage` in both directions.

Messages from WebView to React Native (`window.ReactNativeWebView.postMessage`):
- `ready` -- Book loaded, sends TOC and metadata
- `relocated` -- Position changed (CFI, percentage, chapter, page numbers)
- `tocReady` -- Table of contents parsed
- `selection` -- Text selected (CFI range, text, coordinates)
- `tap` -- User tapped (coordinates, zone: left/center/right)
- `search` -- Search results
- `pageText` -- Current page text (for TTS)

Messages from React Native to WebView (`webViewRef.injectJavaScript`):
- `setTheme` -- Apply reader theme (colors, font, margins, line height, weight)
- `goToLocation` -- Navigate to CFI or fraction
- `goToChapter` -- Navigate to TOC href
- `prevPage` / `nextPage` -- Turn pages
- `search` / `clearSearch` -- Full-text search
- `addHighlight` / `removeHighlight` -- Manage highlights in the DOM
- `getPageText` -- Request current page text for TTS

**17 bundled Google Fonts** (loaded from `android_asset/fonts/` via `@font-face`):
Literata, Lora, Merriweather, EB Garamond, Source Serif 4, Noto Serif,
Crimson Text, Libre Baskerville, Playfair Display, PT Serif, Roboto Slab,
Roboto, Open Sans, Inter, Nunito, Fira Mono, IBM Plex Mono.
Plus OpenDyslexic support declared in font family options.

**6 theme presets** (in `SettingsDropdown.tsx`):
Light (#ffffff/#111111), Sepia (#f8f0e3/#5b4636), Canvas (#d4c5a9/#3a2e1e),
Gray (#2a2a2a/#cccccc), Dark (#1a1a2e/#e0e0e0), Black (#000000/#c8c8c8).

**ReaderTheme properties:**
- `bg`, `fg` -- Background/foreground colors
- `fontSize` -- 12-32px range
- `lineHeight` -- 1.2-2.4 range (0.1 step)
- `fontFamily` -- One of the 17+ bundled fonts or system defaults
- `margin` -- Horizontal margin, 16-128px (8px step)
- `marginV` -- Vertical margin
- `tapToTurn` -- Toggle tap-to-turn mode
- `fontWeight` -- 300 (Light), 400 (Regular), 500 (Medium), 700 (Bold)
- `brightness` -- 0..1 or null (system)

Reader preferences are persisted to SecureStore (per-device, not synced).

### Components

| Component              | File                                         | Description                              |
|------------------------|----------------------------------------------|------------------------------------------|
| ReaderControls         | `components/reader/ReaderControls.tsx`        | Top/bottom bars with progress, chapter   |
| SettingsDropdown       | `components/reader/SettingsDropdown.tsx`      | Font, theme, margin, spacing settings    |
| TocDrawer              | `components/reader/TocDrawer.tsx`             | TOC with chapters, bookmarks, notes tabs |
| ContextMenu            | `components/reader/ContextMenu.tsx`           | Text selection actions (highlight, note, look up) |
| NotesPanel             | `components/reader/NotesPanel.tsx`            | Create/edit notes (typed or handwriting) |
| GotoDialog             | `components/reader/GotoDialog.tsx`            | Jump to page/percentage dialog           |
| TtsBar                 | `components/reader/TtsBar.tsx`                | TTS playback controls                    |
| HandwritingCanvas      | `components/notes/HandwritingCanvas.tsx`      | SVG-based handwriting input with eraser  |
| TypedNoteEditor        | `components/notes/TypedNoteEditor.tsx`        | Text note input                          |
| AudioPlayer            | `components/audio/AudioPlayer.tsx`            | Audio playback UI                        |
| OnDeviceTTS            | `components/audio/OnDeviceTTS.tsx`            | On-device TTS via expo-speech            |

### State management

**Zustand stores:**
- `lib/auth-store.ts` -- `useAuthStore`: isAuthenticated, serverUrl, token,
  checkSession, signOut, loginDirect
- `lib/tts-store.ts` -- `useTtsStore`: TTS state (idle/playing/paused), rate,
  pitch, speak/pause/resume/stop via expo-speech. Splits text on sentence
  boundaries to work within Android's 4000-char TTS buffer.
- `lib/sync-status.ts` -- `useSyncStatus`: Sync state UI (syncing, last result)
- `lib/library-prefs.ts` -- `useLibraryPrefs`: Sort order, view mode persistence
- `contexts/DisplayContext.tsx` -- `useDisplayStore`: E-ink detection and display
  settings (isEink, animationsEnabled, highContrast, minTapTarget, scrollMode)

**React Query:** Used for all server data fetching (book list, book detail,
annotations, stats). Configured with 1-minute stale time and 1 retry.

### Local database

**Engine:** expo-sqlite via `openDatabaseSync` (required for Android 16 / API 36
compatibility -- `openDatabaseAsync` NPEs on this API level).

**File:** `apps/mobile/lib/local-db.ts`

**Tables:**

| Table              | Purpose                                         |
|--------------------|-------------------------------------------------|
| `reading_progress` | Per-device reading position per book             |
| `bookmarks`        | Bookmarks with soft-delete                       |
| `highlights`       | Highlights with CFI range and color              |
| `notes`            | Typed and handwritten notes with strokes         |
| `sync_queue`       | Outbound change queue for push sync              |
| `downloaded_books` | Locally-cached book binaries for offline reading |

All annotation mutations write to both the local table and `sync_queue`
simultaneously. The queue is drained during sync pushes.

### Offline book cache

`apps/mobile/lib/book-cache.ts` manages downloading book binaries for offline
reading. Uses `expo-file-system/legacy` for download with progress callbacks.
Books are stored at `<documentDirectory>/books/<bookId>.<format>`.

### Offline dictionary

`apps/mobile/lib/dictionary.ts` provides an offline English dictionary with
~108,000 words across 27 JSON files (~9MB total) bundled in
`apps/mobile/assets/dictionary/`. Lazy-loads per first letter, caches in
memory. Includes basic stemming for inflections (plurals, -ing, -ed, -ly).

### Sync engine (client side)

`apps/mobile/lib/sync.ts` runs the full sync cycle:

1. **Pull:** `GET /api/sync/changes?since=<timestamp>` fetches remote changes.
   Applies them to local SQLite tables.
2. **Push:** Reads `sync_queue`, deduplicates via `@readr/sync-engine`, POSTs
   to `/api/sync/push`. Removes accepted entries from the queue.
3. **Timestamp:** Stores last sync timestamp in SecureStore.

Sync runs automatically on app open when authenticated.

### E-ink support

`contexts/DisplayContext.tsx` auto-detects e-ink devices (Supernote/Ratta,
ONYX/BOOX, Kobo, Kindle) by checking `NativeModules.PlatformConstants` for
brand/manufacturer/model strings.

When `isEink: true`:
- Animations disabled
- High contrast mode
- Larger tap targets (64px vs 48px)
- Paginated scroll mode
- Reader uses the EINK_THEME preset (larger font, heavier weight, more margin)

---

## 7. Web App

**Framework:** React 19 + Vite 6 + TanStack Router v1 + TanStack Query v5 +
Tailwind CSS v4
**Entry point:** `apps/web/src/main.tsx`
**Icons:** lucide-react

### Route map

```
src/routes/
  __root.tsx            Root layout
  index.tsx             Landing/redirect
  login.tsx             Login page (server URL + token)
  library.tsx           Book library grid
  upload.tsx            Book upload form
  book.$bookId.tsx      Book detail page
  reader.$bookId.tsx    Web reader (foliate-js)
```

### Components

| Component       | File                               | Description                    |
|-----------------|------------------------------------|--------------------------------|
| ErrorBoundary   | `src/components/ErrorBoundary.tsx`  | React error boundary           |
| Toast           | `src/components/Toast.tsx`          | Toast notification system      |

### API client

`apps/web/src/lib/api.ts` mirrors the mobile API client pattern with
bearer token authentication.

### Web reader

The web reader page (`reader.$bookId.tsx`) uses foliate-js loaded from CDN.
The reader provides basic EPUB rendering with theme controls.

---

## 8. Shared Packages

### `packages/shared` (`@readr/shared`)

**Exports:** `src/index.ts` re-exports all from types, constants, validators.

**Types** (`src/types.ts`):
- `User`, `FileRecord`, `Book`, `BookPosition`, `ReadingProgress`
- `Bookmark`, `Highlight`, `HighlightColor`, `Note`
- `StrokePoint`, `Stroke`, `PenConfig`
- `LookupProvider`
- `TTSJob`, `VoiceConfig`, `TTSAudioChunk`, `TTSStatus`
- `SyncLogEntry`, `SyncConflict`

**Constants** (`src/constants.ts`):
- `HIGHLIGHT_COLORS` -- 5-color enum
- `DEFAULT_LOOKUP_PROVIDERS` -- Google, Wikipedia, Translate, Dictionary
- `MAX_UPLOAD_SIZE_MB` -- 500
- `DEFAULT_STORAGE_QUOTA_MB` -- 1024
- `PRESIGNED_URL_EXPIRY_SECONDS` -- 900 (15 minutes)
- `TTS_ENGINES` -- `chatterbox`, `chatterbox-turbo`, `kokoro`
- `TTS_DEFAULT_ENGINE` -- `chatterbox-turbo`

**Validators** (`src/validators.ts`) -- Zod schemas:
- `bookPositionSchema` -- `{ chapter?, cfi?, page?, percentage }`
- `listBooksQuerySchema` -- sort enum, search, format filter
- `updateBookMetadataSchema` -- title/author nullable strings
- `upsertProgressSchema` -- deviceId + position
- `createBookmarkSchema`, `createHighlightSchema`, `createNoteSchema`
- `highlightColorSchema` -- 5-color enum
- `strokePointSchema`, `strokeSchema`, `penConfigSchema`
- `updateAnnotationSchema` -- Union of all annotation update fields
- `syncPullQuerySchema`, `syncLogEntrySchema`, `syncPushSchema`
- `voiceConfigSchema`, `generateTTSSchema`, `streamTTSSchema`
- `createLookupProviderSchema`, `updateLookupProviderSchema`

### `packages/sync-engine` (`@readr/sync-engine`)

Isomorphic sync logic used by both the server and the mobile client.

**LWW merge** (`src/lww.ts`):
- Used for reading progress.
- Compares client and server timestamps.
- Newer timestamp wins. Server wins on tie.
- Returns `{ accepted: boolean, winner: 'client' | 'server' }`.

**Set merge** (`src/set.ts`):
- Used for annotations (bookmarks, highlights, notes).
- Rules:
  - **Create:** Insert if entity doesn't exist. If tombstoned, skip (tombstone wins).
  - **Delete:** Set `deletedAt`. Tombstone is permanent.
  - **Update:** Apply if entity exists and is not tombstoned. LWW by timestamp
    for field conflicts.
- Returns action: `insert`, `update`, `soft_delete`, or `skip` (with reason).
- `processBatch` helper for processing arrays of changes.

**Queue dedup** (`src/queue.ts`):
- `deduplicateQueue`: For the same entity, keep only the latest operation by
  timestamp. Prevents sending stale intermediate states.
- `partitionByType`: Group changes by entity type.

**Tests:** Unit tests in `lww.test.ts`, `set.test.ts`, `queue.test.ts`.

---

## 9. TTS Worker

**Framework:** Python FastAPI (streaming API) + standalone Redis queue worker
**Location:** `services/tts-worker/`

### Components

**`api.py`** -- FastAPI server for health checks and streaming TTS:
- `GET /health` -- Returns status, available engines list, GPU availability
- `POST /tts/stream` -- Real-time streaming TTS using Kokoro engine.
  Returns chunked `audio/ogg` (Opus codec) stream.

**`worker.py`** -- Queue processor:
- Listens on BullMQ Redis queue `bull:tts:wait` via BRPOP.
- Processes `generate-chapter` jobs: loads engine, generates audio,
  encodes to Opus, uploads to S3, updates Postgres progress.
- Engines loaded lazily and cached in process memory.

**`download_models.py`** -- Script to download model files to `/models/`.

### Engines

| Engine             | Use case                        | Sample rate |
|--------------------|---------------------------------|-------------|
| Chatterbox         | High quality, batch processing  | 24 kHz      |
| Chatterbox Turbo   | Faster variant, default engine  | 24 kHz      |
| Kokoro             | Real-time streaming, low latency| 24 kHz      |

Engine availability is determined by checking for model files in `TTS_MODEL_DIR`.

### Audio pipeline

1. Text input from job data
2. Engine generates numpy audio array at 24 kHz
3. Encoded to Opus format in OGG container via `soundfile`
4. Uploaded to S3 at `<userId>/tts/<bookId>/<chapterIndex>.opus`
5. Progress updated in Postgres (`tts_audio_chunks` insert, `tts_jobs` counter)

### Dependencies

```
redis>=5.0
boto3>=1.34
psycopg2-binary>=2.9
chatterbox-tts>=0.1
kokoro>=0.1
fastapi>=0.115
uvicorn>=0.34
pydantic>=2.0
soundfile>=0.12
numpy>=1.26
torch>=2.1
```

---

## 10. Object Storage

**Protocol:** S3-compatible (MinIO for local dev, Cloudflare R2 for production)
**Client:** `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`

### Key layout

```
files/<sha256>.<format>              Book binary (epub/pdf)
covers/<sha256>.jpg                  Book cover (600x900 JPEG)
<userId>/tts/<bookId>/<chapter>.opus TTS audio chunks
```

### URL strategy

- When `S3_PUBLIC_ENDPOINT` is set: returns direct `<public_base>/<bucket>/<key>`
  URLs. Used when the bucket is publicly readable (e.g., R2 with public access).
  Avoids S3v4 host-header mismatches when proxied through Cloudflare tunnel.
- When unset: returns presigned URLs via `getSignedUrl` with 15-minute expiry.

---

## 11. Environment Variables

### Server (`apps/server/.env`)

| Variable             | Required | Default             | Description                              |
|----------------------|----------|---------------------|------------------------------------------|
| `DATABASE_URL`       | Yes      | --                  | PostgreSQL connection string             |
| `REDIS_URL`          | No       | `redis://localhost:6379` | Redis for BullMQ                    |
| `TTS_WORKER_URL`     | No       | --                  | TTS API base URL (enables TTS feature)   |
| `S3_ENDPOINT`        | Yes      | --                  | S3-compatible endpoint URL               |
| `S3_PUBLIC_ENDPOINT` | No       | --                  | Public-facing S3 URL for presigned URLs  |
| `S3_BUCKET`          | Yes      | --                  | Bucket name                              |
| `S3_ACCESS_KEY`      | Yes      | --                  | S3 access key                            |
| `S3_SECRET_KEY`      | Yes      | --                  | S3 secret key                            |
| `S3_REGION`          | No       | `auto`              | S3 region                                |
| `S3_FORCE_PATH_STYLE`| No      | `true`              | Use path-style S3 URLs (for MinIO)       |
| `PUBLIC_URL`         | No       | --                  | Server's public-facing URL               |
| `RESEND_API_KEY`     | No       | --                  | Resend API key (enables email feature)   |
| `RESEND_FROM`        | No       | --                  | From address for outbound email          |
| `PORT`               | No       | `3000`              | Server listen port                       |
| `NODE_ENV`           | No       | `development`       | `development` / `production` / `test`    |
| `LOG_LEVEL`          | No       | `debug`             | `debug` / `info` / `warn` / `error`     |
| `MAX_UPLOAD_SIZE_MB` | No       | `500`               | Max file upload size                     |
| `DEFAULT_STORAGE_QUOTA_MB` | No | `1024`              | Default per-user storage quota           |

### TTS Worker

| Variable          | Required | Default                | Description                   |
|-------------------|----------|------------------------|-------------------------------|
| `REDIS_URL`       | No       | `redis://localhost:6379` | Redis connection            |
| `DATABASE_URL`    | Yes      | --                     | PostgreSQL connection string  |
| `S3_ENDPOINT`     | Yes      | --                     | S3-compatible endpoint        |
| `S3_BUCKET`       | Yes      | --                     | Bucket name                   |
| `S3_ACCESS_KEY`   | Yes      | --                     | S3 access key                 |
| `S3_SECRET_KEY`   | Yes      | --                     | S3 secret key                 |
| `S3_REGION`       | No       | `auto`                 | S3 region                     |
| `TTS_MODEL_DIR`   | No       | `/models`              | Directory containing models   |
| `TTS_API_PORT`    | No       | `8000`                 | FastAPI server port           |

---

## 12. Deployment

### Docker Compose (production)

**File:** `deploy/docker-compose.yml`
**Run:** `docker compose -f deploy/docker-compose.yml up -d --build`

Services:

| Service      | Image / Build                  | Ports        | Notes                          |
|--------------|--------------------------------|--------------|--------------------------------|
| `api`        | `deploy/Dockerfile.server`     | 3000         | Hono API, depends on pg/redis/minio |
| `web`        | `deploy/Dockerfile.web`        | 8080 -> 80   | Vite build served by nginx     |
| `postgres`   | postgres:16-alpine             | --           | Internal only, health checked  |
| `redis`      | redis:7-alpine                 | --           | Internal only                  |
| `minio`      | minio/minio:latest             | 9000, 9001   | S3 API + web console           |
| `minio-init` | minio/mc:latest                | --           | One-shot: creates bucket       |
| `caddy`      | caddy:2-alpine                 | 80, 443      | Optional (profile: `public`)   |

**Caddy** is optional and only started with `--profile public`. Proxies
`/api/*` and `/health` to the API server, everything else to the web container.
Deployments using Cloudflare tunnel skip Caddy.

**Volumes:** `pgdata`, `redisdata`, `miniodata`, `caddy_data`, `caddy_config`

### Docker Compose (development)

**File:** `deploy/docker-compose.dev.yml`
**Run:** `docker compose -f deploy/docker-compose.dev.yml up -d`

Starts only infrastructure services (Postgres, Redis, MinIO). App services
are run locally via `pnpm dev`.

MinIO bucket created with `mc anonymous set none` (private, requires presigned
URLs). Production stack uses `mc anonymous set download` (public read).

### Docker Compose (GPU / TTS)

**File:** `deploy/docker-compose.gpu.yml`
**Run:** Overlay with: `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up`

Adds `tts-worker` service with NVIDIA GPU passthrough (1 GPU). Mounts
`tts-models` volume at `/models`.

### Dockerfiles

**`deploy/Dockerfile.server`:**
- Base: `node:22-alpine` with pnpm 10.27.0 via corepack
- Installs `poppler-utils` for PDF cover rendering
- Runs TypeScript directly via `tsx` (no pre-compile step)
- Packages/shared and packages/sync-engine copied as source (resolved at import
  time by tsx)

**`deploy/Dockerfile.web`:**
- Base: `node:22-alpine` with pnpm
- Builds with `vite build`
- Production stage: `nginx:alpine` serving from `/usr/share/nginx/html`
- SPA fallback via `nginx.conf`
- Static assets cached for 1 year with `immutable` header

### Running locally

```bash
# 1. Start infrastructure
docker compose -f deploy/docker-compose.dev.yml up -d

# 2. Install dependencies
pnpm install

# 3. Push database schema
pnpm --filter @readr/server db:push

# 4. Start all dev servers
pnpm dev

# Or individually:
pnpm --filter @readr/server dev    # API server on :3000
pnpm --filter @readr/web dev       # Web client on :5173
cd apps/mobile && npx expo start   # Mobile (Expo Go or dev build)
```

### Turborepo tasks

| Task        | Description                        | Caching |
|-------------|------------------------------------|---------|
| `build`     | Build all packages/apps            | Yes     |
| `dev`       | Start dev servers (persistent)     | No      |
| `lint`      | Run linters                        | Yes     |
| `typecheck` | Run TypeScript type checking       | Yes     |

---

## 13. Sync Protocol

### Pull flow

```
GET /api/sync/changes?since=<ISO timestamp>&deviceId=<string>
```

Returns all `sync_log` entries for the user newer than `since`, ordered by
timestamp. Response includes `serverTimestamp` for the client to use in the
next pull.

### Push flow

```
POST /api/sync/push
Body: { changes: SyncLogEntry[] }
```

Each change is processed sequentially:

1. **Progress** entities use LWW merge (`@readr/sync-engine/lww`).
   Client timestamp vs. server `updated_at`. Newer wins.
2. **Annotation** entities (bookmark, highlight, note) use tombstone set
   merge (`@readr/sync-engine/set`). Looks up existing entity, determines
   action (insert/update/soft_delete/skip).
3. Accepted changes are written to the entity table AND appended to `sync_log`.

Response: `{ accepted: number, acceptedEntities: [...], conflicts: [...] }`

### Client-side dedup

Before pushing, the mobile client runs `deduplicateQueue()` which keeps only
the latest operation per `entityType:entityId` key. This collapses rapid
page-turn events into a single progress update.

---

## 14. Security Model

- **No passwords.** The bearer token is the sole authentication factor.
  Treat it like a password. Stored in SecureStore (mobile) or localStorage (web).
- **Token = PK.** Deleting the user row immediately revokes access.
- **User scoping.** Every data query uses `scopeToUser` helpers from
  `apps/server/src/middleware/user-scope.ts`. No route handler accepts a
  client-supplied `userId` -- it always comes from `c.get("userId")`.
- **CORS.** Wildcard origin allowed because auth uses bearer tokens (no
  ambient cookie authority). Credentials mode is `false`.
- **Rate limiting.** In-memory, keyed by userId or IP. 120 req/min for API,
  20/hour for uploads.
- **Content-addressable storage.** Files are keyed by SHA-256 hash.
  Multiple users uploading the same book share one S3 object.
- **Soft deletes.** Annotations use `deleted_at` tombstones instead of
  hard deletes, which is critical for sync convergence.

---

## 15. Key Dependencies

### Server

| Package                     | Purpose                              |
|-----------------------------|--------------------------------------|
| hono                        | Web framework                        |
| @hono/node-server           | Node.js HTTP server adapter          |
| drizzle-orm                 | PostgreSQL ORM                       |
| postgres (postgres.js)      | PostgreSQL driver                    |
| @aws-sdk/client-s3          | S3 object storage                    |
| @aws-sdk/s3-request-presigner | Presigned URL generation           |
| bullmq                      | Redis job queue (TTS)                |
| ioredis                     | Redis client                         |
| jszip                       | EPUB ZIP extraction                  |
| fast-xml-parser             | EPUB OPF/container.xml parsing       |
| pdf-parse                   | PDF metadata extraction              |
| sharp                       | Image processing (cover normalization)|
| resend                      | Transactional email                  |
| zod                         | Schema validation                    |
| tsx                         | TypeScript execution (dev + production) |
| drizzle-kit                 | Schema migrations                    |

### Mobile

| Package                     | Purpose                              |
|-----------------------------|--------------------------------------|
| expo (~54.0)                | React Native framework               |
| expo-router                 | File-based routing                   |
| expo-sqlite                 | Local SQLite database                |
| expo-secure-store           | Secure credential storage            |
| expo-file-system            | File downloads and caching           |
| expo-speech                 | On-device TTS                        |
| expo-brightness             | Screen brightness control            |
| expo-av                     | Audio playback                       |
| expo-asset                  | Bundled asset management             |
| react-native-webview        | EPUB/PDF rendering                   |
| @tanstack/react-query       | Server state management              |
| zustand                     | Client state management              |
| lucide-react-native         | Icons                                |
| react-native-safe-area-context | Safe area insets                   |

### Web

| Package                     | Purpose                              |
|-----------------------------|--------------------------------------|
| react, react-dom            | UI framework (v19)                   |
| vite                        | Build tool (v6)                      |
| @tanstack/react-router      | Client-side routing (v1)             |
| @tanstack/react-query       | Server state management (v5)         |
| tailwindcss                 | Utility CSS (v4)                     |
| lucide-react                | Icons                                |
| zod                         | Schema validation                    |

---

## 16. Planned (Not Yet Implemented)

The following features are referenced in code comments, TODOs, or the original
spec but do not exist in the codebase yet.

### Server

- **TTS text extraction:** `POST /api/tts/generate` currently creates a job
  with placeholder chapter text (`"Chapter text placeholder"`). Actual EPUB/PDF
  text extraction for TTS is not implemented.
- **TTS S3 cleanup on delete:** `DELETE /api/tts/jobs/:id` deletes DB rows but
  does not delete audio files from S3 (marked with `// TODO`).
- **Lookup provider CRUD routes:** Schema and validators exist for lookup
  providers but no route file (`routes/lookup-providers.ts`) is wired up.

### Web

- **Bundle foliate-js locally:** The web reader loads foliate-js from CDN.
  The mobile app bundles it as an IIFE. Bundling for web is planned.
- **TTS queue page:** No web UI for viewing/managing TTS jobs.
- **Settings page:** No web settings/account management page.
- **Collection management:** No web UI for creating/managing collections.

### Infrastructure

- **Helm chart:** No Kubernetes deployment configuration exists. Docker
  Compose is the only deployment method.
- **TTS Dockerfile:** `docker-compose.gpu.yml` references `deploy/Dockerfile.tts`
  but this file does not exist in the repository.
- **Redis-backed rate limiting:** The current rate limiter is in-memory.
  Multi-instance deployments would need Redis-backed rate limiting.

### Mobile

- **Collection management UI:** API routes exist but no mobile UI for
  creating/managing collections is implemented.
- **PDF reader features:** The PDF reader (`pdf-html.ts`) exists but has
  fewer features than the EPUB reader (no highlights, limited annotations).
