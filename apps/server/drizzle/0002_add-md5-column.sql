-- Migration: Add md5 column to files table
--
-- Adds an md5 text column alongside the existing sha256. sha256 remains
-- the unique dedup key; md5 is stored for cross-reference with external
-- services (Anna's Archive etc.) that key on MD5.
--
-- The column is nullable because existing rows don't have a computed
-- md5 yet. Application code backfills md5 opportunistically whenever
-- anyone re-uploads a file that matches an existing sha256 row. You
-- can also backfill offline by streaming each file from S3, hashing,
-- and updating the row.

BEGIN;

ALTER TABLE files ADD COLUMN md5 TEXT;

-- Optional non-unique index for lookups by md5. Kept non-unique because
-- md5 collisions are theoretically possible (not that we expect any for
-- book-sized files in practice), and because the column is nullable —
-- a unique index would still work with nulls, but there's no correctness
-- benefit over a plain index for our lookup patterns.
CREATE INDEX IF NOT EXISTS files_md5_idx ON files (md5);

COMMIT;
