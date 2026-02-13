-- 004_accounts_and_tag_votes.sql
-- Adds: accounts, account_sessions, release_tag_votes
-- Extends: release_tags with created_by_account_id + created_at
-- Safe: does not modify releases/tracks core behavior.

BEGIN;

-- 1) Accounts (separate from legacy Spotify users table)
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,

  -- Preserve the user’s chosen capitalization + spacing for display
  username_display TEXT NOT NULL,

  -- Canonical for uniqueness (store lowercased/normalized in app layer)
  username_canonical TEXT NOT NULL UNIQUE,

  -- Email is NOT unique (per your decision)
  email TEXT NOT NULL,

  -- bcrypt/argon hash stored here (never plaintext)
  password_hash TEXT NOT NULL,

  is_admin BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Username allowed chars: letters/numbers/space/_/-
  -- (We keep this simple; app should validate more strictly too.)
  CONSTRAINT accounts_username_display_chars_check
    CHECK (username_display ~ '^[A-Za-z0-9 _-]+$'),

  CONSTRAINT accounts_username_display_len_check
    CHECK (length(username_display) >= 3 AND length(username_display) <= 32),

  CONSTRAINT accounts_username_canonical_len_check
    CHECK (length(username_canonical) >= 3 AND length(username_canonical) <= 32),

  CONSTRAINT accounts_email_len_check
    CHECK (length(email) >= 3 AND length(email) <= 320),

  -- very light email sanity check (not full RFC)
  CONSTRAINT accounts_email_basic_check
    CHECK (position('@' in email) > 1)
);

CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_username_display ON accounts(username_display);

-- 2) Sessions (server-side cookie sessions; 7-day expiry handled in app)
-- We use uuid_generate_v4() since your DB already uses it for releases IDs.
CREATE TABLE IF NOT EXISTS account_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,

  -- optional diagnostics (helpful for debugging)
  ip TEXT NULL,
  user_agent TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_sessions_account_id ON account_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_account_sessions_expires_at ON account_sessions(expires_at);

-- 3) Extend release_tags to support "user added" tags and basic audit
-- (Do NOT change existing behavior; just add columns)
ALTER TABLE release_tags
  ADD COLUMN IF NOT EXISTS created_by_account_id INTEGER NULL REFERENCES accounts(id) ON DELETE SET NULL;

ALTER TABLE release_tags
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_release_tags_created_by_account_id
  ON release_tags(created_by_account_id);

-- 4) Votes on tags (for any tag on any release: bandcamp/discogs/user)
CREATE TABLE IF NOT EXISTS release_tag_votes (
  id SERIAL PRIMARY KEY,
  release_tag_id INTEGER NOT NULL REFERENCES release_tags(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT release_tag_votes_unique_vote UNIQUE (release_tag_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_release_tag_votes_release_tag_id
  ON release_tag_votes(release_tag_id);

CREATE INDEX IF NOT EXISTS idx_release_tag_votes_account_id
  ON release_tag_votes(account_id);

COMMIT;
