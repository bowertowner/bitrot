import express from "express";
import pool from "../db/pool.js";

const router = express.Router();

/**
 * GET /stats/summary
 * Returns:
 *  - total_releases
 *  - unique_artists
 *  - total_tracks
 *  - total_free_releases
 *  - total_free_tracks   (tracks whose parent release is_free = true)
 */
router.get("/summary", async (req, res) => {
  try {
    const [
      releasesResult,
      artistsResult,
      tracksResult,
      freeReleasesResult,
      freeTracksResult,
    ] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM releases"),
      pool.query("SELECT COUNT(DISTINCT artist_name)::int AS count FROM releases"),
      pool.query("SELECT COUNT(*)::int AS count FROM tracks"),
      pool.query("SELECT COUNT(*)::int AS count FROM releases WHERE is_free = true"),
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM tracks t
        JOIN releases r ON r.id = t.release_id
        WHERE r.is_free = true
      `),
    ]);

    res.json({
      total_releases: releasesResult.rows[0]?.count ?? 0,
      unique_artists: artistsResult.rows[0]?.count ?? 0,
      total_tracks: tracksResult.rows[0]?.count ?? 0,
      total_free_releases: freeReleasesResult.rows[0]?.count ?? 0,
      total_free_tracks: freeTracksResult.rows[0]?.count ?? 0,
    });
  } catch (err) {
    console.error("Error in /stats/summary:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
