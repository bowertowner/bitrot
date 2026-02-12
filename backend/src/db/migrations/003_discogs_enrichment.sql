-- =====================================================================
-- Bitrot Migration 003 — Discogs Enrichment Columns (Option #1)
-- Adds Discogs-derived metadata to releases as separate columns.
-- Non-destructive: adds columns only.
-- =====================================================================

ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS discogs_genres TEXT[] NULL;

ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS discogs_styles TEXT[] NULL;

ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS discogs_cover_image_url TEXT NULL;

ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS discogs_country TEXT NULL;

ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS discogs_labels TEXT[] NULL;

-- Rating average in Discogs is typically a float like 3.87
ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS discogs_rating_average REAL NULL;

ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS discogs_rating_count INTEGER NULL;

ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS discogs_refreshed_at TIMESTAMPTZ NULL;

-- Helpful indexes (safe, optional, but recommended for filtering later)
-- GIN indexes support array containment queries efficiently.
CREATE INDEX IF NOT EXISTS releases_discogs_genres_gin_idx
  ON releases USING GIN (discogs_genres);

CREATE INDEX IF NOT EXISTS releases_discogs_styles_gin_idx
  ON releases USING GIN (discogs_styles);

CREATE INDEX IF NOT EXISTS releases_discogs_labels_gin_idx
  ON releases USING GIN (discogs_labels);
