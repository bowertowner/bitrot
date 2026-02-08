// backend/src/services/discogsClient.js
import fetch from "node-fetch";

const BASE_URL = "https://api.discogs.com";

// Throttle settings
const MIN_INTERVAL_MS = 1300; // slightly safer than 1100ms
const RETRY_429_WAIT_MS = 8000;
const RETRY_TEMP_WAIT_MS = 6000;

// A simple global mutex/queue so concurrent callers cannot bypass the throttle.
// This fixes the "multiple jobs calling throttle at the same time" race.
let throttleChain = Promise.resolve();
let lastCallAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyHtml(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html") || t.includes("<head");
}

class DiscogsTemporaryError extends Error {
  constructor(message, status, bodySnippet) {
    super(message);
    this.name = "DiscogsTemporaryError";
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

class DiscogsConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscogsConfigError";
  }
}

async function throttle() {
  // Serialize throttling across all concurrent requests
  throttleChain = throttleChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
    lastCallAt = Date.now();
  });
  await throttleChain;
}

async function discogsRequest(path) {
  const TOKEN = process.env.DISCOGS_TOKEN;
  const USER_AGENT = process.env.DISCOGS_USER_AGENT || "bitrot/0.1";

  if (!TOKEN) {
    throw new DiscogsConfigError(
      "Discogs token not configured (DISCOGS_TOKEN missing)"
    );
  }

  await throttle();

  const doFetch = async () =>
    fetch(BASE_URL + path, {
      headers: {
        "User-Agent": USER_AGENT,
        Authorization: `Discogs token=${TOKEN}`,
        Accept: "application/json",
      },
    });

  let res = await doFetch();

  // Handle 429
  if (res.status === 429) {
    const text = await res.text().catch(() => "");
    console.warn(
      "[Discogs] Rate limited (429). Waiting and retrying once..."
    );
    await sleep(RETRY_429_WAIT_MS);
    res = await doFetch();

    if (res.status === 429) {
      const text2 = await res.text().catch(() => "");
      throw new DiscogsTemporaryError(
        "Discogs rate limited (429) after retry",
        429,
        (text2 || text || "").slice(0, 300)
      );
    }
  }

  // Handle temporary upstream issues
  if ([502, 503, 504].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new DiscogsTemporaryError(
      `Discogs upstream error ${res.status}`,
      res.status,
      (text || "").slice(0, 300)
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const snippet = (text || "").slice(0, 300);
    if (isLikelyHtml(text)) {
      // Discogs sometimes returns HTML during edge issues; treat as temporary
      throw new DiscogsTemporaryError(
        `Discogs returned HTML error ${res.status}`,
        res.status,
        snippet
      );
    }
    throw new Error(`Discogs API error ${res.status}: ${snippet}`);
  }

  // Parse JSON safely. If it's HTML, treat as temporary.
  const rawText = await res.text();
  if (isLikelyHtml(rawText)) {
    throw new DiscogsTemporaryError(
      "Discogs returned HTML instead of JSON",
      502,
      rawText.slice(0, 300)
    );
  }

  try {
    return JSON.parse(rawText);
  } catch (e) {
    throw new DiscogsTemporaryError(
      "Discogs returned non-JSON response",
      502,
      rawText.slice(0, 300)
    );
  }
}

// ----------------------- Public API ------------------------

export async function discogsSearchRelease({ artist, title, label, catno, year }) {
  const params = new URLSearchParams();
  params.set("type", "release");

  const a = (artist || "").trim();
  const t = (title || "").trim();

  if (a) params.set("artist", a);
  if (t) params.set("release_title", t);

  // Fallback combined query
  const q = [a, t].filter(Boolean).join(" - ");
  if (q) params.set("q", q);

  if (label) params.set("label", String(label));
  if (catno) params.set("catno", String(catno));
  if (year) params.set("year", String(year));

  // One retry for temporary failures (not infinite)
  try {
    return await discogsRequest(`/database/search?${params.toString()}`);
  } catch (err) {
    if (err?.name === "DiscogsTemporaryError") {
      console.warn("[Discogs] temporary search error, retrying once...", {
        status: err.status,
      });
      await sleep(RETRY_TEMP_WAIT_MS);
      return discogsRequest(`/database/search?${params.toString()}`);
    }
    throw err;
  }
}

export async function discogsGetRelease(discogsReleaseId) {
  try {
    return await discogsRequest(`/releases/${discogsReleaseId}`);
  } catch (err) {
    if (err?.name === "DiscogsTemporaryError") {
      console.warn("[Discogs] temporary getRelease error, retrying once...", {
        status: err.status,
      });
      await sleep(RETRY_TEMP_WAIT_MS);
      return discogsRequest(`/releases/${discogsReleaseId}`);
    }
    throw err;
  }
}

export async function discogsGetMaster(discogsMasterId) {
  try {
    return await discogsRequest(`/masters/${discogsMasterId}`);
  } catch (err) {
    if (err?.name === "DiscogsTemporaryError") {
      console.warn("[Discogs] temporary getMaster error, retrying once...", {
        status: err.status,
      });
      await sleep(RETRY_TEMP_WAIT_MS);
      return discogsRequest(`/masters/${discogsMasterId}`);
    }
    throw err;
  }
}

export function isDiscogsTemporaryError(err) {
  return err && err.name === "DiscogsTemporaryError";
}

export function isDiscogsConfigError(err) {
  return err && err.name === "DiscogsConfigError";
}
