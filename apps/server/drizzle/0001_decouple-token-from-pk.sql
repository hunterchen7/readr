-- Migration: Decouple bearer token from user primary key
--
-- Before: users.id (text) IS the bearer token; all FK columns are text.
-- After:  users.id (uuid) is a server-generated PK; users.token (text)
--         holds the bearer token with a unique index. All FK columns
--         become uuid. Email gets a partial unique index on verified rows.
--
-- Run inside a transaction. Back up the database before applying.
-- This migration is designed for databases created by Drizzle db:push
-- where FK constraint names follow the pattern:
--   <table>_<column>_<ref_table>_<ref_column>_fk

BEGIN;

-- ========================================================================
-- 1. Alter users table: add uuid column, rename id → token
-- ========================================================================

-- Add the new UUID column (auto-populated for existing rows).
ALTER TABLE users ADD COLUMN new_id UUID DEFAULT gen_random_uuid();
UPDATE users SET new_id = gen_random_uuid() WHERE new_id IS NULL;
ALTER TABLE users ALTER COLUMN new_id SET NOT NULL;

-- ========================================================================
-- 2. Add temp UUID columns to all child tables and populate via join
-- ========================================================================

-- books
ALTER TABLE books ADD COLUMN new_user_id UUID;
UPDATE books SET new_user_id = u.new_id FROM users u WHERE books.user_id = u.id;

-- reading_progress
ALTER TABLE reading_progress ADD COLUMN new_user_id UUID;
UPDATE reading_progress SET new_user_id = u.new_id FROM users u WHERE reading_progress.user_id = u.id;

-- bookmarks
ALTER TABLE bookmarks ADD COLUMN new_user_id UUID;
UPDATE bookmarks SET new_user_id = u.new_id FROM users u WHERE bookmarks.user_id = u.id;

-- highlights
ALTER TABLE highlights ADD COLUMN new_user_id UUID;
UPDATE highlights SET new_user_id = u.new_id FROM users u WHERE highlights.user_id = u.id;

-- notes
ALTER TABLE notes ADD COLUMN new_user_id UUID;
UPDATE notes SET new_user_id = u.new_id FROM users u WHERE notes.user_id = u.id;

-- lookup_providers
ALTER TABLE lookup_providers ADD COLUMN new_user_id UUID;
UPDATE lookup_providers SET new_user_id = u.new_id FROM users u WHERE lookup_providers.user_id = u.id;

-- tts_jobs
ALTER TABLE tts_jobs ADD COLUMN new_user_id UUID;
UPDATE tts_jobs SET new_user_id = u.new_id FROM users u WHERE tts_jobs.user_id = u.id;

-- collections
ALTER TABLE collections ADD COLUMN new_user_id UUID;
UPDATE collections SET new_user_id = u.new_id FROM users u WHERE collections.user_id = u.id;

-- reading_sessions
ALTER TABLE reading_sessions ADD COLUMN new_user_id UUID;
UPDATE reading_sessions SET new_user_id = u.new_id FROM users u WHERE reading_sessions.user_id = u.id;

-- sync_log
ALTER TABLE sync_log ADD COLUMN new_user_id UUID;
UPDATE sync_log SET new_user_id = u.new_id FROM users u WHERE sync_log.user_id = u.id;

-- email_verifications (nullable — not all rows have a userId)
ALTER TABLE email_verifications ADD COLUMN new_user_id UUID;
UPDATE email_verifications SET new_user_id = u.new_id FROM users u WHERE email_verifications.user_id = u.id;

-- ========================================================================
-- 3. Drop FK constraints on all child tables
-- ========================================================================

ALTER TABLE books DROP CONSTRAINT IF EXISTS books_user_id_users_id_fk;
ALTER TABLE reading_progress DROP CONSTRAINT IF EXISTS reading_progress_user_id_users_id_fk;
ALTER TABLE bookmarks DROP CONSTRAINT IF EXISTS bookmarks_user_id_users_id_fk;
ALTER TABLE highlights DROP CONSTRAINT IF EXISTS highlights_user_id_users_id_fk;
ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_user_id_users_id_fk;
ALTER TABLE lookup_providers DROP CONSTRAINT IF EXISTS lookup_providers_user_id_users_id_fk;
ALTER TABLE tts_jobs DROP CONSTRAINT IF EXISTS tts_jobs_user_id_users_id_fk;
ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_user_id_users_id_fk;
ALTER TABLE reading_sessions DROP CONSTRAINT IF EXISTS reading_sessions_user_id_users_id_fk;
ALTER TABLE sync_log DROP CONSTRAINT IF EXISTS sync_log_user_id_users_id_fk;
-- email_verifications had no FK before, but drop just in case
ALTER TABLE email_verifications DROP CONSTRAINT IF EXISTS email_verifications_user_id_users_id_fk;

-- ========================================================================
-- 4. Drop indexes that include user_id (will be recreated after column swap)
-- ========================================================================

DROP INDEX IF EXISTS books_user_idx;
DROP INDEX IF EXISTS books_user_file_idx;
DROP INDEX IF EXISTS progress_unique_idx;
DROP INDEX IF EXISTS bookmarks_user_idx;
DROP INDEX IF EXISTS highlights_user_idx;
DROP INDEX IF EXISTS notes_user_idx;
DROP INDEX IF EXISTS tts_jobs_user_idx;
DROP INDEX IF EXISTS collections_user_idx;
DROP INDEX IF EXISTS reading_sessions_user_idx;
DROP INDEX IF EXISTS reading_sessions_user_started_idx;
DROP INDEX IF EXISTS sync_log_user_ts_idx;

