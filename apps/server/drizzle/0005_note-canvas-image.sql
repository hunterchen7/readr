-- Migration: Store captured handwritten note canvas images.
--
-- Supernote can draw directly through the e-ink framebuffer, so the
-- captured PNG data URI is the authoritative visual for handwritten
-- notes. Stroke JSON remains useful as a fallback/editing model, but
-- sync needs a server column for the captured image.

BEGIN;

ALTER TABLE notes ADD COLUMN IF NOT EXISTS canvas_image text;

COMMIT;
