-- 006_discogs_arrays_to_release_tags.sql
-- Normalize Discogs genres/styles arrays into release_tags rows so they can be voted on.
-- Non-destructive: keeps releases.discogs_genres/styles arrays intact.

BEGIN;

-- 1) Ensure all Discogs genre names exist in tags table
INSERT INTO tags (name)
SELECT DISTINCT trim(x) AS name
FROM releases r
CROSS JOIN LATERAL unnest(COALESCE(r.discogs_genres, ARRAY[]::text[])) AS x
WHERE trim(COALESCE(x, '')) <> ''
ON CONFLICT (name) DO NOTHING;

-- 2) Ensure all Discogs style names exist in tags table
INSERT INTO tags (name)
SELECT DISTINCT trim(x) AS name
FROM releases r
CROSS JOIN LATERAL unnest(COALESCE(r.discogs_styles, ARRAY[]::text[])) AS x
WHERE trim(COALESCE(x, '')) <> ''
ON CONFLICT (name) DO NOTHING;

-- 3) Link releases <-> tags for Discogs genres (source='discogs_genre')
INSERT INTO release_tags (release_id, tag_id, source, created_by_account_id)
SELECT
  r.id AS release_id,
  t.id AS tag_id,
  'discogs_genre' AS source,
  NULL::integer AS created_by_account_id
FROM releases r
CROSS JOIN LATERAL unnest(COALESCE(r.discogs_genres, ARRAY[]::text[])) AS x
JOIN tags t ON t.name = trim(x)
WHERE trim(COALESCE(x, '')) <> ''
ON CONFLICT DO NOTHING;

-- 4) Link releases <-> tags for Discogs styles (source='discogs_style')
INSERT INTO release_tags (release_id, tag_id, source, created_by_account_id)
SELECT
  r.id AS release_id,
  t.id AS tag_id,
  'discogs_style' AS source,
  NULL::integer AS created_by_account_id
FROM releases r
CROSS JOIN LATERAL unnest(COALESCE(r.discogs_styles, ARRAY[]::text[])) AS x
JOIN tags t ON t.name = trim(x)
WHERE trim(COALESCE(x, '')) <> ''
ON CONFLICT DO NOTHING;

COMMIT;
