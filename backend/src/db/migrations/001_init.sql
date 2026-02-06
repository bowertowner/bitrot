CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE releases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  release_date DATE,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE release_sources (
  id SERIAL PRIMARY KEY,
  release_id UUID REFERENCES releases(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  platform_release_id TEXT,
  url TEXT,
  UNIQUE (platform, platform_release_id)
);

CREATE TABLE tracks (
  id SERIAL PRIMARY KEY,
  release_id UUID REFERENCES releases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  duration INTEGER,
  spotify_track_id TEXT
);

CREATE TABLE artists (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE release_tags (
  release_id UUID REFERENCES releases(id) ON DELETE CASCADE,
  tag_id INTEGER REFERENCES tags(id),
  source TEXT
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  spotify_id TEXT UNIQUE,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE user_encounters (
  user_id INTEGER REFERENCES users(id),
  release_id UUID REFERENCES releases(id),
  timestamp TIMESTAMP DEFAULT now(),
  source TEXT
);
