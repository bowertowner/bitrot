-- =====================================================================
-- Bitrot Migration 002 — Discogs Integration Schema
-- =====================================================================

-- Enable required extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------
-- Table: discogs_entities
-- Caches API responses from Discogs (release, master, artist, label).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discogs_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    discogs_id INTEGER NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('artist','release','master','label','search_result')),

    raw_json JSONB NOT NULL,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT discogs_entities_unique UNIQUE(discogs_id, entity_type)
);

-- ---------------------------------------------------------------------
-- Table: release_discogs_matches
-- Stores machine- or manually-generated matches for Bitrot releases.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS release_discogs_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    release_id UUID NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    discogs_release_id INTEGER NULL,
    discogs_master_id INTEGER NULL,

    confidence_score REAL NOT NULL,
    match_method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'matched'
        CHECK (status IN ('matched','suggested','rejected')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS release_discogs_matches_release_id_idx
    ON release_discogs_matches (release_id);

CREATE INDEX IF NOT EXISTS release_discogs_matches_discogs_release_id_idx
    ON release_discogs_matches (discogs_release_id);

CREATE INDEX IF NOT EXISTS release_discogs_matches_discogs_master_id_idx
    ON release_discogs_matches (discogs_master_id);


-- ---------------------------------------------------------------------
-- Alter: releases table
-- Adds Discogs enrichment columns.
-- ---------------------------------------------------------------------
ALTER TABLE releases
    ADD COLUMN IF NOT EXISTS discogs_release_id INTEGER NULL;

ALTER TABLE releases
    ADD COLUMN IF NOT EXISTS discogs_master_id INTEGER NULL;

ALTER TABLE releases
    ADD COLUMN IF NOT EXISTS discogs_matched_at TIMESTAMPTZ NULL;

ALTER TABLE releases
    ADD COLUMN IF NOT EXISTS discogs_confidence REAL NULL;
