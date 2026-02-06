import express from "express";
import pool from "../db/pool.js";

const router = express.Router();

/**
 * POST /user_encounter
 *
 * Body:
 *  - release_id (required, UUID of the release)
 *  - user_id (optional, reserved for future logged-in users)
 *  - source  (optional, "extension" | "site" | etc; defaults to "extension")
 *
 * For MVP:
 *  - We only ever insert ONE encounter row per release.
 *    Refreshing the page or re-visiting the same release does NOT create
 *    additional rows. This avoids inflated counts from the same human.
 *
 *  Later we can evolve this into per-user uniqueness once we have
 *  stable user IDs (Bitrot accounts or anonymous IDs from extensions).
 */
router.post("/", async (req, res) => {
  const { user_id, release_id, source } = req.body;

  if (!release_id) {
    return res.status(400).json({ error: "release_id is required" });
  }

  const userId = user_id ?? null;
  const encounterSource = source || "extension";

  try {
    const result = await pool.query(
      `
      INSERT INTO user_encounters (user_id, release_id, timestamp, source)
      SELECT $1, $2, NOW(), $3
      WHERE NOT EXISTS (
        SELECT 1
        FROM user_encounters
        WHERE release_id = $2
      )
      `,
      [userId, release_id, encounterSource]
    );

    const inserted = result.rowCount > 0;

    res.json({ ok: true, inserted });
  } catch (err) {
    console.error("Error logging user_encounter:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
