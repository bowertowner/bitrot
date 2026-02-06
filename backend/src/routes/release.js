import express from "express";
import pool from "../db/pool.js";

const router = express.Router();

/**
 * POST /release/lookup
 *
 * Input body (from the extensions):
 *  - artist                (string, required)
 *  - title                 (string, required)
 *  - platform              ("bandcamp" | "spotify" | "archive" | etc.)
 *  - platform_release_id   (string, required)  // e.g. Bandcamp URL
 *  - url                   (string, optional but recommended)
 *  - release_date          (string/ISO, optional)
 *  - tags                  (array of strings, optional)
 *  - tracks                (array of { title, duration, spotify_track_id? }, optional)
 *  - price_label           (string, e.g. "FREE DL", "£7+", etc., optional)
 *  - is_free               (boolean | null, optional)
 *
 * Behavior:
 *  - If a release with this (platform, platform_release_id) already exists,
 *    re-use its Bitrot UUID and update basic info.
 *  - Otherwise, create a new release row and a matching release_sources row.
 *  - Insert tracks (if provided) under the release.
 *  - Insert / attach tags (normalized) under the release.
 */
router.post("/lookup", async (req, res) => {
  const {
    artist,
    title,
    platform,
    platform_release_id,
    url,
    release_date,
    tags,
    tracks,
    price_label,
    is_free,
  } = req.body;

  if (!artist || !title || !platform || !platform_release_id) {
    return res.status(400).json({
      error:
        "artist, title, platform, and platform_release_id are required fields",
    });
  }

  try {
    // 1) Check if we already know this release via release_sources
    const existingSource = await pool.query(
      `
      SELECT r.id AS release_id
      FROM release_sources rs
      JOIN releases r ON r.id = rs.release_id
      WHERE rs.platform = $1
        AND rs.platform_release_id = $2
      LIMIT 1
      `,
      [platform, platform_release_id]
    );

    let releaseId;

    if (existingSource.rows.length > 0) {
      // Re-use existing release id; update basic fields
      releaseId = existingSource.rows[0].release_id;

      await pool.query(
        `
        UPDATE releases
        SET
          artist_name = COALESCE($1, artist_name),
          title       = COALESCE($2, title),
          release_date = COALESCE($3, release_date),
          price_label  = COALESCE($4, price_label),
          is_free      = COALESCE($5, is_free)
        WHERE id = $6
        `,
        [artist, title, release_date || null, price_label || null, is_free, releaseId]
      );

      // Optionally update the URL in release_sources
      if (url) {
        await pool.query(
          `
          UPDATE release_sources
          SET url = $1
          WHERE platform = $2
            AND platform_release_id = $3
            AND release_id = $4
          `,
          [url, platform, platform_release_id, releaseId]
        );
      }
    } else {
      // 2) Create a brand new release
      const insertRelease = await pool.query(
        `
        INSERT INTO releases (artist_name, title, release_date, price_label, is_free)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        `,
        [artist, title, release_date || null, price_label || null, is_free]
      );
      releaseId = insertRelease.rows[0].id;

      // Link it to its source (Bandcamp / Spotify / etc.)
      await pool.query(
        `
        INSERT INTO release_sources (release_id, platform, platform_release_id, url)
        VALUES ($1, $2, $3, $4)
        `,
        [releaseId, platform, platform_release_id, url || null]
      );
    }

    // 3) Tracks (if any)
    if (Array.isArray(tracks) && tracks.length > 0) {
      for (const t of tracks) {
        const trackTitle = t.title || null;
        if (!trackTitle) continue;

        const duration = typeof t.duration === "number" ? t.duration : null;
        const spotifyTrackId = t.spotify_track_id || null;

        await pool.query(
          `
          INSERT INTO tracks (release_id, title, duration, spotify_track_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (release_id, title)
          DO UPDATE SET
            duration = EXCLUDED.duration,
            spotify_track_id = COALESCE(EXCLUDED.spotify_track_id, tracks.spotify_track_id)
          `,
          [releaseId, trackTitle, duration, spotifyTrackId]
        );
      }
    }

    // 4) Tags (if any)
    if (Array.isArray(tags) && tags.length > 0) {
      for (const rawTag of tags) {
        const tagName = (rawTag || "").trim();
        if (!tagName) continue;

        // Upsert tag name
        const tagResult = await pool.query(
          `
          INSERT INTO tags (name)
          VALUES ($1)
          ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
          `,
          [tagName]
        );
        const tagId = tagResult.rows[0].id;

        // Link tag to release, with source = platform (e.g. "bandcamp" or "spotify")
        await pool.query(
          `
          INSERT INTO release_tags (release_id, tag_id, source)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
          `,
          [releaseId, tagId, platform]
        );
      }
    }

    return res.json({ release_id: releaseId });
  } catch (err) {
    console.error("Error in /release/lookup:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /release/:id
 *
 * Returns a single release with:
 *  - core fields (artist, title, date, price, is_free)
 *  - primary URL (if any)
 *  - tags (as an array of strings)
 *  - tracks (with duration + spotify_track_id)
 *  - audio_features if present (joined by spotify_track_id)
 *
 * This is what the Spotify overlap UI and future detail pages will call.
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // 1) Base release + primary URL
    const releaseResult = await pool.query(
      `
      SELECT
        r.id,
        r.title,
        r.artist_name,
        r.release_date,
        r.price_label,
        r.is_free,
        rs.url
      FROM releases r
      LEFT JOIN LATERAL (
        SELECT url
        FROM release_sources
        WHERE release_id = r.id
        ORDER BY id ASC
        LIMIT 1
      ) rs ON TRUE
      WHERE r.id = $1
      LIMIT 1
      `,
      [id]
    );

    if (releaseResult.rows.length === 0) {
      return res.status(404).json({ error: "Release not found" });
    }

    const releaseRow = releaseResult.rows[0];

    // 2) Tags
    const tagsResult = await pool.query(
      `
      SELECT t.name
      FROM release_tags rt
      JOIN tags t ON t.id = rt.tag_id
      WHERE rt.release_id = $1
      ORDER BY t.name ASC
      `,
      [id]
    );
    const tags = tagsResult.rows.map((r) => r.name);

    // 3) Tracks + audio_features
    const tracksResult = await pool.query(
      `
      SELECT
        tr.id,
        tr.title,
        tr.duration,
        tr.spotify_track_id,
        af.tempo,
        af."key",
        af.mode,
        af.danceability,
        af.energy,
        af.valence,
        af.acousticness
      FROM tracks tr
      LEFT JOIN audio_features af
        ON af.spotify_track_id = tr.spotify_track_id
      WHERE tr.release_id = $1
      ORDER BY tr.id ASC
      `,
      [id]
    );

    const tracks = tracksResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      duration: row.duration,
      spotify_track_id: row.spotify_track_id,
      audio_features:
        row.spotify_track_id && row.tempo !== null
          ? {
              tempo: row.tempo,
              key: row.key,
              mode: row.mode,
              danceability: row.danceability,
              energy: row.energy,
              valence: row.valence,
              acousticness: row.acousticness,
            }
          : null,
    }));

    return res.json({
      id: releaseRow.id,
      artist_name: releaseRow.artist_name,
      title: releaseRow.title,
      release_date: releaseRow.release_date,
      price_label: releaseRow.price_label,
      is_free: releaseRow.is_free,
      url: releaseRow.url,
      tags,
      tracks,
    });
  } catch (err) {
    console.error("Error in GET /release/:id:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
