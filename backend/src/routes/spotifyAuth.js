// src/routes/spotifyAuth.js
// Handles Spotify login + callback using your existing Spotify app.
// Also exposes /spotify/overlap to count how many of your Spotify releases
// exist in Bitrot (with simple caching on the users row).

import express from "express";
import pool from "../db/pool.js";

const router = express.Router();

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  PUBLIC_ORIGIN,
} = process.env;

// Compute a single redirect URI:
// - Prefer SPOTIFY_REDIRECT_URI if set
// - Otherwise default to `${PUBLIC_ORIGIN}/callback`
// - Fallback to http://127.0.0.1:3000/callback
const REDIRECT_URI =
  SPOTIFY_REDIRECT_URI ||
  `${(PUBLIC_ORIGIN || "http://127.0.0.1:3000").replace(/\/+$/, "")}/callback`;

// -------------------------
// GET /login
// Redirects the user to Spotify's authorization page.
// Full URL: http://127.0.0.1:3000/login
// (Because app.js mounts this router at the root.)
// -------------------------
router.get("/login", (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !REDIRECT_URI) {
    console.error("Spotify env vars missing");
    return res
      .status(500)
      .send("Spotify is not configured on the server (.env missing).");
  }

  const scopes = [
    "user-library-read",
    "playlist-read-private",
    "user-top-read",
    "user-follow-read",
  ];

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: scopes.join(" "),
    redirect_uri: REDIRECT_URI,
  });

  const url = `https://accounts.spotify.com/authorize?${params.toString()}`;
  res.redirect(url);
});

// -------------------------
// GET /callback
// Spotify redirects here with ?code=... after the user approves.
// Full URL: http://127.0.0.1:3000/callback
// -------------------------
router.get("/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res
      .status(400)
      .send("Missing ?code parameter from Spotify callback.");
  }

  try {
    const basicAuth = Buffer.from(
      `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });


    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      console.error("Spotify token error:", tokenResponse.status, text);
      return res
        .status(500)
        .send("Error exchanging code for tokens with Spotify.");
    }

    const tokenData = await tokenResponse.json();
    console.log("Spotify tokenData:", tokenData);

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn = tokenData.expires_in || 3600; // seconds

    // Use the access token to get the Spotify user profile
    const meResponse = await fetch("https://api.spotify.com/v1/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!meResponse.ok) {
      const text = await meResponse.text();
      console.error("Spotify /me error:", meResponse.status, text);
      return res
        .status(500)
        .send("Error fetching Spotify user profile ( /me ).");
    }

    const meData = await meResponse.json();
    console.log("Spotify /me:", meData);

    const spotifyId = meData.id;
    if (!spotifyId) {
      return res
        .status(500)
        .send("Could not determine Spotify user id from /me.");
    }

    // Compute token expiry timestamp
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Upsert the user into Postgres
    // Only uses columns we know exist or have added.
    const upsertQuery = `
      INSERT INTO users (
        spotify_id,
        spotify_access_token,
        spotify_refresh_token,
        spotify_token_expires_at
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (spotify_id) DO UPDATE SET
        spotify_access_token = EXCLUDED.spotify_access_token,
        spotify_refresh_token = EXCLUDED.spotify_refresh_token,
        spotify_token_expires_at = EXCLUDED.spotify_token_expires_at
      RETURNING id;
    `;

    const upsertParams = [spotifyId, accessToken, refreshToken, expiresAt];

    const result = await pool.query(upsertQuery, upsertParams);
    const userId = result.rows[0]?.id;

    console.log("Upserted Bitrot user:", { userId, spotifyId });

    // Simple success message for now
    res.send(`
      <html>
        <body>
          <h1>Spotify connected!</h1>
          <p>Your Spotify account is now linked to Bitrot.</p>
          <p>You can close this window and return to Bitrot.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Spotify callback error:", err);
    res.status(500).send("Unexpected error during Spotify callback.");
  }
});