-- ========================================================================
-- 5. Swap columns on child tables: drop old text user_id, rename new to user_id
-- ========================================================================

-- books
ALTER TABLE books DROP COLUMN user_id;
ALTER TABLE books RENAME COLUMN new_user_id TO user_id;
ALTER TABLE books ALTER COLUMN user_id SET NOT NULL;

-- reading_progress
ALTER TABLE reading_progress DROP COLUMN user_id;
ALTER TABLE reading_progress RENAME COLUMN new_user_id TO user_id;
ALTER TABLE reading_progress ALTER COLUMN user_id SET NOT NULL;

-- bookmarks
ALTER TABLE bookmarks DROP COLUMN user_id;
ALTER TABLE bookmarks RENAME COLUMN new_user_id TO user_id;
ALTER TABLE bookmarks ALTER COLUMN user_id SET NOT NULL;

-- highlights
ALTER TABLE highlights DROP COLUMN user_id;
ALTER TABLE highlights RENAME COLUMN new_user_id TO user_id;
ALTER TABLE highlights ALTER COLUMN user_id SET NOT NULL;

-- notes
ALTER TABLE notes DROP COLUMN user_id;
ALTER TABLE notes RENAME COLUMN new_user_id TO user_id;
ALTER TABLE notes ALTER COLUMN user_id SET NOT NULL;

-- lookup_providers
ALTER TABLE lookup_providers DROP COLUMN user_id;
ALTER TABLE lookup_providers RENAME COLUMN new_user_id TO user_id;
ALTER TABLE lookup_providers ALTER COLUMN user_id SET NOT NULL;

-- tts_jobs
ALTER TABLE tts_jobs DROP COLUMN user_id;
ALTER TABLE tts_jobs RENAME COLUMN new_user_id TO user_id;
ALTER TABLE tts_jobs ALTER COLUMN user_id SET NOT NULL;

-- collections
ALTER TABLE collections DROP COLUMN user_id;
ALTER TABLE collections RENAME COLUMN new_user_id TO user_id;
ALTER TABLE collections ALTER COLUMN user_id SET NOT NULL;

-- reading_sessions
ALTER TABLE reading_sessions DROP COLUMN user_id;
ALTER TABLE reading_sessions RENAME COLUMN new_user_id TO user_id;
ALTER TABLE reading_sessions ALTER COLUMN user_id SET NOT NULL;

-- sync_log
ALTER TABLE sync_log DROP COLUMN user_id;
ALTER TABLE sync_log RENAME COLUMN new_user_id TO user_id;
ALTER TABLE sync_log ALTER COLUMN user_id SET NOT NULL;

-- email_verifications (nullable)
ALTER TABLE email_verifications DROP COLUMN user_id;
ALTER TABLE email_verifications RENAME COLUMN new_user_id TO user_id;

-- ========================================================================
-- 6. Swap PK on users: old text id → token, new uuid → id
-- ========================================================================

ALTER TABLE users DROP CONSTRAINT users_pkey;
ALTER TABLE users RENAME COLUMN id TO token;
ALTER TABLE users RENAME COLUMN new_id TO id;
ALTER TABLE users ADD PRIMARY KEY (id);
ALTER TABLE users ALTER COLUMN token SET NOT NULL;
CREATE UNIQUE INDEX users_token_idx ON users (token);

-- ========================================================================
-- 7. Re-create FK constraints on all child tables (now referencing uuid PK)
-- ========================================================================

ALTER TABLE books ADD CONSTRAINT books_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE reading_progress ADD CONSTRAINT reading_progress_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE bookmarks ADD CONSTRAINT bookmarks_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE highlights ADD CONSTRAINT highlights_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE notes ADD CONSTRAINT notes_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE lookup_providers ADD CONSTRAINT lookup_providers_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE tts_jobs ADD CONSTRAINT tts_jobs_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE collections ADD CONSTRAINT collections_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE reading_sessions ADD CONSTRAINT reading_sessions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE sync_log ADD CONSTRAINT sync_log_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE email_verifications ADD CONSTRAINT email_verifications_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ========================================================================
-- 8. Re-create all indexes
-- ========================================================================

CREATE INDEX books_user_idx ON books (user_id);
CREATE UNIQUE INDEX books_user_file_idx ON books (user_id, file_id);
CREATE UNIQUE INDEX progress_unique_idx ON reading_progress (book_id, user_id, device_id);
CREATE INDEX bookmarks_user_idx ON bookmarks (user_id);
CREATE INDEX highlights_user_idx ON highlights (user_id);
CREATE INDEX notes_user_idx ON notes (user_id);
CREATE INDEX tts_jobs_user_idx ON tts_jobs (user_id);
CREATE INDEX collections_user_idx ON collections (user_id);
CREATE INDEX reading_sessions_user_idx ON reading_sessions (user_id);
CREATE INDEX reading_sessions_user_started_idx ON reading_sessions (user_id, started_at);
CREATE INDEX sync_log_user_ts_idx ON sync_log (user_id, "timestamp");

-- ========================================================================
-- 9. Add partial unique index on verified emails
-- ========================================================================

CREATE UNIQUE INDEX users_email_verified_unique ON users (email)
  WHERE email_verified_at IS NOT NULL;

COMMIT;
