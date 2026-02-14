import pool from "../db/pool.js";
import {
  discogsSearchRelease,
  discogsGetRelease,
  isDiscogsTemporaryError,
  isDiscogsConfigError,
} from "./discogsClient.js";

/**
 * Discogs matching + enrichment hydration (Option #1: columns on releases)
 *
 * Rules:
 * - If releases.discogs_release_id exists: refresh enrichment with ONE Discogs API call
 *   (GET /releases/:id). No search.
 * - If not matched: search -> pick best -> hydrate once on "matched" only -> persist enrichment.
 * - Persist enrichment: genres/styles/cover+thumb/country/labels/rating avg+count + refreshed timestamps.
 * - Cache raw JSON in discogs_entities.
 */

function normalize(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/\(\d+\)/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseDiscogsSearchHit(hit) {
  const raw = String(hit?.title || "");
  const parts = raw.split(" - ");
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  }
  return { artist: String(hit?.artist || "").trim(), title: raw.trim() };
}

function scoreResult(releaseRow, hit) {
  const relTitle = normalize(releaseRow.title);
  const relArtist = normalize(releaseRow.artist_name);

  const parsed = parseDiscogsSearchHit(hit);
  const hitTitle = normalize(parsed.title);
  const hitArtist = normalize(parsed.artist);

  let score = 0;

  if (relTitle && hitTitle && relTitle === hitTitle) score += 40;
  else if (relTitle && hitTitle && (hitTitle.includes(relTitle) || relTitle.includes(hitTitle))) {
    score += 25;
  }

  if (relArtist && hitArtist && relArtist === hitArtist) score += 30;
  else if (relArtist && hitArtist && (hitArtist.includes(relArtist) || relArtist.includes(hitArtist))) {
    score += 15;
  }

  const hitYear = hit?.year ? Number(hit.year) : null;
  const relYear = releaseRow.release_date
    ? new Date(releaseRow.release_date).getFullYear()
    : null;
  if (hitYear && relYear && hitYear === relYear) score += 10;

  return Math.min(score, 100);
}

function safeStringArray(arr) {
  if (!Array.isArray(arr)) return null;
  const out = arr
    .map((x) => (x == null ? "" : String(x).trim()))
    .filter(Boolean);
  return out.length ? out : null;
}

function pickImages(releaseJson) {
  const images = Array.isArray(releaseJson?.images) ? releaseJson.images : [];
  if (!images.length) return { coverUrl: null, thumbUrl: null };

  const primary =
    images.find((img) => String(img?.type || "").toLowerCase() === "primary") ||
    images[0];

  const coverUrl =
    (primary?.uri && String(primary.uri)) ||
    (primary?.resource_url && String(primary.resource_url)) ||
    null;

  const thumbUrl =
    (primary?.uri150 && String(primary.uri150)) ||
    (primary?.uri && String(primary.uri)) ||
    null;

  return { coverUrl, thumbUrl };
}

function extractLabels(releaseJson) {
  const labels = Array.isArray(releaseJson?.labels) ? releaseJson.labels : [];
  const names = labels
    .map((l) => (l?.name == null ? "" : String(l.name).trim()))
    .filter(Boolean);
  return names.length ? names : null;
}

function extractRating(releaseJson) {
  const avgRaw = releaseJson?.community?.rating?.average;
  const countRaw = releaseJson?.community?.rating?.count;

  const avg = avgRaw == null ? null : Number(avgRaw);
  const count = countRaw == null ? null : Number(countRaw);

  return {
    average: Number.isFinite(avg) ? avg : null,
    count: Number.isFinite(count) ? count : null,
  };
}

async function upsertDiscogsEntity({ discogsId, entityType, rawJson }) {
  if (!discogsId || !entityType || !rawJson) return;

  await pool.query(
    `
    INSERT INTO discogs_entities (discogs_id, entity_type, raw_json, last_synced_at)
    VALUES ($1, $2, $3::jsonb, now())
    ON CONFLICT (discogs_id, entity_type)
    DO UPDATE SET raw_json = EXCLUDED.raw_json,
                  last_synced_at = now()
    `,
    [discogsId, entityType, JSON.stringify(rawJson)]
  );
}

