// backend/src/routes/release.js

import express from "express";
import pool from "../db/pool.js";
import { matchDiscogsForRelease } from "../services/discogsMatcher.js";
import { enqueueDiscogsJob, getDiscogsQueueStats } from "../services/discogsQueue.js";

const router = express.Router();

/**
 * POST /release/lookup
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
      error: "artist, title, platform, and platform_release_id are required fields",
    });
  }

  try {
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
      releaseId = existingSource.rows[0].release_id;

      await pool.query(
        `
        UPDATE releases
        SET
          artist_name  = COALESCE($1, artist_name),
          title        = COALESCE($2, title),
          release_date = COALESCE($3, release_date),
          price_label  = COALESCE($4, price_label),
          is_free      = COALESCE($5, is_free)
        WHERE id = $6
        `,
        [artist, title, release_date || null, price_label || null, is_free, releaseId]
      );

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
      const insertRelease = await pool.query(
        `
        INSERT INTO releases (artist_name, title, release_date, price_label, is_free)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        `,
        [artist, title, release_date || null, price_label || null, is_free]
      );
      releaseId = insertRelease.rows[0].id;

      await pool.query(
        `
        INSERT INTO release_sources (release_id, platform, platform_release_id, url)
        VALUES ($1, $2, $3, $4)
        `,
        [releaseId, platform, platform_release_id, url || null]
      );
    }

    // Tracks
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

    // Tags
    if (Array.isArray(tags) && tags.length > 0) {
      for (const rawTag of tags) {
        const tagName = (rawTag || "").trim();
        if (!tagName) continue;

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

    // Respond immediately
    res.json({ release_id: releaseId });

    // Fire-and-forget Discogs match (queued)
    pool
      .query(`SELECT id, title, artist_name, release_date FROM releases WHERE id = $1`, [
        releaseId,
      ])
      .then((r) => r.rows[0])
      .then((releaseRow) => {
        if (!releaseRow) return;

        const stats = getDiscogsQueueStats();
        if ((stats.queued + stats.active) % 50 === 0) {
          console.warn("[DiscogsQueue] stats:", stats);
        }

        enqueueDiscogsJob(() => matchDiscogsForRelease(releaseRow)).catch((e) => {
          console.error("[Discogs] background match failed:", e?.message || e);
        });
      })
      .catch((e) => {
        console.error("[Discogs] failed to load release for background match:", e);
      });
  } catch (err) {
    console.error("Error in /release/lookup:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
