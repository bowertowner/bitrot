import pool from "../db/pool.js";

export async function logEncounter(req, res) {
  const { release_id, source } = req.body;

  if (!release_id || !source) {
    return res.status(400).json({ error: "Missing release_id or source" });
  }

  try {
    // Anonymous encounter (no user yet)
    await pool.query(
      `
      INSERT INTO user_encounters (user_id, release_id, source)
      VALUES (NULL, $1, $2)
      `,
      [release_id, source]
    );

    return res.json({ status: "logged" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
