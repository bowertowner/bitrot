import pool from "../db/pool.js";

export async function listReleases(req, res) {
  const { artist, page = 1 } = req.query;
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    // 1️⃣ Add a total-count query that matches the same WHERE clause
    const countResult = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM releases r
      WHERE ($1::text IS NULL OR r.artist_name ILIKE '%' || $1 || '%')
      `,
      [artist || null]
    );

    const total = Number(countResult.rows[0].total);

    // 2️⃣ Original paginated query (unchanged)
    const result = await pool.query(
      `
      SELECT
        r.id,
        r.title,
        r.artist_name,
        r.created_at,
        rs.url
      FROM releases r
      LEFT JOIN release_sources rs ON r.id = rs.release_id
      WHERE ($1::text IS NULL OR r.artist_name ILIKE '%' || $1 || '%')
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [artist || null, limit, offset]
    );

    // 3️⃣ REQUIRED FIX: send the total count header
    res.set("X-Total-Count", total);

    // 4️⃣ Send the rows as usual
    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
}
