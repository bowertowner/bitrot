// backend/src/services/discogsMatcher.js

import pool from "../db/pool.js";
import {
  discogsSearchRelease,
  discogsGetRelease,
  discogsGetMaster,
  isDiscogsTemporaryError,
  isDiscogsConfigError,
} from "./discogsClient.js";

// Utility: normalize strings for scoring
function normalize(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/\(\d+\)/g, "") // remove Discogs artist disambiguators like (26)
    .replace(/[^\w\s]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Discogs search results often use title: "Artist - Release Title"
function parseDiscogsSearchHit(hit) {
  const raw = String(hit?.title || "");
  const parts = raw.split(" - ");
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(" - ").trim();
    return { artist, title };
  }
  return {
    artist: String(hit?.artist || "").trim(),
    title: raw.trim(),
  };
}

function scoreResult(releaseRow, hit) {
  const relTitle = normalize(releaseRow.title);
  const relArtist = normalize(releaseRow.artist_name);

  const parsed = parseDiscogsSearchHit(hit);
  const hitTitle = normalize(parsed.title);
  const hitArtist = normalize(parsed.artist);

  let score = 0;

  // Title score
  if (relTitle && hitTitle && relTitle === hitTitle) score += 40;
  else if (
    relTitle &&
    hitTitle &&
    (hitTitle.includes(relTitle) || relTitle.includes(hitTitle))
  ) {
    score += 25;
  }

  // Artist score
  if (relArtist && hitArtist && relArtist === hitArtist) score += 30;
  else if (
    relArtist &&
    hitArtist &&
    (hitArtist.includes(relArtist) || relArtist.includes(hitArtist))
  ) {
    score += 15;
  }

  // Year score
  const hitYear = hit?.year ? Number(hit.year) : null;
  const relYear = releaseRow.release_date
    ? new Date(releaseRow.release_date).getFullYear()
    : null;

  if (hitYear && relYear && hitYear === relYear) score += 10;

  return Math.min(score, 100);
}

