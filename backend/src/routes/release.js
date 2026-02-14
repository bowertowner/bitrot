// backend/src/routes/release.js

import express from "express";
import pool from "../db/pool.js";
import { matchDiscogsForRelease } from "../services/discogsMatcher.js";
import {
  enqueueDiscogsJob,
  getDiscogsQueueStats,
} from "../services/discogsQueue.js";
import { requireAuth, requireAdmin } from "../middleware/authSession.js";

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
    await pool.query("BEGIN");

    // Find or create release by (platform, platform_release_id)
    const existing = await pool.query(
      `
      SELECT r.id
      FROM releases r
      JOIN release_sources rs ON rs.release_id = r.id
      WHERE rs.platform = $1 AND rs.platform_release_id = $2
      LIMIT 1
      `,
      [platform, platform_release_id]
    );

    let releaseId;

    if (existing.rows.length > 0) {
      releaseId = existing.rows[0].id;

      // Update core release fields safely (keep existing if null)
      await pool.query(
        `
        UPDATE releases
        SET
          artist_name = COALESCE($1, artist_name),
          title = COALESCE($2, title),
          release_date = COALESCE($3, release_date),
          price_label = COALESCE($4, price_label),
          is_free = COALESCE($5, is_free),

          bandcamp_item_type = COALESCE($6, bandcamp_item_type),
          bandcamp_item_id = COALESCE($7, bandcamp_item_id),
          bandcamp_embed_src = COALESCE($8, bandcamp_embed_src),
          bandcamp_art_url = COALESCE($9, bandcamp_art_url)
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

          -- bandcamp embed/art fields
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

    // Tags (Bandcamp ingestion)
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
          ON CONFLICT (release_id, tag_id) DO NOTHING
          `,
          [releaseId, tagId, platform]
        );
      }
    }

    await pool.query("COMMIT");

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
    await pool.query("ROLLBACK").catch(() => {});
    console.error("Error in /release/lookup:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /release/:id/stickers
 * Body: { tag_name } OR { tag_id }
 *
 * Rules:
 * - Must be logged in
 * - Tag must already exist in tags table (no new tag creation)
 * - No duplicates per release (regardless of source) thanks to unique(release_id, tag_id)
 * - Stored as source='user' and created_by_account_id=current user
 */
router.post("/:id/stickers", requireAuth, async (req, res) => {
  const releaseId = req.params.id;
  const { tag_name, tag_id } = req.body || {};

  try {
    // validate release exists
    const rel = await pool.query(`SELECT id FROM releases WHERE id = $1`, [releaseId]);
    if (rel.rows.length === 0) return res.status(404).json({ error: "Release not found" });

    let tagId = null;

    if (tag_id != null && String(tag_id).trim() !== "") {
      const n = Number(tag_id);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: "tag_id must be a positive number" });
      }
      const t = await pool.query(`SELECT id FROM tags WHERE id = $1`, [n]);
      if (t.rows.length === 0) return res.status(400).json({ error: "Tag does not exist" });
      tagId = n;
    } else {
      const name = String(tag_name || "").trim();
      if (!name) return res.status(400).json({ error: "tag_name or tag_id is required" });

      // Tag must already exist (case-insensitive match for UX)
      const t = await pool.query(
        `SELECT id FROM tags WHERE lower(name) = lower($1) LIMIT 1`,
        [name]
      );
      if (t.rows.length === 0) {
        return res.status(400).json({ error: "Tag does not exist (must choose from dropdown)" });
      }
      tagId = t.rows[0].id;
    }

    const insert = await pool.query(
      `
      INSERT INTO release_tags (release_id, tag_id, source, created_by_account_id)
      VALUES ($1, $2, 'user', $3)
      ON CONFLICT (release_id, tag_id) DO NOTHING
      RETURNING id
      `,
      [releaseId, tagId, req.account.id]
    );

    if (insert.rows.length === 0) {
      // already attached by any source
      return res.status(409).json({ error: "Tag already attached to this release" });
    }

    return res.json({ ok: true, release_tag_id: insert.rows[0].id });
  } catch (err) {
    console.error("POST /release/:id/stickers error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /release/:id/stickers/:release_tag_id
 *
 * Rules:
 * - Must be logged in
 * - Can only remove if:
 *   - source='user'
 *   - created_by_account_id matches current user
 *   - total votes on that (release_tag) is 0
 */
router.delete("/:id/stickers/:release_tag_id", requireAuth, async (req, res) => {
  const releaseId = req.params.id;
  const releaseTagId = Number(req.params.release_tag_id);

  if (!Number.isFinite(releaseTagId) || releaseTagId <= 0) {
    return res.status(400).json({ error: "Invalid release_tag_id" });
  }

  try {
    const rt = await pool.query(
      `
      SELECT id, release_id, source, created_by_account_id
      FROM release_tags
      WHERE id = $1 AND release_id = $2
      `,
      [releaseTagId, releaseId]
    );

    if (rt.rows.length === 0) return res.status(404).json({ error: "Sticker not found" });

    const row = rt.rows[0];
    if (row.source !== "user") {
      return res.status(403).json({ error: "Only user stickers can be removed" });
    }
    if (row.created_by_account_id !== req.account.id) {
      return res.status(403).json({ error: "You can only remove your own stickers" });
    }

    const votes = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE vote_value = 1)::int AS upvotes,
        COUNT(*) FILTER (WHERE vote_value = -1)::int AS downvotes,
        MAX(CASE WHEN account_id = $2 THEN vote_value ELSE NULL END)::int AS my_vote_value
      FROM release_tag_votes
      WHERE release_tag_id = $1
      `,
      [releaseTagId, req.account.id]
    );

    const upvotes = Number(votes.rows[0]?.upvotes ?? 0);
    const myVote = votes.rows[0]?.my_vote_value == null ? 0 : Number(votes.rows[0].my_vote_value);

    // New rule:
    // - creator can remove if there are NO upvotes
    // - and creator has NOT voted on it (no self up/down vote)
    if (upvotes > 0) {
      return res.status(409).json({ error: "Cannot remove sticker: it has upvotes" });
    }
    if (myVote !== 0) {
      return res.status(409).json({ error: "Cannot remove sticker: you have already voted on it" });
    }

    await pool.query(`DELETE FROM release_tags WHERE id = $1`, [releaseTagId]);
    return res.json({ ok: true });

  } catch (err) {
    console.error("DELETE /release/:id/stickers/:release_tag_id error:", err);
    return res.status(500).json({ error: "Internal server error" });
    
  }
});

/**
 * DELETE /release/:id/stickers/:release_tag_id/admin
 *
 * Admin override: remove any user sticker even if it has votes.
 * Rules:
 * - Must be admin
 * - Only applies to source='user' attachments
 * - Must belong to the release in the URL
 */
router.delete("/:id/stickers/:release_tag_id/admin", requireAdmin, async (req, res) => {
  const releaseId = req.params.id;
  const releaseTagId = Number(req.params.release_tag_id);

  if (!Number.isFinite(releaseTagId) || releaseTagId <= 0) {
    return res.status(400).json({ error: "Invalid release_tag_id" });
  }

  try {
    const rt = await pool.query(
      `
      SELECT id, release_id, source
      FROM release_tags
      WHERE id = $1 AND release_id = $2
      `,
      [releaseTagId, releaseId]
    );

    if (rt.rows.length === 0) {
      return res.status(404).json({ error: "Sticker not found" });
    }

    const row = rt.rows[0];
    if (row.source !== "user") {
      return res.status(403).json({ error: "Admin override only applies to user stickers" });
    }

    // Cascades will remove votes automatically via FK on release_tag_votes
    await pool.query(`DELETE FROM release_tags WHERE id = $1`, [releaseTagId]);

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /release/:id/stickers/:release_tag_id/admin error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /release/:id/tags/:release_tag_id/vote
 * Body: { value: 1 } or { value: -1 }
 *
 * Rules:
 * - Must be logged in
 * - For non-user sources (bandcamp/discogs_genre/discogs_style): only value=1 allowed
 * - For user stickers: value can be 1 or -1
 * - One vote per user per release_tag_id (upsert)
 */
 
router.post("/:id/tags/:release_tag_id/vote", requireAuth, async (req, res) => {
  const releaseId = req.params.id;
  const releaseTagId = Number(req.params.release_tag_id);
  const value = Number(req.body?.value);

  if (!Number.isFinite(releaseTagId) || releaseTagId <= 0) {
    return res.status(400).json({ error: "Invalid release_tag_id" });
  }
  if (value !== 1 && value !== -1) {
    return res.status(400).json({ error: "Vote value must be 1 or -1" });
  }

  try {
    const rt = await pool.query(
      `
      SELECT id, release_id, source
      FROM release_tags
      WHERE id = $1 AND release_id = $2
      `,
      [releaseTagId, releaseId]
    );
    if (rt.rows.length === 0) return res.status(404).json({ error: "Tag attachment not found" });

    const source = rt.rows[0].source;

    // Only user stickers can be downvoted
    if (value === -1 && source !== "user") {
      return res.status(403).json({ error: "Only user stickers can be downvoted" });
    }

    await pool.query(
      `
      INSERT INTO release_tag_votes (release_tag_id, account_id, vote_value)
      VALUES ($1, $2, $3)
      ON CONFLICT (release_tag_id, account_id)
      DO UPDATE SET vote_value = EXCLUDED.vote_value
      `,
      [releaseTagId, req.account.id, value]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /release/:id/tags/:release_tag_id/vote error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /release/:id/tags/:release_tag_id/vote
 * Undo current user's vote (if any)
 */
 
router.delete("/:id/tags/:release_tag_id/vote", requireAuth, async (req, res) => {
  const releaseId = req.params.id;
  const releaseTagId = Number(req.params.release_tag_id);

  if (!Number.isFinite(releaseTagId) || releaseTagId <= 0) {
    return res.status(400).json({ error: "Invalid release_tag_id" });
  }

  try {
    // Ensure the attachment belongs to this release (avoid deleting votes via mismatched URL)
    const rt = await pool.query(
      `
      SELECT id
      FROM release_tags
      WHERE id = $1 AND release_id = $2
      `,
      [releaseTagId, releaseId]
    );
    if (rt.rows.length === 0) return res.status(404).json({ error: "Tag attachment not found" });

    await pool.query(
      `
      DELETE FROM release_tag_votes
      WHERE account_id = $1
        AND release_tag_id = $2
      `,
      [req.account.id, releaseTagId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /release/:id/tags/:release_tag_id/vote error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
