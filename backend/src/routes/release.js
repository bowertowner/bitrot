// backend/src/routes/release.js

import express from "express";
import pool from "../db/pool.js";
import { matchDiscogsForRelease } from "../services/discogsMatcher.js";
import { enqueueDiscogsJob, getDiscogsQueueStats } from "../services/discogsQueue.js";

const router = express.Router();

/**
 * Build a Bandcamp embed src from item_type + item_id.
 * We store it so the frontend doesn't need to format anything.
 *
 * Bandcamp official embed patterns:
 *   https://bandcamp.com/EmbeddedPlayer/album=<ID>/...
 *   https://bandcamp.com/EmbeddedPlayer/track=<ID>/...
 */
function buildBandcampEmbedSrc(itemType, itemId) {
  if (!itemType || !itemId) return null;

  const t = String(itemType).trim();
  const id = Number(itemId);

  if (!Number.isFinite(id) || id <= 0) return null;

  // Bandcamp commonly uses item_type "a" (album) and "t" (track)
  const kind = t === "t" ? "track" : "album";

  // Use a stable, reasonable default player. Frontend can override sizing if needed.
  return `https://bandcamp.com/EmbeddedPlayer/${kind}=${id}/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/transparent=true/`;
}

/**
 * Coerce a possibly-empty value to null.
 */
function toNullIfEmpty(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

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

    // NEW (optional / backward compatible)
    bandcamp_item_type,
    bandcamp_item_id,
    bandcamp_art_url,
  } = req.body;

  if (!artist || !title || !platform || !platform_release_id) {
    return res.status(400).json({
      error: "artist, title, platform, and platform_release_id are required fields",
    });
  }

  // Normalize incoming Bandcamp fields (only apply when platform=bandcamp)
  let bcType = null;
  let bcId = null;
  let bcEmbedSrc = null;
  let bcArtUrl = null;

  if (String(platform).toLowerCase() === "bandcamp") {
    bcType = toNullIfEmpty(bandcamp_item_type);

    const maybeId =
      bandcamp_item_id === undefined || bandcamp_item_id === null
        ? null
        : Number(bandcamp_item_id);

    bcId = Number.isFinite(maybeId) && maybeId > 0 ? maybeId : null;

    // Validate type against your DB CHECK constraint: only 'a' or 't'
    if (bcType !== null && bcType !== "a" && bcType !== "t") {
      // Don't fail ingestion; just ignore invalid value
      console.warn("[/release/lookup] Ignoring invalid bandcamp_item_type:", bcType);
      bcType = null;
    }

    bcArtUrl = toNullIfEmpty(bandcamp_art_url);

    // Only generate embed src if we have BOTH
    bcEmbedSrc = buildBandcampEmbedSrc(bcType, bcId);
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

      // Update core fields + NEW bandcamp embed fields (backfill-on-encounter)
      await pool.query(
        `
        UPDATE releases
        SET
          artist_name  = COALESCE($1, artist_name),
          title        = COALESCE($2, title),
          release_date = COALESCE($3, release_date),
          price_label  = COALESCE($4, price_label),
          is_free      = COALESCE($5, is_free),

          -- NEW bandcamp embed/art fields
          bandcamp_item_type = COALESCE($6, bandcamp_item_type),
          bandcamp_item_id   = COALESCE($7, bandcamp_item_id),
          bandcamp_embed_src = COALESCE($8, bandcamp_embed_src),
          bandcamp_art_url   = COALESCE($9, bandcamp_art_url)

        WHERE id = $10
        `,
        [
          artist,
          title,
          release_date || null,
          price_label || null,
          is_free,

          bcType,
          bcId,
          bcEmbedSrc,
          bcArtUrl,

          releaseId,
        ]
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
        INSERT INTO releases (
          artist_name,
          title,
          release_date,
          price_label,
          is_free,

          -- NEW bandcamp embed/art fields
          bandcamp_item_type,
          bandcamp_item_id,
          bandcamp_embed_src,
          bandcamp_art_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        `,
        [
          artist,
          title,
          release_date || null,
          price_label || null,
          is_free,

          bcType,
          bcId,
          bcEmbedSrc,
          bcArtUrl,
        ]
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
      .query(`SELECT id, title, artist_name, release_date FROM releases WHERE id = $1`, [releaseId])
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
