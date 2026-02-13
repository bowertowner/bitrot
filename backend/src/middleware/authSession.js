import pool from "../db/pool.js";

const COOKIE_NAME = process.env.BITROT_SESSION_COOKIE || "bitrot_session";

/**
 * Canonicalize username for case-insensitive uniqueness.
 * - trim
 * - collapse multiple spaces
 * - lowercase
 */
export function canonicalizeUsername(input) {
  const s = String(input ?? "");
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isValidUsernameDisplay(input) {
  const s = String(input ?? "");
  if (s.length < 3 || s.length > 32) return false;
  // letters/numbers/space/_/-
  if (!/^[A-Za-z0-9 _-]+$/.test(s)) return false;
  // disallow leading/trailing spaces (we'll trim anyway, but enforce)
  if (s.trim() !== s) return false;
  return true;
}

export function isValidEmail(input) {
  const s = String(input ?? "").trim();
  if (s.length < 3 || s.length > 320) return false;
  if (!s.includes("@")) return false;
  return true;
}

export function passwordMeetsPolicy(pw) {
  const s = String(pw ?? "");
  if (s.length < 8) return false;
  // at least one special character
  if (!/[^A-Za-z0-9]/.test(s)) return false;
  return true;
}

export function sessionCookieName() {
  return COOKIE_NAME;
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
  });
}

/**
 * Loads req.account if a valid session cookie exists.
 * - does NOT require auth (use requireAuth for protected routes)
 */
export async function loadAccountFromSession(req, _res, next) {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    if (!sid) {
      req.account = null;
      return next();
    }

    const result = await pool.query(
      `
      SELECT
        s.id AS session_id,
        s.expires_at,
        a.id AS account_id,
        a.username_display,
        a.username_canonical,
        a.email,
        a.is_admin,
        a.created_at
      FROM account_sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.id = $1
        AND s.expires_at > now()
      LIMIT 1
      `,
      [sid]
    );

    if (result.rows.length === 0) {
      req.account = null;
      return next();
    }

    const row = result.rows[0];

    // attach account
    req.account = {
      id: row.account_id,
      username_display: row.username_display,
      username_canonical: row.username_canonical,
      email: row.email,
      is_admin: row.is_admin,
      created_at: row.created_at,
    };

    // touch last_seen_at (best-effort)
    pool
      .query(`UPDATE account_sessions SET last_seen_at = now() WHERE id = $1`, [row.session_id])
      .catch(() => {});

    return next();
  } catch (err) {
    console.error("loadAccountFromSession error:", err);
    req.account = null;
    return next();
  }
}

export function requireAuth(req, res, next) {
  if (!req.account) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.account) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  if (!req.account.is_admin) {
    return res.status(403).json({ error: "Admin required" });
  }
  return next();
}

/**
 * Create a session and set cookie.
 */
export async function createSession({ accountId, req, res }) {
  // 7-day session
  const sessionResult = await pool.query(
    `
    INSERT INTO account_sessions (account_id, expires_at, ip, user_agent)
    VALUES ($1, now() + interval '7 days', $2, $3)
    RETURNING id, expires_at
    `,
    [
      accountId,
      req.ip || null,
      req.headers["user-agent"] ? String(req.headers["user-agent"]) : null,
    ]
  );

  const session = sessionResult.rows[0];

  res.cookie(COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // localhost/dev; switch to true behind HTTPS later
    expires: new Date(session.expires_at),
  });

  return session;
}
