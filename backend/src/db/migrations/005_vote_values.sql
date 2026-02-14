-- 005_vote_values.sql
-- Adds vote_value (+1 / -1) to release_tag_votes to support upvotes + downvotes.
-- Backfills existing votes to +1.
-- Safe + forward-compatible.

BEGIN;

-- 1) Add vote_value column (default +1 so existing rows are treated as upvotes)
ALTER TABLE release_tag_votes
  ADD COLUMN IF NOT EXISTS vote_value INTEGER NOT NULL DEFAULT 1;

-- 2) Add/ensure constraint so only +1 or -1 are allowed
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'release_tag_votes_vote_value_check'
  ) THEN
    ALTER TABLE release_tag_votes
      ADD CONSTRAINT release_tag_votes_vote_value_check
      CHECK (vote_value IN (-1, 1));
  END IF;
END $$;

-- 3) Backfill any NULLs just in case (should be unnecessary with NOT NULL DEFAULT)
UPDATE release_tag_votes
SET vote_value = 1
WHERE vote_value IS NULL;

-- 4) Optional helpful index for counting up/down quickly (safe if it already exists)
CREATE INDEX IF NOT EXISTS idx_release_tag_votes_release_tag_id_vote_value
  ON release_tag_votes (release_tag_id, vote_value);

COMMIT;