async function insertMatchRow({
  releaseId,
  discogsReleaseId,
  discogsMasterId,
  confidenceScore,
  matchMethod,
  status,
}) {
  await pool.query(
    `
    INSERT INTO release_discogs_matches
        (release_id, discogs_release_id, discogs_master_id, confidence_score, match_method, status)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [releaseId, discogsReleaseId, discogsMasterId, confidenceScore, matchMethod, status]
  );
}

async function persistReleaseEnrichment({
  releaseId,
  discogsReleaseId,
  discogsMasterId,
  confidenceScore,
  releaseJson,
}) {
  const genres = safeStringArray(releaseJson?.genres);
  const styles = safeStringArray(releaseJson?.styles);
  const country = releaseJson?.country ? String(releaseJson.country).trim() : null;
  const labels = extractLabels(releaseJson);
  const { coverUrl, thumbUrl } = pickImages(releaseJson);
  const rating = extractRating(releaseJson);
  
  await pool.query(
    `
    UPDATE releases
    SET
      discogs_release_id        = COALESCE($2, discogs_release_id),
      discogs_master_id         = COALESCE($3, discogs_master_id),
      discogs_confidence        = COALESCE($4, discogs_confidence),
      discogs_matched_at        = COALESCE(discogs_matched_at, now()),

      discogs_genres            = $5,
      discogs_styles            = $6,
      discogs_country           = $7,
      discogs_labels            = $8,
      discogs_cover_image_url   = $9,
      discogs_thumb_url         = $10,
      discogs_rating_average    = $11,
      discogs_rating_count      = $12,

      discogs_last_refreshed_at = now(),
      discogs_refreshed_at      = now()
    WHERE id = $1
    `,
    [
      releaseId,
      discogsReleaseId,
      discogsMasterId,
      confidenceScore,
      genres,
      styles,
      country,
      labels,
      coverUrl,
      thumbUrl,
      rating.average,
      rating.count,
    ]
  );

  // Keep release_tags in sync with Discogs genres/styles (Option B: display both as votable tags)
  await syncDiscogsTagsToReleaseTags({ releaseId, genres, styles });
}

async function syncDiscogsTagsToReleaseTags({ releaseId, genres, styles }) {
  // We do NOT delete anything here (safe-by-default).
  // We only ensure Discogs-derived tags exist in:
  // - tags(name)
  // - release_tags(release_id, tag_id, source='discogs_genre'|'discogs_style')

  const genreList = Array.isArray(genres) ? genres : [];
  const styleList = Array.isArray(styles) ? styles : [];

  // Helper to upsert tags + attach
  const attach = async (name, source) => {
    const tagName = String(name || "").trim();
    if (!tagName) return;

    const tagRow = await pool.query(
      `
      INSERT INTO tags (name)
      VALUES ($1)
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
      `,
      [tagName]
    );

    const tagId = tagRow.rows[0].id;

    await pool.query(
      `
      INSERT INTO release_tags (release_id, tag_id, source)
      VALUES ($1, $2, $3)
      ON CONFLICT (release_id, tag_id) DO NOTHING
      `,
      [releaseId, tagId, source]
    );
  };

  for (const g of genreList) {
    await attach(g, "discogs_genre");
  }
  for (const s of styleList) {
    await attach(s, "discogs_style");
  }
}

async function refreshExistingDiscogsMatch(releaseRow) {
  const releaseId = releaseRow.id;
  const discogsReleaseId = releaseRow.discogs_release_id;

  const releaseJson = await discogsGetRelease(discogsReleaseId);

  await upsertDiscogsEntity({
    discogsId: discogsReleaseId,
    entityType: "release",
    rawJson: releaseJson,
  });

  const discogsMasterId =
    releaseJson?.master_id != null ? Number(releaseJson.master_id) : null;

  const confidenceScore =
    releaseRow.discogs_confidence != null ? Number(releaseRow.discogs_confidence) : 100;

  await insertMatchRow({
    releaseId,
    discogsReleaseId,
    discogsMasterId,
    confidenceScore,
    matchMethod: "refresh_existing",
    status: "matched",
  });

  await persistReleaseEnrichment({
    releaseId,
    discogsReleaseId,
    discogsMasterId,
    confidenceScore,
    releaseJson,
  });

  return {
    release_id: releaseId,
    status: "matched",
    confidence_score: confidenceScore,
    discogs_release_id: discogsReleaseId,
    discogs_master_id: discogsMasterId,
    refreshed: true,
  };
}

export async function matchDiscogsForRelease(releaseRow) {
  if (!releaseRow || !releaseRow.id) {
    throw new Error("matchDiscogsForRelease: missing releaseRow.id");
  }

  // Fast path: already matched -> ONE API call refresh
  if (Number.isInteger(releaseRow.discogs_release_id)) {
    try {
      return await refreshExistingDiscogsMatch(releaseRow);
    } catch (err) {
      if (isDiscogsConfigError(err)) {
        return {
          release_id: releaseRow.id,
          status: "rejected",
          confidence_score: 0,
          discogs_release_id: releaseRow.discogs_release_id || null,
          discogs_master_id: releaseRow.discogs_master_id || null,
          debug: { reason: "discogs_config_error", message: err.message },
        };
      }
      if (isDiscogsTemporaryError(err)) {
        return {
          release_id: releaseRow.id,
          status: "rejected",
          confidence_score: 0,
          discogs_release_id: releaseRow.discogs_release_id || null,
          discogs_master_id: releaseRow.discogs_master_id || null,
          debug: { reason: "discogs_temporary_error_on_refresh", message: err.message, status: err.status },
        };
      }
      return {
        release_id: releaseRow.id,
        status: "rejected",
        confidence_score: 0,
        discogs_release_id: releaseRow.discogs_release_id || null,
        discogs_master_id: releaseRow.discogs_master_id || null,
        debug: { reason: "refresh_failed", message: err?.message || String(err) },
      };
    }
  }

  const rawArtist = String(releaseRow.artist_name || "").trim();
  const rawTitle = String(releaseRow.title || "").trim();
  const year = releaseRow.release_date ? new Date(releaseRow.release_date).getFullYear() : null;

  if (!rawArtist || !rawTitle) {
    return {
      release_id: releaseRow.id,
      status: "rejected",
      confidence_score: 0,
      discogs_release_id: null,
      discogs_master_id: null,
      debug: { reason: "missing_artist_or_title" },
    };
  }

  const artistCandidates = [rawArtist];
  const splitSlash = rawArtist.split("/")[0]?.trim();
  const splitComma = rawArtist.split(",")[0]?.trim();
  if (splitSlash && splitSlash !== rawArtist) artistCandidates.push(splitSlash);
  if (splitComma && splitComma !== rawArtist) artistCandidates.push(splitComma);

  const attemptsTried = [];
  let bestSearch = null;

  for (const a of artistCandidates.slice(0, 3)) {
    try {
      const attempt = year ? { artist: a, title: rawTitle, year } : { artist: a, title: rawTitle };
      attemptsTried.push(attempt);
      const search = await discogsSearchRelease(attempt);
      bestSearch = search;
      if (Array.isArray(search?.results) && search.results.length) break;
    } catch (err) {
      if (isDiscogsConfigError(err)) {
        return {
          release_id: releaseRow.id,
          status: "rejected",
          confidence_score: 0,
          discogs_release_id: null,
          discogs_master_id: null,
          debug: { reason: "discogs_config_error", message: err.message },
        };
      }
      if (isDiscogsTemporaryError(err)) continue;
      return {
        release_id: releaseRow.id,
        status: "rejected",
        confidence_score: 0,
        discogs_release_id: null,
        discogs_master_id: null,
        debug: { reason: "discogs_search_error", message: String(err?.message || err) },
      };
    }
  }

  const results = Array.isArray(bestSearch?.results) ? bestSearch.results : [];
  if (!results.length) {
    await insertMatchRow({
      releaseId: releaseRow.id,
      discogsReleaseId: null,
      discogsMasterId: null,
      confidenceScore: 0,
      matchMethod: "search_title_artist",
      status: "rejected",
    });

    return {
      release_id: releaseRow.id,
      status: "rejected",
      confidence_score: 0,
      discogs_release_id: null,
      discogs_master_id: null,
      debug: { reason: "no_discogs_results", raw_artist: rawArtist, raw_title: rawTitle, year, attempts_tried: attemptsTried.length },
    };
  }

  const scored = results.slice(0, 10).map((r) => ({ hit: r, score: scoreResult(releaseRow, r) }));
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const bestScore = best.score;

  let status = "rejected";
  if (bestScore >= 75) status = "matched";
  else if (bestScore >= 50) status = "suggested";

  const discogsReleaseId = best.hit?.id ?? null;
  const discogsMasterId = best.hit?.master_id ?? null;

  await insertMatchRow({
    releaseId: releaseRow.id,
    discogsReleaseId,
    discogsMasterId,
    confidenceScore: bestScore,
    matchMethod: "search_title_artist",
    status,
  });

  if (status === "matched" && discogsReleaseId) {
    try {
      const releaseJson = await discogsGetRelease(discogsReleaseId);

      await upsertDiscogsEntity({
        discogsId: discogsReleaseId,
        entityType: "release",
        rawJson: releaseJson,
      });

      const masterIdFromJson =
        releaseJson?.master_id != null ? Number(releaseJson.master_id) : discogsMasterId;

      await persistReleaseEnrichment({
        releaseId: releaseRow.id,
        discogsReleaseId,
        discogsMasterId: masterIdFromJson,
        confidenceScore: bestScore,
        releaseJson,
      });
    } catch (err) {
      console.warn("[Discogs] hydrate failed after match:", err?.message || err);

      // Still write pointers if hydration failed
      try {
        await pool.query(
          `
          UPDATE releases
          SET
            discogs_release_id = $2,
            discogs_master_id  = $3,
            discogs_confidence = $4,
            discogs_matched_at = now()
          WHERE id = $1
          `,
          [releaseRow.id, discogsReleaseId, discogsMasterId, bestScore]
        );
      } catch (e2) {
        console.error("[Discogs] pointer update failed after hydrate error:", e2?.message || e2);
      }
    }
  }

  return {
    release_id: releaseRow.id,
    status,
    confidence_score: bestScore,
    discogs_release_id: discogsReleaseId,
    discogs_master_id: discogsMasterId,
    debug: {
      raw_artist: rawArtist,
      raw_title: rawTitle,
      year: year || null,
      attempts_tried: attemptsTried.length,
      best_title: String(best.hit?.title || ""),
    },
  };
}
