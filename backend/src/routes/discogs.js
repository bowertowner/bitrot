// backend/src/routes/discogs.js

import express from "express";
import pool from "../db/pool.js";
import { matchDiscogsForRelease } from "../services/discogsMatcher.js";
import { enqueueDiscogsJob } from "../services/discogsQueue.js";

const router = express.Router();
const ONE_HOUR_MS = 60 * 60 * 1000;

async function getLatestMatchRow(releaseId) {
  const r = await pool.query(
    `
    SELECT *
    FROM release_discogs_matches
    WHERE release_id = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [releaseId]
  );
  return r.rows[0] || null;
}

/**
 * POST /discogs/match/:releaseId
 * - default: only run if last attempt > 1 hour ago
 * - force: ?force=1 bypasses cooldown and runs now
 */
router.post("/match/:releaseId", async (req, res) => {
  const { releaseId } = req.params;

  const force =
    String(req.query.force || "").trim() === "1" ||
    String(req.query.force || "").trim().toLowerCase() === "true";

  try {
    const rel = await pool.query(`SELECT * FROM releases WHERE id = $1`, [releaseId]);

    if (rel.rows.length === 0) {
      return res.status(404).json({ error: "Release not found" });
    }

    const latest = await getLatestMatchRow(releaseId);

    if (!force && latest?.created_at) {
      const ageMs = Date.now() - new Date(latest.created_at).getTime();
      if (ageMs < ONE_HOUR_MS) {
        return res.json({
          release_id: releaseId,
          status: latest.status,
          confidence_score: latest.confidence_score,
          discogs_release_id: latest.discogs_release_id,
          discogs_master_id: latest.discogs_master_id,
          skipped: true,
          skip_reason: "cooldown_1h",
        });
      }
    }

    const release = rel.rows[0];

    // Queue this work so we never exceed MAX_CONCURRENCY overall.
    const match = await enqueueDiscogsJob(() => matchDiscogsForRelease(release));

    return res.json({
      release_id: match.release_id || releaseId,
      status: match.status ?? "rejected",
      confidence_score: match.confidence_score ?? 0,
      discogs_release_id: match.discogs_release_id ?? null,
      discogs_master_id: match.discogs_master_id ?? null,
      skipped: false,
      skip_reason: null,
      debug: match.debug || undefined,
      refreshed: match.refreshed === true ? true : undefined,
    });
  } catch (err) {
    console.error("Error in POST /discogs/match/:releaseId", err);
    return res.status(500).json({ error: "Discogs match failed" });
  }
});

/**
 * GET /discogs/status?ids=<uuid,uuid,...>
 * Returns latest match info + rating fields.
 *
 * We prefer persisted releases.discogs_rating_* (new enrichment columns),
 * but fall back to cached discogs_entities raw_json if needed.
 */
router.get("/status", async (req, res) => {
  try {
    const idsParam = String(req.query.ids || "").trim();
    if (!idsParam) return res.json({});

    const ids = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) return res.json({});

    const q = `
      SELECT DISTINCT ON (m.release_id)
        m.release_id,
        m.status,
        m.confidence_score,
        m.discogs_release_id,
        m.discogs_master_id,
        m.created_at,

        -- Prefer persisted columns on releases
        r.discogs_rating_average AS persisted_rating_average,
        r.discogs_rating_count   AS persisted_rating_count,

        -- Fallback to cached release JSON
        (e.raw_json->'community'->'rating'->>'average')::float AS cached_rating_average,
        (e.raw_json->'community'->'rating'->>'count')::int     AS cached_rating_count

      FROM release_discogs_matches m
      LEFT JOIN releases r
        ON r.id = m.release_id
      LEFT JOIN discogs_entities e
        ON e.discogs_id = m.discogs_release_id
       AND e.entity_type = 'release'
      WHERE m.release_id = ANY($1::uuid[])
      ORDER BY m.release_id, m.created_at DESC
    `;

    const result = await pool.query(q, [ids]);

    const out = {};
    for (const row of result.rows) {
      const avg =
        row.persisted_rating_average != null
          ? row.persisted_rating_average
          : row.cached_rating_average != null
          ? row.cached_rating_average
          : null;

      const count =
        row.persisted_rating_count != null
          ? row.persisted_rating_count
          : row.cached_rating_count != null
          ? row.cached_rating_count
          : null;

      out[row.release_id] = {
        status: row.status,
        confidence_score: row.confidence_score,
        discogs_release_id: row.discogs_release_id,
        discogs_master_id: row.discogs_master_id,
        discogs_rating_average: avg,
        discogs_rating_count: count,
      };
    }

    return res.json(out);
  } catch (err) {
    console.error("Error in GET /discogs/status", err);
    return res.status(500).json({ error: "Failed to load Discogs status" });
  }
});

export default router;