// -------------------------
// GET /spotify/overlap
// Full URL: http://127.0.0.1:3000/spotify/overlap
// Optional: ?force=true to ignore cache and recompute.
// Uses the first user row for now (single-user MVP).
// Caches results in users.spotify_overlap_* columns.
// -------------------------
router.get("/spotify/overlap", async (req, res) => {
  try {
    const force = req.query.force === "true";

    // 1) Load the (only) Spotify user we care about for now
    const userResult = await pool.query(
      "SELECT * FROM users ORDER BY id LIMIT 1"
    );
    if (userResult.rows.length === 0) {
      return res
        .status(400)
        .json({ error: "No Spotify user found. Connect Spotify first." });
    }
    const user = userResult.rows[0];

    // 2) If we have a cached result and not forcing, return that
    if (
      !force &&
      user.spotify_overlap_last_checked_at &&
      user.spotify_overlap_summary &&
      Array.isArray(user.spotify_overlap_release_ids) &&
      user.spotify_overlap_release_ids.length > 0
    ) {
      const summary = user.spotify_overlap_summary;
      const overlapReleaseIds = user.spotify_overlap_release_ids;

      const releasesRes = await pool.query(
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
        WHERE r.id = ANY($1::uuid[])
        GROUP BY
          r.id,
          rs.url
        ORDER BY r.created_at DESC
        `,
        [overlapReleaseIds]
      );

      return res.json({
        spotify_user_id: summary.spotify_user_id,
        total_spotify_tracks: summary.total_spotify_tracks,
        total_spotify_albums: summary.total_spotify_albums,
        bitrot_matched_releases: summary.bitrot_matched_releases,
        matched_release_ids: overlapReleaseIds,
        matched_releases: releasesRes.rows,
        cached: true,
        cached_at: user.spotify_overlap_last_checked_at,
      });
    }

    // 3) Need to compute fresh overlap
    let accessToken = user.spotify_access_token;
    const now = new Date();

    if (!accessToken) {
      return res
        .status(400)
        .json({ error: "No Spotify access token stored. Reconnect Spotify." });
    }

    // 3a) Refresh token if expired (and we have a refresh token)
    if (
      user.spotify_token_expires_at &&
      new Date(user.spotify_token_expires_at) <= now &&
      user.spotify_refresh_token
    ) {
      try {
        const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization:
              "Basic " +
              Buffer.from(
                SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET
              ).toString("base64"),
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: user.spotify_refresh_token,
          }),
        });

        if (!tokenRes.ok) {
          const errorBody = await tokenRes.text();
          console.error("Error refreshing Spotify token:", errorBody);
        } else {
          const tokenJson = await tokenRes.json();
          accessToken = tokenJson.access_token;

          const newExpiresAt = new Date(
            Date.now() + tokenJson.expires_in * 1000
          );

          await pool.query(
            `UPDATE users
             SET spotify_access_token = $2,
                 spotify_token_expires_at = $3
             WHERE id = $1`,
            [user.id, accessToken, newExpiresAt.toISOString()]
          );
        }
      } catch (err) {
        console.error("Error during Spotify token refresh:", err);
      }
    }

    // 4) Fetch saved tracks (capped at 2000), and dedupe by (artist, album)
    const limit = 50;
    let offset = 0;
    let totalFetched = 0;
    const maxTracks = 2000;
    const spotifyAlbums = new Map();

    while (true) {
      const resp = await fetch(
        `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!resp.ok) {
        const text = await resp.text();
        console.error("Spotify /me/tracks error:", resp.status, text);
        return res
          .status(500)
          .json({ error: "Error fetching saved tracks from Spotify" });
      }

      const json = await resp.json();
      const items = json.items || [];

      for (const item of items) {
        const track = item.track;
        if (
          !track ||
          !track.album ||
          !track.artists ||
          track.artists.length === 0
        ) {
          continue;
        }

        const artistName = track.artists[0].name || "";
        const albumName = track.album.name || "";

        const normArtist = artistName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
        const normAlbum = albumName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
        const key = `${normArtist} :: ${normAlbum}`;

        if (!spotifyAlbums.has(key)) {
          spotifyAlbums.set(key, {
            artist_name: artistName,
            title: albumName,
          });
        }
      }

      totalFetched += items.length;
      if (!json.next || items.length === 0 || totalFetched >= maxTracks) {
        break;
      }

      offset += limit;
    }

    console.log("Fetched Spotify saved tracks:", totalFetched);
    console.log("Unique Spotify albums (artist + title):", spotifyAlbums.size);

    // 5) Load all Bitrot releases and compute overlap
    const releasesRes = await pool.query(`
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
      GROUP BY
        r.id,
        rs.url
    `);

    const matched = [];

    for (const row of releasesRes.rows) {
      const normArtist = (row.artist_name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      const normTitle = (row.title || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      const key = `${normArtist} :: ${normTitle}`;

      if (spotifyAlbums.has(key)) {
        matched.push(row);
      }
    }

    // 6) Make sure we have spotify_user_id in the summary
    let spotifyUserId = user.spotify_id || null;
    if (!spotifyUserId) {
      const meResp = await fetch("https://api.spotify.com/v1/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (meResp.ok) {
        const meJson = await meResp.json();
        spotifyUserId = meJson.id || null;

        if (spotifyUserId) {
          await pool.query(
            "UPDATE users SET spotify_id = $2 WHERE id = $1",
            [user.id, spotifyUserId]
          );
        }
      }
    }

    const summary = {
      spotify_user_id: spotifyUserId,
      total_spotify_tracks: totalFetched,
      total_spotify_albums: spotifyAlbums.size,
      bitrot_matched_releases: matched.length,
    };

    const matchedIds = matched.map((r) => r.id);

    // 7) Update cache on the user record
    await pool.query(
      `
      UPDATE users
      SET spotify_overlap_last_checked_at = NOW(),
          spotify_overlap_summary = $2,
          spotify_overlap_release_ids = $3
      WHERE id = $1
      `,
      [user.id, summary, matchedIds]
    );

    return res.json({
      ...summary,
      matched_release_ids: matchedIds,
      matched_releases: matched,
      cached: false,
    });
  } catch (err) {
    console.error("Error in /spotify/overlap:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------------
// GET /spotify/fetch-features
// Full URL: http://127.0.0.1:3000/spotify/fetch-features?max=500
//
// - Uses the same Spotify user as /spotify/overlap
// - Fetches up to `max` saved tracks (cap 2000, default 500)
// - Calls Spotify's /audio-features endpoint in batches
// - Upserts into audio_features (keyed by spotify_track_id)
// -------------------------
router.get("/spotify/fetch-features", async (req, res) => {
  try {
    const max = Math.min(parseInt(req.query.max, 10) || 500, 2000);

    // 1) Load the (only) Spotify user we care about for now
    const userResult = await pool.query(
      "SELECT * FROM users ORDER BY id LIMIT 1"
    );
    if (userResult.rows.length === 0) {
      return res
        .status(400)
        .json({ error: "No Spotify user found. Connect Spotify first." });
    }
    const user = userResult.rows[0];

    let accessToken = user.spotify_access_token;
    const now = new Date();

    if (!accessToken) {
      return res
        .status(400)
        .json({ error: "No Spotify access token stored. Reconnect Spotify." });
    }

    // 2) Refresh token if expired (and we have a refresh token)
    if (
      user.spotify_token_expires_at &&
      new Date(user.spotify_token_expires_at) <= now &&
      user.spotify_refresh_token
    ) {
      try {
        const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization:
              "Basic " +
              Buffer.from(
                SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET
              ).toString("base64"),
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: user.spotify_refresh_token,
          }),
        });

        if (!tokenRes.ok) {
          const errorBody = await tokenRes.text();
          console.error("Error refreshing Spotify token:", errorBody);
        } else {
          const tokenJson = await tokenRes.json();
          accessToken = tokenJson.access_token;

          const newExpiresAt = new Date(
            Date.now() + tokenJson.expires_in * 1000
          );

          await pool.query(
            `UPDATE users
             SET spotify_access_token = $2,
                 spotify_token_expires_at = $3
             WHERE id = $1`,
            [user.id, accessToken, newExpiresAt.toISOString()]
          );
        }
      } catch (err) {
        console.error("Error during Spotify token refresh:", err);
      }
    }

    // 3) Fetch saved tracks up to `max`, gather unique track IDs
    const limit = 50;
    let offset = 0;
    let totalFetched = 0;
    const trackIds = new Set();

    while (totalFetched < max) {
      const resp = await fetch(
        `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!resp.ok) {
        const text = await resp.text();
        console.error("Spotify /me/tracks error:", resp.status, text);
        return res
          .status(500)
          .json({ error: "Error fetching saved tracks from Spotify" });
      }

      const json = await resp.json();
      const items = json.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        const track = item.track;
        if (!track || !track.id) continue;
        trackIds.add(track.id);
      }

      totalFetched += items.length;
      if (!json.next || totalFetched >= max) {
        break;
      }

      offset += limit;
    }

    console.log(
      "[Spotify] fetch-features: fetched items from library:",
      totalFetched
    );
    console.log(
      "[Spotify] fetch-features: unique track IDs:",
      trackIds.size
    );

    // 4) Fetch audio features in batches of 100
    const idsArray = Array.from(trackIds);
    let featuresWritten = 0;

    for (let i = 0; i < idsArray.length; i += 100) {
      const batch = idsArray.slice(i, i + 100);
      const featResp = await fetch(
        `https://api.spotify.com/v1/audio-features?ids=${batch.join(",")}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!featResp.ok) {
        const text = await featResp.text();
        console.error(
          "Spotify /audio-features error:",
          featResp.status,
          text
        );
        continue; // skip this batch, move on
      }

      const featJson = await featResp.json();
      const audioFeatures = featJson.audio_features || [];

      for (const af of audioFeatures) {
        if (!af || !af.id) continue;

        await pool.query(
          `
          INSERT INTO audio_features (
            spotify_track_id,
            tempo,
            key,
            mode,
            danceability,
            energy,
            valence,
            acousticness,
            instrumentalness,
            liveness,
            speechiness
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
          )
          ON CONFLICT (spotify_track_id) DO UPDATE SET
            tempo = EXCLUDED.tempo,
            key = EXCLUDED.key,
            mode = EXCLUDED.mode,
            danceability = EXCLUDED.danceability,
            energy = EXCLUDED.energy,
            valence = EXCLUDED.valence,
            acousticness = EXCLUDED.acousticness,
            instrumentalness = EXCLUDED.instrumentalness,
            liveness = EXCLUDED.liveness,
            speechiness = EXCLUDED.speechiness
          `,
          [
            af.id,
            af.tempo,
            af.key,
            af.mode,
            af.danceability,
            af.energy,
            af.valence,
            af.acousticness,
            af.instrumentalness,
            af.liveness,
            af.speechiness,
          ]
        );

        featuresWritten++;
      }
    }

    console.log(
      "[Spotify] fetch-features: audio_features rows upserted:",
      featuresWritten
    );

    return res.json({
      spotify_user_id: user.spotify_id,
      library_items_considered: totalFetched,
      unique_track_ids: trackIds.size,
      audio_features_written: featuresWritten,
    });
  } catch (err) {
    console.error("Error in /spotify/fetch-features:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
