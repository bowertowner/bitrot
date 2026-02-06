import pool from "../db/pool.js";

export async function releaseLookup(req, res) {
  const {
    artist,
    title,
    platform,
    platform_release_id,
    url,
    tracks = [],
    release_date,
    tags = [],
    price_label,
    is_free,
  } = req.body;

  // Debug log: see exactly what the extension is sending
  console.log("releaseLookup body:", JSON.stringify(req.body, null, 2));

  if (!artist || !title || !platform) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await pool.query("BEGIN");

    let releaseId;

    // 1. Check if release already exists via source
    const existing = await pool.query(
      `
      SELECT release_id
      FROM release_sources
      WHERE platform = $1
        AND platform_release_id = $2
      `,
      [platform, platform_release_id]
    );

    if (existing.rows.length > 0) {
      // Existing release -> we may still update date/price/tags
      releaseId = existing.rows[0].release_id;

      // Update fields only if we have new non-null values
      await pool.query(
        `
        UPDATE releases
        SET
          release_date = COALESCE($1, release_date),
          price_label = COALESCE($2, price_label),
          is_free = COALESCE($3, is_free)
        WHERE id = $4
        `,
        [release_date || null, price_label || null, is_free, releaseId]
      );

      // No track reinsertion for existing releases.
    } else {
      // 2. Create new release (including optional date/price)
      const releaseResult = await pool.query(
        `
        INSERT INTO releases (title, artist_name, release_date, price_label, is_free)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        `,
        [
          title,
          artist,
          release_date || null,
          price_label || null,
          typeof is_free === "boolean" ? is_free : null,
        ]
      );

      releaseId = releaseResult.rows[0].id;

      // 3. Insert release source
      await pool.query(
        `
        INSERT INTO release_sources
        (release_id, platform, platform_release_id, url)
        VALUES ($1, $2, $3, $4)
        `,
        [releaseId, platform, platform_release_id, url]
      );

      // 4. Insert tracks for this release
      for (const track of tracks) {
        if (!track || !track.title) continue;
        await pool.query(
          `
          INSERT INTO tracks (release_id, title, duration)
          VALUES ($1, $2, $3)
          `,
          [releaseId, track.title, track.duration || null]
        );
      }
    }

    // 5. Upsert tags (for both new and existing releases)
    if (Array.isArray(tags) && tags.length > 0) {
      for (const raw of tags) {
        const name = (raw || "").trim();
        if (!name) continue;

        // Find or create tag
        let tagId;
        const existingTag = await pool.query(
          `SELECT id FROM tags WHERE name = $1`,
          [name]
        );
        if (existingTag.rows.length > 0) {
          tagId = existingTag.rows[0].id;
        } else {
          const insertTag = await pool.query(
            `INSERT INTO tags (name) VALUES ($1) RETURNING id`,
            [name]
          );
          tagId = insertTag.rows[0].id;
        }

        // Link release <-> tag, avoid duplicates
        await pool.query(
          `
          INSERT INTO release_tags (release_id, tag_id, source)
          SELECT $1, $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM release_tags
            WHERE release_id = $1
              AND tag_id = $2
              AND source = $3
          )
          `,
          [releaseId, tagId, platform]
        );
      }
    }

    await pool.query("COMMIT");
    return res.json({ release_id: releaseId });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
