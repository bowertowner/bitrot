console.log("APP.JS LOADED");

dotenv.config();

import dotenv from "dotenv";
import express from "express";
import cors from "cors";

import pool from "./db/pool.js";
import releaseRoutes from "./routes/release.js";
import encounterRoutes from "./routes/encounter.js";
import spotifyAuthRoutes from "./routes/spotifyAuth.js";
import statsRoutes from "./routes/stats.js";
import discogsRoutes from "./routes/discogs.js";

const app = express();

app.use(express.json());

// Allow requests from any origin (Chrome/Firefox extensions, Bandcamp pages, etc.)
app.use(cors());

// Serve the simple frontend from /public
app.use(express.static("public"));

// Stats
app.use("/stats", statsRoutes);

// Discogs routes MUST come before root-mounted Spotify routes
app.use("/discogs", discogsRoutes);

/**
 * Spotify auth routes mounted at root:
 *  - GET /login
 *  - GET /callback
 */
app.use("/", spotifyAuthRoutes);


/**
 * Release detail endpoint
 * GET /release/:id
 * Returns a single release with tags, tracks, encounter count and source URL.
 */
app.get("/release/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Release + tags + source
    const releaseResult = await pool.query(
      `
      SELECT
        r.id,
        r.title,
        r.artist_name,
        r.release_date,
        r.price_label,
        r.is_free,
        r.created_at,
        rs.url,
        rs.platform,
        COALESCE(
          string_agg(DISTINCT t.name, ', ') FILTER (WHERE t.name IS NOT NULL),
          ''
        ) AS tags
      FROM releases r
      LEFT JOIN release_sources rs ON r.id = rs.release_id
      LEFT JOIN release_tags rt ON r.id = rt.release_id
      LEFT JOIN tags t ON rt.tag_id = t.id
      WHERE r.id = $1
      GROUP BY
        r.id,
        rs.url,
        rs.platform
      `,
      [id]
    );

    if (releaseResult.rows.length === 0) {
      return res.status(404).json({ error: "Release not found" });
    }

    // Tracks
    const tracksResult = await pool.query(
      `
      SELECT
        id,
        title,
        duration,
        spotify_track_id
      FROM tracks
      WHERE release_id = $1
      ORDER BY id ASC
      `,
      [id]
    );

    // Encounter count (for MVP, at most one row per release)
    const encountersResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM user_encounters
      WHERE release_id = $1
      `,
      [id]
    );

    const release = releaseResult.rows[0];
    release.tracks = tracksResult.rows;
    release.encounter_count = encountersResult.rows[0].count;

    res.json(release);
  } catch (err) {
    console.error("Error in GET /release/:id", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Artists list endpoint
 * GET /artists
 * Returns top artists aggregated from releases (using artist_name text).
 */
app.get("/artists", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        artist_name,
        COUNT(*)::int AS release_count,
        COUNT(*) FILTER (WHERE is_free = true)::int AS free_release_count
      FROM releases
      WHERE artist_name IS NOT NULL AND artist_name <> ''
      GROUP BY artist_name
      ORDER BY release_count DESC, artist_name ASC
      LIMIT 100
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error in GET /artists:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Single artist releases endpoint
 * GET /artist?name=Artist+Name
 * Returns all releases for a given artist name (exact match).
 */
app.get("/artist", async (req, res) => {
  const { name } = req.query;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Missing ?name parameter" });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        r.id,
        r.title,
        r.artist_name,
        r.created_at,
        r.release_date,
        r.price_label,
        r.is_free,
        rs.url,
        COALESCE(
          string_agg(DISTINCT t.name, ', ') FILTER (WHERE t.name IS NOT NULL),
          ''
        ) AS tags
      FROM releases r
      LEFT JOIN release_sources rs ON r.id = rs.release_id
      LEFT JOIN release_tags rt ON r.id = rt.release_id
      LEFT JOIN tags t ON rt.tag_id = t.id
      WHERE r.artist_name = $1
      GROUP BY
        r.id,
        r.title,
        r.artist_name,
        r.created_at,
        r.release_date,
        r.price_label,
        r.is_free,
        rs.url
      ORDER BY r.created_at DESC
      `,
      [name]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error in GET /artist:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Tags list endpoint
 * GET /tags
 * Returns top tags with release counts and free/NYP counts.
 */
app.get("/tags", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        t.name,
        COUNT(*)::int AS release_count,
        COUNT(*) FILTER (WHERE r.is_free = true)::int AS free_release_count
      FROM tags t
      JOIN release_tags rt ON rt.tag_id = t.id
      JOIN releases r ON rt.release_id = r.id
      GROUP BY t.name
      ORDER BY release_count DESC, t.name ASC
      LIMIT 100
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error in GET /tags:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Core write endpoints
 */
app.use("/release", releaseRoutes);
app.use("/user_encounter", encounterRoutes);

/**
 * Public read-only releases list
 * Supports filters: artist, free (true/false), tag (single or comma-list, AND semantics), page
 * Supports sorting via sort_by, sort_dir
 */
app.get("/releases", async (req, res) => {
  const { artist, page = 1, free, tag, sort_by, sort_dir } = req.query;
  const limit = 20;
  const offset = (Number(page) - 1) * limit;

  // Build WHERE conditions dynamically
  const conditions = [];
  const params = [];
  let idx = 1;

  if (artist && artist.trim() !== "") {
    conditions.push(`r.artist_name ILIKE '%' || $${idx} || '%'`);
    params.push(artist.trim());
    idx++;
  }

  if (free === "true") {
    conditions.push(`r.is_free = true`);
  } else if (free === "false") {
    conditions.push(`r.is_free = false`);
  }

  if (tag && tag.trim() !== "") {
    // Support multiple tags via comma-separated string: tag=house,booty
    const rawTags = tag
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (rawTags.length > 0) {
      const lowered = rawTags.map((t) => t.toLowerCase());
      // AND semantics: release must have *all* of the selected tags (case-insensitive)
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM (
            SELECT COUNT(DISTINCT lower(t2.name)) AS matched
            FROM release_tags rt2
            JOIN tags t2 ON rt2.tag_id = t2.id
            WHERE rt2.release_id = r.id
              AND lower(t2.name) = ANY ($${idx})
          ) AS x
          WHERE x.matched = cardinality($${idx})
        )
      `);
      params.push(lowered); // text[] in Postgres
      idx++;
    }
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Sorting
  let orderClause = "ORDER BY r.created_at DESC";
  const dir = sort_dir === "asc" ? "ASC" : "DESC";
  switch (sort_by) {
    case "artist":
      orderClause = `ORDER BY r.artist_name ${dir}, r.created_at DESC`;
      break;
    case "title":
      orderClause = `ORDER BY r.title ${dir}, r.created_at DESC`;
      break;
    case "release_date":
      orderClause = `ORDER BY r.release_date ${dir} NULLS LAST, r.created_at DESC`;
      break;
    case "price":
      orderClause = `ORDER BY r.price_label ${dir}, r.created_at DESC`;
      break;
    case "free":
      orderClause = `ORDER BY r.is_free ${dir} NULLS LAST, r.created_at DESC`;
      break;
    case "encounters":
      orderClause = `ORDER BY unique_visits ${dir}, r.created_at DESC`;
      break;
    default:
    // keep default
  }

  // Add pagination params
  params.push(limit);
  params.push(offset);

  try {
    const result = await pool.query(
      `
      SELECT
        r.id,
        r.title,
        r.artist_name,
        r.created_at,
        r.release_date,
        r.price_label,
        r.is_free,
        rs.url,
        COALESCE(
          string_agg(DISTINCT t.name, ', ') FILTER (WHERE t.name IS NOT NULL),
          ''
        ) AS tags,
        COALESCE(uv.unique_visits, 0) AS unique_visits
      FROM releases r
      LEFT JOIN release_sources rs ON r.id = rs.release_id
      LEFT JOIN release_tags rt ON r.id = rt.release_id
      LEFT JOIN tags t ON rt.tag_id = t.id
      LEFT JOIN (
        SELECT
          release_id,
          COUNT(*) AS unique_visits
        FROM user_encounters
        GROUP BY release_id
      ) uv ON uv.release_id = r.id
      ${whereClause}
      GROUP BY
        r.id,
        r.title,
        r.artist_name,
        r.created_at,
        r.release_date,
        r.price_label,
        r.is_free,
        rs.url,
        uv.unique_visits
      ${orderClause}
      LIMIT $${idx} OFFSET $${idx + 1}
      `,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const [releasesResult, artistsResult, freeResult, encountersResult] =
      await Promise.all([
        pool.query("SELECT COUNT(*) AS count FROM releases"),
        pool.query("SELECT COUNT(DISTINCT artist_name) AS count FROM releases"),
        pool.query("SELECT COUNT(*) AS count FROM releases WHERE is_free = true"),
        pool.query("SELECT COUNT(*) AS count FROM user_encounters"),
      ]);

    res.json({
      total_releases: Number(releasesResult.rows[0].count),
      total_artists: Number(artistsResult.rows[0].count),
      total_free_releases: Number(freeResult.rows[0].count),
      total_encounters: Number(encountersResult.rows[0].count),
    });
  } catch (err) {
    console.error("Error in /stats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Health check
 */
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", db: "disconnected" });
  }
});

export default app;
