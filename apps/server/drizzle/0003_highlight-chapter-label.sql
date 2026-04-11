-- Migration: Add chapter_label and percentage to highlights
--
-- Highlights are pinned to a CFI range only, which is enough to place
-- the decoration back on the page but reads as a meaningless opaque
-- string in the bookmarks/notes drawer list. Capture a human-readable
-- "chapter · %" snapshot at creation time so the drawer can render
-- the same label format as notes.
--
-- Both columns are nullable so existing rows remain valid without a
-- backfill; the client treats null as "unknown" and falls back to the
-- highlight text or creation date.

BEGIN;

ALTER TABLE highlights ADD COLUMN chapter_label TEXT;
ALTER TABLE highlights ADD COLUMN percentage REAL;

COMMIT;
