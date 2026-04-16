-- Migration: Backfill `finished: true` into reading_progress.position
--
-- "Finished" is now an explicit boolean on BookPosition, decoupled from
-- percentage so re-opening a finished book lands at the user's actual
-- last-read CFI instead of page 0 / 100%. Existing rows at >=100% pre-
-- date the flag — backfill them so the library / detail UI doesn't have
-- to fall back to the percentage threshold forever.
--
-- Idempotent: skips rows that already carry the flag.

BEGIN;

UPDATE reading_progress
SET position = jsonb_set(position, '{finished}', 'true', true)
WHERE COALESCE((position ->> 'percentage')::numeric, 0) >= 100
  AND COALESCE((position ->> 'finished')::boolean, false) = false;

COMMIT;
