import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import pool from "./db/pool.js";
import releaseRoutes from "./routes/release.js";
import encounterRoutes from "./routes/encounter.js";
import spotifyAuthRoutes from "./routes/spotifyAuth.js";
import statsRoutes from "./routes/stats.js";
import discogsRoutes from "./routes/discogs.js";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";
import { loadAccountFromSession } from "./middleware/authSession.js";

const app = express();

app.use(express.json());
app.use(cors());
app.use(cookieParser());

// Attach req.account if logged in (safe for all routes)
app.use(loadAccountFromSession);

// Static files (frontend)
app.use(express.static("public"));

// Stats
app.use("/stats", statsRoutes);

// Discogs routes MUST come before root-mounted Spotify routes
app.use("/discogs", discogsRoutes);

/**
 * Auth + User routes (new)
 */
app.use("/auth", authRoutes);
app.use("/user", userRoutes);

/**
 * Spotify auth routes mounted at root (legacy).
 * We will remove/hide Spotify from the frontend for public MVP,
 * but backend routes can remain for now.
 */
app.use("/", spotifyAuthRoutes);

/**
 * Release detail endpoint
 * GET /release/:id
 */
app.get("/release/:id", async (req, res) => {
  const { id } = req.params;

  try {
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

        -- Discogs enrichment fields (Option #1 columns on releases)
        r.discogs_release_id,
        r.discogs_master_id,
        r.discogs_confidence,
        r.discogs_rating_average,
        r.discogs_rating_count,
        r.discogs_country,
        r.discogs_labels,
        r.discogs_cover_image_url,
        r.discogs_thumb_url,
        r.discogs_genres,
        r.discogs_styles,
        r.discogs_matched_at,
        r.discogs_last_refreshed_at,
        r.discogs_refreshed_at,

        -- Bandcamp embed/art enrichment (captured by extensions)
        r.bandcamp_item_type,
        r.bandcamp_item_id,
        r.bandcamp_embed_src,
        r.bandcamp_art_url,

        -- Bandcamp tags (existing behavior)
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

    const encountersResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM user_encounters
      WHERE release_id = $1
      `,
      [id]
    );

    const tagAttachmentsResult = await pool.query(
      `
      SELECT
        rt.id AS release_tag_id,
        rt.tag_id,
        t.name AS tag_name,
        rt.source,
        rt.created_by_account_id,

        -- totals
        COUNT(*) FILTER (WHERE v.vote_value = 1)::int AS upvotes,
        COUNT(*) FILTER (WHERE v.vote_value = -1)::int AS downvotes,

        -- current user's vote on this attachment (1, -1, or null)
        MAX(CASE WHEN v.account_id = $2 THEN v.vote_value ELSE NULL END)::int AS my_vote_value
      FROM release_tags rt
      JOIN tags t ON t.id = rt.tag_id
      LEFT JOIN release_tag_votes v ON v.release_tag_id = rt.id
      WHERE rt.release_id = $1
      GROUP BY
        rt.id,
        rt.tag_id,
        t.name,
        rt.source,
        rt.created_by_account_id
      ORDER BY
        (COUNT(*) FILTER (WHERE v.vote_value = 1) - COUNT(*) FILTER (WHERE v.vote_value = -1)) DESC,
        t.name ASC
      `,
      [id, req.account?.id ?? null]
    );

    const tag_attachments = (tagAttachmentsResult.rows || []).map((row) => {
      const upvotes = Number(row.upvotes || 0);
      const downvotes = Number(row.downvotes || 0);
      const myVote = row.my_vote_value == null ? 0 : Number(row.my_vote_value);

      const isSticker = row.source === "user";
      const isMine =
        req.account?.id != null && row.created_by_account_id === req.account.id;

      // removal policy:
      // - only your own sticker
      // - allowed if there are NO upvotes
      // - and the creator has NOT voted on it (no self up/down vote)
      //
      // This allows removal even if there are only downvotes from other users.
      const creatorVoted = myVote === 1 || myVote === -1;
      const can_remove =
        Boolean(req.account?.id) &&
        isSticker &&
        isMine &&
        upvotes === 0 &&
        !creatorVoted;

      // voting policy:
      // - anyone logged in can upvote any tag attachment
      // - only stickers can be downvoted
      const can_upvote = Boolean(req.account?.id);
      const can_downvote = Boolean(req.account?.id) && isSticker;

      return {
        release_tag_id: row.release_tag_id,
        tag_id: row.tag_id,
        tag_name: row.tag_name,
        source: row.source,
        upvotes,
        downvotes,
        my_vote_value: myVote, // 1, -1, or 0
        can_remove,
        can_upvote,
        can_downvote,
      };
    });

    const release = releaseResult.rows[0];
    release.tracks = tracksResult.rows;
    release.encounter_count = encountersResult.rows[0].count;

    // New field for stickers/voting UI (existing fields remain unchanged)
    release.tag_attachments = tag_attachments;

    res.json(release);
    
  } catch (err) {
    console.error("Error in GET /release/:id", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Artists list endpoint
 * GET /artists
 */
app.get("/artists", async (_req, res) => {
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
 */
app.get("/artist", async (req, res) => {
  const { name } = req.query;
  if (!name || !String(name).trim()) {
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
      [String(name)]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error in GET /artist:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Tag pool endpoint (for sticker/typeahead UI)
 * GET /tag_pool?q=house
 *
 * Returns:
 *  { tags: [{id, name}] }
 *
 * Notes:
 * - This is NOT the same as /tags (stats grouping).
 * - This returns from the global tags table (complete pool).
 * - Case-insensitive match.
 */
app.get("/tag_pool", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = 50;

  try {
    if (!q) {
      // for safety/perf, require q (typeahead usage)
      return res.json({ tags: [] });
    }

    const result = await pool.query(
      `
      SELECT id, name
      FROM tags
      WHERE name ILIKE '%' || $1 || '%'
      ORDER BY
        CASE WHEN name ILIKE $1 || '%' THEN 0 ELSE 1 END,
        name ASC
      LIMIT $2
      `,
      [q, limit]
    );

    return res.json({ tags: result.rows || [] });
  } catch (err) {
    console.error("Error in GET /tag_pool:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Tags list endpoint
 * GET /tags
 *
 * Returns grouped:
 *  {
 *    bandcamp: [{name,release_count,free_release_count}],
 *    discogs_genres: [...],
 *    discogs_styles: [...]
 *  }
 */
app.get("/tags", async (_req, res) => {
  try {
    const bandcampQ = pool.query(
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

    const discogsGenresQ = pool.query(
      `
      SELECT
        g.name,
        COUNT(*)::int AS release_count,
        COUNT(*) FILTER (WHERE g.is_free = true)::int AS free_release_count
      FROM (
        SELECT
          r.id,
          r.is_free,
          unnest(COALESCE(r.discogs_genres, ARRAY[]::text[])) AS name
        FROM releases r
        WHERE r.discogs_genres IS NOT NULL
      ) g
      WHERE g.name IS NOT NULL AND g.name <> ''
      GROUP BY g.name
      ORDER BY release_count DESC, g.name ASC
      LIMIT 100
      `
    );

    const discogsStylesQ = pool.query(
      `
      SELECT
        s.name,
        COUNT(*)::int AS release_count,
        COUNT(*) FILTER (WHERE s.is_free = true)::int AS free_release_count
      FROM (
        SELECT
          r.id,
          r.is_free,
          unnest(COALESCE(r.discogs_styles, ARRAY[]::text[])) AS name
        FROM releases r
        WHERE r.discogs_styles IS NOT NULL
      ) s
      WHERE s.name IS NOT NULL AND s.name <> ''
      GROUP BY s.name
      ORDER BY release_count DESC, s.name ASC
      LIMIT 100
      `
    );

    const [bandcamp, discogsGenres, discogsStyles] = await Promise.all([
      bandcampQ,
      discogsGenresQ,
      discogsStylesQ,
    ]);

    res.json({
      bandcamp: bandcamp.rows || [],
      discogs_genres: discogsGenres.rows || [],
      discogs_styles: discogsStyles.rows || [],
    });
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
 */
app.get("/releases", async (req, res) => {
  const { artist, page = 1, free, tag, q, sort_by, sort_dir } = req.query;
  const limit = 20;
  const offset = (Number(page) - 1) * limit;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (artist && String(artist).trim() !== "") {
    conditions.push(`r.artist_name ILIKE '%' || $${idx} || '%'`);
    params.push(String(artist).trim());
    idx++;
  }

  if (free === "true") {
    conditions.push(`r.is_free = true`);
  } else if (free === "false") {
    conditions.push(`r.is_free = false`);
  }

  // Tag filter: AND semantics across (bandcamp tags OR discogs genres OR discogs styles)
  if (tag && String(tag).trim() !== "") {
    const rawTags = String(tag)
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (rawTags.length > 0) {
      const lowered = rawTags.map((t) => t.toLowerCase());

      conditions.push(`
        EXISTS (
          SELECT 1
          FROM (
            SELECT COUNT(DISTINCT m.tag) AS matched
            FROM (
              -- bandcamp tags
              SELECT lower(t2.name) AS tag
              FROM release_tags rt2
              JOIN tags t2 ON rt2.tag_id = t2.id
              WHERE rt2.release_id = r.id

              UNION

              -- discogs genres
              SELECT lower(x) AS tag
              FROM unnest(COALESCE(r.discogs_genres, ARRAY[]::text[])) AS x

              UNION

              -- discogs styles
              SELECT lower(x) AS tag
              FROM unnest(COALESCE(r.discogs_styles, ARRAY[]::text[])) AS x
            ) m
            WHERE m.tag = ANY ($${idx})
          ) AS x
          WHERE x.matched = cardinality($${idx})
        )
      `);

      params.push(lowered); // text[]
      idx++;
    }
  }

  // Global search: include Discogs enrichment + bandcamp tags + normal fields
  if (q && String(q).trim() !== "") {
    const term = String(q).trim();

    conditions.push(`
      (
        r.artist_name ILIKE '%' || $${idx} || '%'
        OR r.title ILIKE '%' || $${idx} || '%'
        OR COALESCE(r.price_label,'') ILIKE '%' || $${idx} || '%'
        OR COALESCE(rs.url,'') ILIKE '%' || $${idx} || '%'
        OR EXISTS (
          SELECT 1
          FROM release_tags rt3
          JOIN tags t3 ON rt3.tag_id = t3.id
          WHERE rt3.release_id = r.id
            AND t3.name ILIKE '%' || $${idx} || '%'
        )
        OR COALESCE(array_to_string(r.discogs_genres, ' '), '') ILIKE '%' || $${idx} || '%'
        OR COALESCE(array_to_string(r.discogs_styles, ' '), '') ILIKE '%' || $${idx} || '%'
        OR COALESCE(array_to_string(r.discogs_labels, ' '), '') ILIKE '%' || $${idx} || '%'
        OR COALESCE(r.discogs_country,'') ILIKE '%' || $${idx} || '%'
        OR COALESCE(r.discogs_release_id::text,'') ILIKE '%' || $${idx} || '%'
        OR COALESCE(r.discogs_master_id::text,'') ILIKE '%' || $${idx} || '%'
      )
    `);

    params.push(term);
    idx++;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

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

        -- Discogs enrichment fields (for scroller + global search)
        r.discogs_genres,
        r.discogs_styles,
        r.discogs_cover_image_url,
        r.discogs_thumb_url,
        r.discogs_country,
        r.discogs_labels,
        r.discogs_rating_average,
        r.discogs_rating_count,

        -- Bandcamp art thumbnail (captured by extension)
        r.bandcamp_art_url,

        -- Bandcamp tags
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
        SELECT release_id, COUNT(*) AS unique_visits
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
    console.error("Error in GET /releases:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Health check
 */
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", db: "disconnected" });
  }
});

export default app;
