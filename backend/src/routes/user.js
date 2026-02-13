import express from "express";
import pool from "../db/pool.js";
import { canonicalizeUsername, requireAuth } from "../middleware/authSession.js";

const router = express.Router();

/**
 * GET /user/me
 * Requires login
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const accountId = req.account.id;

    const tagsCreated = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM release_tags
      WHERE created_by_account_id = $1
      `,
      [accountId]
    );

    return res.json({
      username: req.account.username_display,
      created_at: req.account.created_at,
      total_tags_created: tagsCreated.rows[0]?.count ?? 0,
      placeholders: {
        releases_ingested: null,
        encounters: null,
      },
    });
  } catch (err) {
    console.error("GET /user/me error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /user/:username
 * Public profile
 */
router.get("/:username", async (req, res) => {
  try {
    const usernameParam = String(req.params.username ?? "");
    const canonical = canonicalizeUsername(usernameParam);

    const acct = await pool.query(
      `
      SELECT id, username_display, created_at
      FROM accounts
      WHERE username_canonical = $1
      LIMIT 1
      `,
      [canonical]
    );

    if (acct.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const account = acct.rows[0];

    const tagsCreated = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM release_tags
      WHERE created_by_account_id = $1
      `,
      [account.id]
    );

    return res.json({
      username: account.username_display,
      created_at: account.created_at,
      total_tags_created: tagsCreated.rows[0]?.count ?? 0,
    });
  } catch (err) {
    console.error("GET /user/:username error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