function splitArtists(raw) {
  const s = (raw || "").trim();
  if (!s) return [];

  const parts = s
    .split(/\s*(\+|&|,|\/| x |×| feat\. | featuring | w\/ )\s*/i)
    .map((p) => p.trim())
    .filter(
      (p) => p && !["+", "&", ",", "/", "x", "×"].includes(p.toLowerCase())
    );

  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function stripArtistPrefixFromTitle(artist, title) {
  const a = (artist || "").trim();
  const t = (title || "").trim();
  if (!a || !t) return t;

  const separators = [" - ", " – ", " — ", ": "];
  for (const sep of separators) {
    if (t.toLowerCase().startsWith((a + sep).toLowerCase())) {
      return t.slice((a + sep).length).trim();
    }
  }
  return t;
}

function titleVariants(rawTitle, rawArtist) {
  const original = (rawTitle || "").trim();
  if (!original) return [];

  const variants = new Set();
  variants.add(original);

  const stripped = stripArtistPrefixFromTitle(rawArtist, original);
  if (stripped && stripped !== original) variants.add(stripped);

  // Soundtrack normalization
  variants.add(original.replace(/\bOST\b/i, "").trim());
  variants.add(original.replace(/\bOriginal Soundtrack\b/i, "").trim());
  variants.add(original.replace(/\bSoundtrack\b/i, "").trim());

  // Remove common "digital" suffixes
  const digitalPatterns = [
    /\s*\(digital\)\s*/gi,
    /\s*\(digitals\)\s*/gi,
    /\s*\(digital release\)\s*/gi,
  ];
  for (const pat of digitalPatterns) {
    for (const v of [...variants]) {
      variants.add(v.replace(pat, " ").trim());
    }
  }

  return [...variants]
    .map((x) => x.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);
}

async function cacheSearchResults(results) {
  for (const r of results) {
    if (!r || typeof r.id !== "number") continue;

    await pool.query(
      `
      INSERT INTO discogs_entities (discogs_id, entity_type, raw_json)
      VALUES ($1, 'search_result', $2)
      ON CONFLICT (discogs_id, entity_type)
      DO UPDATE SET raw_json = EXCLUDED.raw_json,
                    last_synced_at = now()
      `,
      [r.id, r]
    );
  }
}

async function cacheReleaseAndMasterIfPossible(discogsReleaseId, discogsMasterId) {
  if (!discogsReleaseId) return;

  try {
    const full = await discogsGetRelease(discogsReleaseId);

    await pool.query(
      `
      INSERT INTO discogs_entities (discogs_id, entity_type, raw_json)
      VALUES ($1, 'release', $2)
      ON CONFLICT (discogs_id, entity_type)
      DO UPDATE SET raw_json = EXCLUDED.raw_json,
                    last_synced_at = now()
      `,
      [discogsReleaseId, full]
    );

    if (discogsMasterId) {
      const master = await discogsGetMaster(discogsMasterId);

      await pool.query(
        `
        INSERT INTO discogs_entities (discogs_id, entity_type, raw_json)
        VALUES ($1, 'master', $2)
        ON CONFLICT (discogs_id, entity_type)
        DO UPDATE SET raw_json = EXCLUDED.raw_json,
                      last_synced_at = now()
        `,
        [discogsMasterId, master]
      );
    }
  } catch (err) {
    // Temporary errors can happen here too; don't poison the match table.
    console.warn("[Discogs] cache release/master failed:", err?.message || err);
  }
}

async function runSearchAttempts({ artistCandidates, titleCandidates, year }) {
  const attempts = [];
  let bestSearch = null;
  let bestResults = [];

  const MAX_ATTEMPTS = 12;

  for (const a of artistCandidates) {
    for (const t of titleCandidates) {
      const attempt = year ? { artist: a, title: t, year } : { artist: a, title: t };
      attempts.push(attempt);

      const search = await discogsSearchRelease(attempt);
      const results = Array.isArray(search?.results) ? search.results.slice(0, 5) : [];

      if (results.length > 0) {
        bestSearch = search;
        bestResults = results;
        return { attempts, bestSearch, bestResults };
      }

      if (attempts.length >= MAX_ATTEMPTS) {
        return { attempts, bestSearch, bestResults };
      }
    }

    if (attempts.length >= MAX_ATTEMPTS) {
      return { attempts, bestSearch, bestResults };
    }
  }

  return { attempts, bestSearch, bestResults };
}

export async function matchDiscogsForRelease(releaseRow) {
  if (!releaseRow || !releaseRow.id) {
    throw new Error("matchDiscogsForRelease: missing releaseRow.id");
  }

  const rawArtist = (releaseRow.artist_name || "").trim();
  const rawTitle = (releaseRow.title || "").trim();

  const year = releaseRow.release_date
    ? new Date(releaseRow.release_date).getFullYear()
    : undefined;

  console.log(`[Discogs] Matching release: ${releaseRow.id}`);
  console.log(
    `[Discogs] Using raw artist="${rawArtist}" raw title="${rawTitle}" year="${year || ""}"`
  );

  if (!rawArtist || !rawTitle) {
    // Do not write a match row if we don't have key fields.
    return {
      release_id: releaseRow.id,
      status: "rejected",
      confidence_score: 0,
      discogs_release_id: null,
      discogs_master_id: null,
      debug: { reason: "missing_artist_or_title" },
    };
  }

  const artistParts = splitArtists(rawArtist);
  const artistCandidates = [rawArtist, ...artistParts];

  const seenA = new Set();
  const uniqueArtistCandidates = [];
  for (const a of artistCandidates) {
    const key = a.toLowerCase();
    if (!seenA.has(key) && a.trim()) {
      seenA.add(key);
      uniqueArtistCandidates.push(a.trim());
    }
  }

  const titleCandidates = titleVariants(rawTitle, rawArtist);

  let attempts = [];
  let bestSearch = null;
  let bestResults = [];

  try {
    const r1 = await runSearchAttempts({
      artistCandidates: uniqueArtistCandidates,
      titleCandidates,
      year: year || undefined,
    });
    attempts = r1.attempts;
    bestSearch = r1.bestSearch;
    bestResults = r1.bestResults;

    if (bestResults.length === 0) {
      const r2 = await runSearchAttempts({
        artistCandidates: uniqueArtistCandidates,
        titleCandidates,
        year: undefined,
      });

      attempts = attempts.concat(
        r2.attempts.map((a) => ({ ...a, note: "no-year-fallback" }))
      );
      bestSearch = r2.bestSearch || bestSearch;
      bestResults = r2.bestResults;
    }
  } catch (err) {
    // IMPORTANT: if Discogs is temporarily failing (429/502/HTML), do not insert
    // a "rejected" row. This prevents poison “not found” results.
    if (isDiscogsConfigError(err)) {
      console.error("[Discogs] config error:", err.message);
      return {
        release_id: releaseRow.id,
        status: "rejected",
        confidence_score: 0,
        discogs_release_id: null,
        discogs_master_id: null,
        debug: { reason: "discogs_not_configured" },
      };
    }

    if (isDiscogsTemporaryError(err)) {
      console.warn("[Discogs] temporary error (no DB write):", err.message);
      return {
        release_id: releaseRow.id,
        status: "rejected",
        confidence_score: 0,
        discogs_release_id: null,
        discogs_master_id: null,
        debug: {
          reason: "discogs_temporary_error",
          message: err.message,
          status: err.status,
          attempts_tried: attempts.length,
        },
      };
    }

    console.error("[Discogs] search error:", err);
    return {
      release_id: releaseRow.id,
      status: "rejected",
      confidence_score: 0,
      discogs_release_id: null,
      discogs_master_id: null,
      debug: { reason: "discogs_search_error", message: String(err?.message || err) },
    };
  }

  if (bestResults.length > 0) {
    await cacheSearchResults(bestResults);
  }

  if (bestResults.length === 0) {
    // This is a true "no results" case. Write rejected row so it "sticks".
    await pool.query(
      `
      INSERT INTO release_discogs_matches
          (release_id, discogs_release_id, discogs_master_id, confidence_score, match_method, status)
      VALUES ($1, NULL, NULL, 0, 'search_title_artist', 'rejected')
      `,
      [releaseRow.id]
    );

    return {
      release_id: releaseRow.id,
      status: "rejected",
      confidence_score: 0,
      discogs_release_id: null,
      discogs_master_id: null,
      debug: {
        reason: "no_discogs_results",
        raw_artist: rawArtist,
        raw_title: rawTitle,
        year: year || null,
        attempts_tried: attempts.length,
        discogs_pagination_items:
          typeof bestSearch?.pagination?.items === "number"
            ? bestSearch.pagination.items
            : 0,
      },
    };
  }

  const scored = bestResults.map((r) => ({
    hit: r,
    score: scoreResult(releaseRow, r),
  }));
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const bestScore = best.score;

  let status = "rejected";
  if (bestScore >= 75) status = "matched";
  else if (bestScore >= 50) status = "suggested";

  const discogsReleaseId = best.hit.id || null;
  const discogsMasterId = best.hit.master_id || null;

  await pool.query(
    `
    INSERT INTO release_discogs_matches
        (release_id, discogs_release_id, discogs_master_id, confidence_score, match_method, status)
    VALUES ($1, $2, $3, $4, 'search_title_artist', $5)
    `,
    [releaseRow.id, discogsReleaseId, discogsMasterId, bestScore, status]
  );

  // Cache release JSON for both matched and suggested
  if (discogsReleaseId && (status === "matched" || status === "suggested")) {
    await cacheReleaseAndMasterIfPossible(discogsReleaseId, discogsMasterId);
  }

  // Only write releases.* Discogs columns for matched
  if (status === "matched" && discogsReleaseId) {
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
    } catch (err) {
      console.error("[Discogs] error updating releases table:", err);
    }
  }

  return {
    release_id: releaseRow.id,
    status,
    confidence_score: bestScore,
    discogs_release_id: discogsReleaseId,
    discogs_master_id: discogsMasterId,
  };
}
