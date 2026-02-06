/* Bandcamp Minimum Price Badges (Chrome MV3)
   Runs on artist/label /music pages only.
   Uses background service worker fetch (background.js) to fetch Bandcamp pages.
   Now also sends release metadata + encounters to Bitrot.
*/

(() => {
  // Only operate on /music discography pages
  if (!location.pathname.startsWith("/music")) return;

  // Bitrot backend base URL (local dev)
  const BITROT_API = "http://localhost:3000";

  // ============ SPEED + TEST CONTROLS ============

  // Fast mode: higher concurrency + smaller gaps.
  const FAST_MODE = true;

  // Hold SHIFT while the /music page loads to bypass cache for this pageview.
  const BYPASS_CACHE_THIS_LOAD =
    !!window.__BCPB_BYPASS_CACHE__ || window.event?.shiftKey === true;

  // If you want a permanent cache bypass while testing, set to true:
  const ALWAYS_BYPASS_CACHE = false;

  // Cache key + TTL for local badge cache
  const CACHE_KEY = "bcpb_v11";
  const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Throttle settings
  const REQUEST_GAP_MS = FAST_MODE ? 150 : 1800;
  const MAX_CONCURRENCY = FAST_MODE ? 4 : 1;

  // Retry / cooldown
  const RETRY_BACKOFF_MS = [0, 1500, 5000, 12000];
  const COOLDOWN_ON_429_MS = 60000;

  // Timeout settings
  const BG_MESSAGE_TIMEOUT_MS = 15000;
  const FETCH_TOTAL_TIMEOUT_MS = 20000;

  // ===============================================

  let lastRequestAt = 0;
  let active = 0;
  let globalCooldownUntil = 0;

  const queue = [];
  let queuePumpRunning = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function now() {
    return Date.now();
  }

  function withTimeout(promise, ms, label = "timeout") {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(label)), ms)
      ),
    ]);
  }

  function normalizeUrl(href) {
    try {
      return new URL(href, location.href).toString();
    } catch {
      return href;
    }
  }

  function isAlbumOrTrackLink(a) {
    const href = a.getAttribute("href") || "";
    return href.includes("/album/") || href.includes("/track/");
  }

  function createBadge(initialText) {
    const wrap = document.createElement("div");
    wrap.className = "bcpb-wrap";

    const badge = document.createElement("span");
    badge.className = "bcpb-badge bcpb-muted";
    badge.textContent = initialText;

    wrap.appendChild(badge);
    return { wrap, badge };
  }

  function setBadge(badgeEl, label, kind) {
    badgeEl.className = "bcpb-badge";
    if (kind === "green") badgeEl.classList.add("bcpb-green");
    else if (kind === "blue") badgeEl.classList.add("bcpb-blue");
    else if (kind === "black") badgeEl.classList.add("bcpb-black");
    else badgeEl.classList.add("bcpb-muted");

    badgeEl.textContent = label;
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (res) => resolve(res[key]));
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  function decodeHtmlEntities(str) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = str;
    return textarea.value;
  }

  function decodeUntilStable(str, maxRounds = 4) {
    let current = str;
    for (let i = 0; i < maxRounds; i++) {
      const decoded = decodeHtmlEntities(current);
      if (decoded === current) break;
      current = decoded;
    }
    return current;
  }

  function pageSignalsOwnedOrUnreleased(html) {
    const lower = html.toLowerCase();

    if (lower.includes("you own this")) {
      return { label: "OWNED", kind: "black" };
    }

    const unreleasedRe = /pre-order\s+digital\s+(album|track)/i;
    if (unreleasedRe.test(html)) {
      return { label: "UNRELEASED", kind: "black" };
    }

    return null;
  }

  function detectBlockedOrInterstitial(html) {
    const lower = html.toLowerCase();
    if (lower.includes("enable javascript")) return "JS REQUIRED";
    if (lower.includes("checking your browser")) return "CHECKING";
    if (lower.includes("attention required")) return "BLOCKED";
    if (lower.includes("unusual traffic")) return "BLOCKED";
    if (lower.includes("cloudflare")) return "BLOCKED";
    if (lower.includes("please wait") && lower.includes("redirecting"))
      return "REDIRECT";
    return null;
  }

  function findTralbumDataFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");

    const tralbumNode =
      doc.querySelector("[data-tralbum]") ||
      doc.querySelector("#tralbum-data[data-tralbum]") ||
      doc.querySelector("div[data-tralbum]");

    if (tralbumNode) {
      const raw = tralbumNode.getAttribute("data-tralbum") || "";
      const decoded = decodeUntilStable(raw);
      try {
        return JSON.parse(decoded);
      } catch {
        // fall through
      }
    }

    // Regex fallback for data-tralbum="..."
    {
      const m = html.match(/data-tralbum\s*=\s*"([^"]+)"/i);
      if (m && m[1]) {
        const decoded = decodeUntilStable(m[1]);
        try {
          return JSON.parse(decoded);
        } catch {
          // fall through
        }
      }
    }

    // Fallback: #pagedata[data-blob]
    const pd = doc.querySelector("#pagedata[data-blob]");
    if (pd) {
      const rawBlob = pd.getAttribute("data-blob") || "";
      const decodedBlob = decodeUntilStable(rawBlob);
      try {
        const blobObj = JSON.parse(decodedBlob);
        if (blobObj && blobObj.tralbum_data) return blobObj.tralbum_data;
        return blobObj;
      } catch {
        // fall through
      }
    }

    // Regex fallback for data-blob="..."
    {
      const m = html.match(
        /id="pagedata"[^>]*data-blob\s*=\s*"([^"]+)"/i
      );
      if (m && m[1]) {
        const decodedBlob = decodeUntilStable(m[1]);
        try {
          const blobObj = JSON.parse(decodedBlob);
          if (blobObj && blobObj.tralbum_data) return blobObj.tralbum_data;
          return blobObj;
        } catch {
          // ignore
        }
      }
    }

    return null;
  }
  
    function extractTagsFromHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");

      // Common Bandcamp tag containers; we over-shoot a bit to be safe.
      const selectors = [
        ".tralbum-tags a",
        ".tag .item",
        ".tag a",
        "#albumTags a",
        "#trackTags a",
        ".tags a"
      ];

      const set = new Set();

      for (const sel of selectors) {
        const links = doc.querySelectorAll(sel);
        for (const a of links) {
          const txt = (a.textContent || "").trim();
          if (!txt) continue;
          set.add(txt);
        }
      }

      return Array.from(set);
    } catch {
      return [];
    }
  }


  function computePriceLabelFromTralbum(tralbum) {
    if (!tralbum || typeof tralbum !== "object") {
      return { label: "?", kind: "muted" };
    }

    // Currency symbol fallback
    const currencySymbol =
      tralbum.currency_symbol ||
      tralbum.currency ||
      (tralbum.price && tralbum.price.currency_symbol) ||
      "$";

    // Bandcamp uses multiple variants depending on page type/rendering.
    const minCandidates = [
      tralbum.minimum_price,
      tralbum.min_price,
      tralbum.download_min_price,
      // extra variants
      tralbum.min_price_amount,
      tralbum.minimum_price_amount,
      tralbum.download_min_price_amount,
      tralbum.download_minimum_price,
      tralbum.download_minimum_price_amount,
      // sometimes nested
      tralbum.price && tralbum.price.minimum_price,
      tralbum.price && tralbum.price.min_price,
      tralbum.price && tralbum.price.download_min_price,
    ];

    let minVal = null;
    for (const v of minCandidates) {
      if (v === null || v === undefined || v === "") continue;
      const n = Number(v);
      if (!Number.isNaN(n)) {
        minVal = n;
        break;
      }
    }

    if (minVal !== null) {
      if (minVal <= 0) {
        return { label: "FREE DL", kind: "green" };
      }
      return { label: `${currencySymbol}${minVal}+`, kind: "blue" };
    }

    const priceCandidates = [
      tralbum.price,
      tralbum.download_price,
      tralbum.current_price,
      // sometimes nested
      tralbum.price && tralbum.price.amount,
      tralbum.price && tralbum.price.price,
      tralbum.price && tralbum.price.value,
    ];

    let priceVal = null;
    for (const v of priceCandidates) {
      if (v === null || v === undefined || v === "") continue;
      const n = Number(v);
      if (!Number.isNaN(n)) {
        priceVal = n;
        break;
      }
    }

    if (priceVal !== null) {
      if (priceVal <= 0) {
        return { label: "FREE DL", kind: "green" };
      }
      return { label: `${currencySymbol}${priceVal}`, kind: "blue" };
    }

    return { label: "?", kind: "muted" };
  }

  // Buy line parser plus targeted free download detection near buy module.
  function computePriceLabelFromBuyLine(html) {
    if (!html || typeof html !== "string") {
      return { label: "?", kind: "muted" };
    }

    const windowMatch = html.match(
      /Buy Digital (?:Album|Track)[\s\S]{0,500}/i
    );
    if (windowMatch && windowMatch[0]) {
      const windowText = windowMatch[0];

      // Symbol + numeric amount, e.g. $5 or £7.50
      const m1 = windowText.match(
        /([£$€¥])\s*([0-9]+(?:[.,][0-9]+)?)/
      );
      if (m1 && m1[1] && m1[2]) {
        const symbol = m1[1];
        const amountRaw = m1[2].replace(",", ".");
        const amount = Number(amountRaw);
        if (!Number.isNaN(amount)) {
          if (amount <= 0) {
            return { label: "FREE DL", kind: "green" };
          }
          const plus = /or more/i.test(windowText);
          return {
            label: plus ? `${symbol}${amount}+` : `${symbol}${amount}`,
            kind: "blue",
          };
        }
      }

      // Amount + currency code, e.g. 5 USD
      const m2 = windowText.match(
        /([0-9]+(?:[.,][0-9]+)?)\s*(USD|GBP|EUR|CAD|AUD|NZD|JPY|SEK|NOK|DKK|CHF)/i
      );
      if (m2 && m2[1]) {
        const amountRaw = m2[1].replace(",", ".");
        const amount = Number(amountRaw);
        if (!Number.isNaN(amount)) {
          if (amount <= 0) {
            return { label: "FREE DL", kind: "green" };
          }
          const plus = /or more/i.test(windowText);
          return {
            label: plus ? `$${amount}+` : `$${amount}`,
            kind: "blue",
          };
        }
      }

      // Name-your-price patterns
      if (/name your price/i.test(windowText)) {
        return { label: "FREE DL", kind: "green" };
      }
      if (/free download/i.test(windowText)) {
        return { label: "FREE DL", kind: "green" };
      }
      if (/or more/i.test(windowText)) {
        return { label: "NYP", kind: "blue" };
      }
    }

    // If no buy window, look for free-download CTA near the buy module (targeted, not global).
    const freeDlSignals = [
      /id="buyAlbum"[\s\S]{0,1400}free download/i,
      /id="buyTrack"[\s\S]{0,1400}free download/i,
      /free download[\s\S]{0,500}id="buyAlbum"/i,
      /free download[\s\S]{0,500}id="buyTrack"/i,
      /href="[^"]*\/download\?/i,
      /download\?from=bandcamp/i,
    ];

    for (const re of freeDlSignals) {
      if (re.test(html)) {
        return { label: "FREE DL", kind: "green" };
      }
    }

    return { label: "?", kind: "muted" };
  }

  // ---- Bitrot helpers ----

    function buildBitrotPayload(url, tralbum, computed, extraTags) {
    if (!tralbum || typeof tralbum !== "object") return null;

    const artist =
      tralbum.artist ||
      tralbum.band_name ||
      (tralbum.current && tralbum.current.artist) ||
      "";

    const title =
      (tralbum.current && tralbum.current.title) ||
      tralbum.title ||
      tralbum.album_title ||
      "";

    if (!artist || !title) return null;

    // Release date candidates
    const releaseDateRaw =
      tralbum.album_release_date ||
      tralbum.release_date ||
      tralbum.publish_date ||
      (tralbum.current && tralbum.current.release_date) ||
      null;

    // Tags from tralbum
    let tags = [];
    if (Array.isArray(tralbum.tags)) {
      tags = tralbum.tags;
    } else if (tralbum.current && Array.isArray(tralbum.current.tags)) {
      tags = tralbum.current.tags;
    }

    // Merge in any extra tags from HTML
    if (Array.isArray(extraTags)) {
      const set = new Set(
        tags
          .map((t) => (typeof t === "string" ? t.trim() : ""))
          .filter((t) => t.length > 0)
      );
      for (const raw of extraTags) {
        const name = (raw || "").trim();
        if (!name) continue;
        // De-dupe case-insensitively
        let has = false;
        for (const existing of set) {
          if (existing.toLowerCase() === name.toLowerCase()) {
            has = true;
            break;
          }
        }
        if (!has) {
          set.add(name);
        }
      }
      tags = Array.from(set);
    } else {
      tags = tags
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter((t) => t.length > 0);
    }

    // Tracks
    let tracksPayload = [];
    if (Array.isArray(tralbum.trackinfo)) {
      tracksPayload = tralbum.trackinfo.map((t) => ({
        title: t.title || "",
        duration:
          typeof t.duration === "number"
            ? Math.round(t.duration)
            : null,
      }));
    }

    // Price info from computed badge state
    const price_label =
      computed && typeof computed.label === "string"
        ? computed.label
        : null;
    const is_free =
      computed && computed.kind === "green" ? true : null;

    return {
      artist,
      title,
      platform: "bandcamp",
      platform_release_id: url,
      url,
      release_date: releaseDateRaw,
      tags,
      tracks: tracksPayload,
      price_label,
      is_free,
    };
  }

  async function sendToBitrot(url, tralbum, computed, extraTags) {
    try {
      const payload = buildBitrotPayload(
        url,
        tralbum,
        computed,
        extraTags
      );
      if (!payload) return;

      const lookupRes = await fetch(`${BITROT_API}/release/lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!lookupRes.ok) return;
      const data = await lookupRes.json();
      if (!data || !data.release_id) return;

      await fetch(`${BITROT_API}/user_encounter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          release_id: data.release_id,
          source: "extension:discography_grid",
        }),
      });
    } catch (e) {
      console.warn("[Bitrot] Error sending release:", e);
    }
  }



  // Background fetch wrapper with timeout (prevents hanging "...")
  function bgFetch(url) {
    return new Promise((resolve) => {
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({
          ok: false,
          status: 0,
          url,
          text: "bgFetch timeout",
        });
      }, BG_MESSAGE_TIMEOUT_MS);

      chrome.runtime.sendMessage({ type: "BCPB_FETCH", url }, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(
          res || { ok: false, status: 0, url, text: "no response" }
        );
      });
    });
  }

  async function fetchWithRetry(url) {
    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
      const backoff = RETRY_BACKOFF_MS[attempt];
      if (backoff > 0) await sleep(backoff);

      const cdRemaining = globalCooldownUntil - now();
      if (cdRemaining > 0) await sleep(cdRemaining);

      const res = await bgFetch(url);

      if (res && res.status === 429) {
        globalCooldownUntil = now() + COOLDOWN_ON_429_MS;
        continue;
      }

      if (!res || !res.ok) {
        if (attempt === RETRY_BACKOFF_MS.length - 1) {
          return (
            res || { ok: false, status: 0, url, text: "" }
          );
        }
        continue;
      }

      return res;
    }

    return { ok: false, status: 0, url, text: "" };
  }

  function enqueue(taskFn) {
    queue.push(taskFn);
    pumpQueue();
  }

  async function pumpQueue() {
    if (queuePumpRunning) return;
    queuePumpRunning = true;

    try {
      while (queue.length > 0) {
        if (active >= MAX_CONCURRENCY) {
          await sleep(10);
          continue;
        }

        const gapRemaining = lastRequestAt + REQUEST_GAP_MS - now();
        if (gapRemaining > 0) {
          await sleep(gapRemaining);
          continue;
        }

        const cdRemaining = globalCooldownUntil - now();
        if (cdRemaining > 0) {
          await sleep(cdRemaining);
          continue;
        }

        const fn = queue.shift();
        active += 1;
        lastRequestAt = now();

        fn()
          .catch(() => {})
          .finally(() => {
            active -= 1;
          });
      }
    } finally {
      queuePumpRunning = false;
    }
  }

  async function main() {
    const cache = (await storageGet(CACHE_KEY)) || {};
    const t = now();

    const links = Array.from(document.querySelectorAll("a")).filter(
      isAlbumOrTrackLink
    );

    for (const a of links) {
      // Avoid double-inject
      const next = a.nextElementSibling;
      if (
        next &&
        next.classList &&
        next.classList.contains("bcpb-wrap")
      ) {
        continue;
      }

      const url = normalizeUrl(a.href);

      const { wrap, badge } = createBadge("…");
      a.insertAdjacentElement("afterend", wrap);

      const bypassCache = ALWAYS_BYPASS_CACHE || BYPASS_CACHE_THIS_LOAD;

      // Cache hit (unless bypassing)
      if (!bypassCache) {
        const entry = cache[url];
        if (
          entry &&
          entry.t &&
          t - entry.t < TTL_MS &&
          entry.label
        ) {
          setBadge(badge, entry.label, entry.kind || "muted");
          continue;
        }
      }

      enqueue(async () => {
        try {
          const res = await withTimeout(
            fetchWithRetry(url),
            FETCH_TOTAL_TIMEOUT_MS,
            "fetchWithRetry timeout"
          );

          if (!res || !res.ok) {
            const code =
              res && typeof res.status === "number" ? res.status : 0;
            setBadge(
              badge,
              code ? `ERR ${code}` : "ERR",
              "muted"
            );
            return;
          }

          const html = res.text || "";

          const blocked = detectBlockedOrInterstitial(html);
          if (blocked) {
            setBadge(badge, blocked, "black");
            cache[url] = {
              label: blocked,
              kind: "black",
              t: now(),
            };
            await storageSet({ [CACHE_KEY]: cache });
            return;
          }

          const signal = pageSignalsOwnedOrUnreleased(html);
          if (signal) {
            setBadge(badge, signal.label, signal.kind);
            cache[url] = {
              label: signal.label,
              kind: signal.kind,
              t: now(),
            };
            await storageSet({ [CACHE_KEY]: cache });
            return;
          }

          const tralbum = findTralbumDataFromHtml(html);
          const fromTralbum = computePriceLabelFromTralbum(tralbum);

          const computed =
            fromTralbum && fromTralbum.label !== "?"
              ? fromTralbum
              : computePriceLabelFromBuyLine(html);

          // Extract visible HTML tags (e.g. "dubstep", "garage")
          const tagsFromHtml = extractTagsFromHtml(html);

          setBadge(badge, computed.label, computed.kind);

          // Save cache unless bypassing
          if (!bypassCache) {
            cache[url] = {
              label: computed.label,
              kind: computed.kind,
              t: now(),
            };
            await storageSet({ [CACHE_KEY]: cache });
          }

          // Send to Bitrot (with HTML tags) (fire-and-forget-ish)
          await sendToBitrot(url, tralbum, computed, tagsFromHtml);

        } catch {
          setBadge(badge, "ERR", "muted");
        }
      });
    }
  }

  main().catch(() => {});
})();
