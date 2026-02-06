// src/routes/stats.js
// Simple stats summary: total releases, unique artists, total tracks.

import express from "express";
import pool from "../db/pool.js";

const router = express.Router();

router.get("/summary", async (req, res) => {
  try {
    const [artistResult, trackResult, releaseResult] = await Promise.all([
      pool.query("SELECT COUNT(DISTINCT artist_name) AS count FROM releases"),
      pool.query("SELECT COUNT(*) AS count FROM tracks"),
      pool.query("SELECT COUNT(*) AS count FROM releases"),
    ]);

    const uniqueArtists = Number(artistResult.rows[0].count || 0);
    const totalTracks = Number(trackResult.rows[0].count || 0);
    const totalReleases = Number(releaseResult.rows[0].count || 0);

    res.json({
      total_releases: totalReleases,
      unique_artists: uniqueArtists,
      total_tracks: totalTracks,
    });
  } catch (err) {
    console.error("Error in /stats/summary:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
