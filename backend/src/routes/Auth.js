import express from "express";
import bcrypt from "bcryptjs";
import pool from "../db/pool.js";
import {
  canonicalizeUsername,
  isValidUsernameDisplay,
  isValidEmail,
  passwordMeetsPolicy,
  createSession,
  clearSessionCookie,
  requireAdmin,
} from "../middleware/authSession.js";

const router = express.Router();

/**
 * GET /auth/me
 * Returns logged-in account (or null)
 */
router.get("/me", async (req, res) => {
  if (!req.account) return res.json(null);
  return res.json({
    id: req.account.id,
    username: req.account.username_display,
    is_admin: req.account.is_admin,
    created_at: req.account.created_at,
  });
});

/**
 * POST /auth/signup
 * body: { username, email, password }
 */
router.post("/signup", async (req, res) => {
  try {
    const usernameDisplay = String(req.body?.username ?? "").trim();
    const email = String(req.body?.email ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!isValidUsernameDisplay(usernameDisplay)) {
      return res.status(400).json({
        error: "Invalid username. Use 3–32 chars: letters, numbers, spaces, _ and - only.",
      });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email." });
    }
    if (!passwordMeetsPolicy(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters and include at least one special character.",
      });
    }

    const usernameCanonical = canonicalizeUsername(usernameDisplay);

    // Ensure canonical form also matches allowed characters after normalization
    // (spaces/_/- already allowed; this is mostly defensive)
    if (!/^[a-z0-9 _-]+$/.test(usernameCanonical)) {
      return res.status(400).json({ error: "Invalid username." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const insert = await pool.query(
      `
      INSERT INTO accounts (username_display, username_canonical, email, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING id, username_display, is_admin, created_at
      `,
      [usernameDisplay, usernameCanonical, email, passwordHash]
    );

    const account = insert.rows[0];

    await createSession({ accountId: account.id, req, res });

    return res.json({
      id: account.id,
      username: account.username_display,
      is_admin: account.is_admin,
      created_at: account.created_at,
    });
  } catch (err) {
    // Unique constraint for username_canonical
    if (String(err?.message || "").includes("accounts_username_canonical_key")) {
      return res.status(409).json({ error: "Username already taken." });
    }
    console.error("POST /auth/signup error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /auth/login
 * body: { username, password }
 *
 * Note: username is case-insensitive for lookup (canonicalized).
 */
router.post("/login", async (req, res) => {
  try {
    const usernameInput = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!usernameInput) return res.status(400).json({ error: "Missing username." });
    if (!password) return res.status(400).json({ error: "Missing password." });

    const usernameCanonical = canonicalizeUsername(usernameInput);

    const result = await pool.query(
      `
      SELECT id, username_display, password_hash, is_admin, created_at
      FROM accounts
      WHERE username_canonical = $1
      LIMIT 1
      `,
      [usernameCanonical]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const row = result.rows[0];
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    await createSession({ accountId: row.id, req, res });

    return res.json({
      id: row.id,
      username: row.username_display,
      is_admin: row.is_admin,
      created_at: row.created_at,
    });
  } catch (err) {
    console.error("POST /auth/login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /auth/logout
 */
router.post("/logout", async (req, res) => {
  try {
    const cookieName = process.env.BITROT_SESSION_COOKIE || "bitrot_session";
    const sid = req.cookies?.[cookieName];

    if (sid) {
      await pool.query(`DELETE FROM account_sessions WHERE id = $1`, [sid]);
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /auth/logout error:", err);
    clearSessionCookie(res);
    return res.json({ ok: true });
  }
});

/**
 * POST /auth/admin/reset_password
 * Admin-only MVP failsafe.
 * body: { username, new_password }
 */
router.post("/admin/reset_password", requireAdmin, async (req, res) => {
  try {
    const usernameInput = String(req.body?.username ?? "").trim();
    const newPassword = String(req.body?.new_password ?? "");

    if (!usernameInput) return res.status(400).json({ error: "Missing username." });
    if (!passwordMeetsPolicy(newPassword)) {
      return res.status(400).json({
        error: "New password must be at least 8 characters and include at least one special character.",
      });
    }

    const usernameCanonical = canonicalizeUsername(usernameInput);
    const hash = await bcrypt.hash(newPassword, 12);

    const upd = await pool.query(
      `
      UPDATE accounts
      SET password_hash = $2, updated_at = now()
      WHERE username_canonical = $1
      RETURNING id, username_display
      `,
      [usernameCanonical, hash]
    );

    if (upd.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({ ok: true, user: upd.rows[0] });
  } catch (err) {
    console.error("POST /auth/admin/reset_password error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
