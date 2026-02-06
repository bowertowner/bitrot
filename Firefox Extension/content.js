// Firefox Bandcamp Minimum Price Badges + Bitrot integration
// Runs on /music discography pages only.

(async () => {
  if (!location.pathname.startsWith("/music")) return;

  const CACHE_KEY = "bcpb_v_ff_4";
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

  const MAX_CONCURRENCY = 4;
  const REQUEST_GAP_MS = 420;

  let GLOBAL_COOLDOWN_UNTIL = 0;

  const seen = new Set();

  // ---------- Small helpers ----------

  function normalize(url) {
    try {
      const u = new URL(url, location.href);
      u.hash = "";
      return u.toString();
    } catch {
      return url;
    }
  }

  async function getCache() {
    const out = await browser.storage.local.get(CACHE_KEY);
    return out && out[CACHE_KEY] ? out[CACHE_KEY] : {};
  }

  async function setCache(c) {
    await browser.storage.local.set({ [CACHE_KEY]: c });
  }

  function limiter(max) {
    let active = 0;
    const q = [];

    const run = () => {
      if (active >= max) return;
      if (q.length === 0) return;

      active += 1;
      const job = q.shift();

      job.fn()
        .then(job.resolve)
        .catch(job.reject)
        .finally(() => {
          active -= 1;
          setTimeout(run, REQUEST_GAP_MS);
          run();
        });
    };

    return (fn) =>
      new Promise((resolve, reject) => {
        q.push({ fn, resolve, reject });
        run();
      });
  }

  const limit = limiter(MAX_CONCURRENCY);

  function decodeHtmlEntities(str) {
    const txt = document.createElement("textarea");
    txt.innerHTML = str;
    return txt.value;
  }

  function parseJsonLoose(str) {
    if (!str) return null;
    let decoded = str;
    for (let i = 0; i < 4; i += 1) {
      const next = decodeHtmlEntities(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    try {
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }

  function parseTralbumFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");

    // data-tralbum
    const node =
      doc.querySelector("[data-tralbum]") ||
      doc.querySelector("#tralbum-data[data-tralbum]") ||
      doc.querySelector("div[data-tralbum]");
    if (node) {
      const raw = node.getAttribute("data-tralbum");
      const j = parseJsonLoose(raw);
      if (j) return j;
    }

    // #pagedata[data-blob]
    const pagedata = doc.querySelector("#pagedata[data-blob]");
    if (pagedata) {
      const rawBlob = pagedata.getAttribute("data-blob");
      const blob = parseJsonLoose(rawBlob);
      if (blob) {
        if (blob.tralbum_data) return blob.tralbum_data;
        return blob;
      }
    }

    // Fallback: regex for data-blob
    const m = html.match(
      /id="pagedata"[^>]*data-blob\s*=\s*"([^"]+)"/i
    );
    if (m && m[1]) {
      const blob = parseJsonLoose(m[1]);
      if (blob) {
        if (blob.tralbum_data) return blob.tralbum_data;
        return blob;
      }
    }

    return null;
  }

  function pageSignalsOwnedOrUnreleased(html) {
    const lower = html.toLowerCase();

    if (lower.includes("you own this")) {
      return { label: "OWNED", kind: "black" };
    }

    if (/\bpre-?order\s+digital\s+(album|track)\b/i.test(lower)) {
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

  function computePriceLabelFromTralbum(tralbum) {
    if (!tralbum || typeof tralbum !== "object") {
      return { label: "?", kind: "muted" };
    }

    const currencySymbol =
      tralbum.currency_symbol ||
      tralbum.currency ||
      (tralbum.price && tralbum.price.currency_symbol) ||
      "$";

    const minCandidates = [
      tralbum.minimum_price,
      tralbum.min_price,
      tralbum.download_min_price,
      tralbum.min_price_amount,
      tralbum.minimum_price_amount,
      tralbum.download_min_price_amount,
      tralbum.download_minimum_price,
      tralbum.download_minimum_price_amount,
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

  // Buy line parser + targeted free download detection
  function computePriceLabelFromBuyLine(html) {
    if (!html || typeof html !== "string") {
      return { label: "?", kind: "muted" };
    }

    const windowMatch = html.match(
      /Buy Digital (?:Album|Track)[\s\S]{0,500}/i
    );
    if (windowMatch && windowMatch[0]) {
      const windowText = windowMatch[0];

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

  function extractTagsFromHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");

      const selectors = [
        ".tralbum-tags a",
        ".tag .item",
        ".tag a",
        "#albumTags a",
        "#trackTags a",
        ".tags a",
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

  function findReleaseLinks() {
    return Array.from(
      document.querySelectorAll('a[href*="/album/"], a[href*="/track/"]')
    );
  }

  function ensureBadgeAfterLink(anchor) {
    const parent = anchor.parentElement;
    if (!parent) return null;

    const existing = parent.querySelector(":scope > .bcpb-wrap");
    if (existing) return existing;

    const wrap = document.createElement("div");
    wrap.className = "bcpb-wrap";

    const badge = document.createElement("span");
    badge.className = "bcpb-badge bcpb-muted";
    badge.textContent = "…";

    wrap.appendChild(badge);
    anchor.insertAdjacentElement("afterend", wrap);

    return wrap;
  }

  function setBadge(wrap, label, kind) {
    if (!wrap) return;
    const badge = wrap.querySelector(".bcpb-badge");
    if (!badge) return;

    badge.textContent = label || "?";
    badge.className = "bcpb-badge";
    if (kind === "green") badge.classList.add("bcpb-green");
    else if (kind === "blue") badge.classList.add("bcpb-blue");
    else if (kind === "black") badge.classList.add("bcpb-black");
    else badge.classList.add("bcpb-muted");
  }

  async function fetchWithCooldown(url) {
    const now = Date.now();
    if (GLOBAL_COOLDOWN_UNTIL > now) {
      await new Promise((r) =>
        setTimeout(r, GLOBAL_COOLDOWN_UNTIL - now)
      );
    }

    const resp = await fetch(url, { credentials: "include" });

    if (resp.status === 429) {
      GLOBAL_COOLDOWN_UNTIL = Date.now() + 60000;
    }

    return resp;
  }

  async function fetchWithRetry(url) {
    const backoffsMs = [0, 1500, 5000, 12000];

    for (let attempt = 0; attempt < backoffsMs.length; attempt += 1) {
      const backoff = backoffsMs[attempt];
      if (backoff > 0) {
        await new Promise((r) => setTimeout(r, backoff));
      }

      const resp = await fetchWithCooldown(url);
      if (resp.status === 429) continue;
      if (!resp.ok) {
        if (attempt === backoffsMs.length - 1) {
          return resp;
        }
        continue;
      }

      return resp;
    }

    return null;
  }

  async function fetchAndCompute(url) {
    const resp = await fetchWithRetry(url);
    if (!resp || !resp.ok) return null;

    const html = await resp.text();

    const blocked = detectBlockedOrInterstitial(html);
    if (blocked) {
      return { label: blocked, kind: "black", tralbum: null, html };
    }

    const special = pageSignalsOwnedOrUnreleased(html);
    if (special) {
      return { ...special, tralbum: null, html };
    }

    const tralbum = parseTralbumFromHtml(html);
    const fromTralbum = computePriceLabelFromTralbum(tralbum);
    const computed =
      fromTralbum && fromTralbum.label !== "?"
        ? fromTralbum
        : computePriceLabelFromBuyLine(html);

    return {
      label: computed.label,
      kind: computed.kind,
      tralbum,
      html,
    };
  }

  function findArtistAndTitle(tralbum) {
    if (!tralbum || typeof tralbum !== "object")
      return { artist: "", title: "" };

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

    return { artist, title };
  }

  function buildBitrotPayload(url, tralbum, computed, extraTags) {
    if (!tralbum || typeof tralbum !== "object") return null;

    const { artist, title } = findArtistAndTitle(tralbum);
    if (!artist || !title) return null;

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

    // Merge in tags from HTML
    if (Array.isArray(extraTags)) {
      const set = new Set(
        tags
          .map((t) => (typeof t === "string" ? t.trim() : ""))
          .filter((t) => t.length > 0)
      );
      for (const raw of extraTags) {
        const name = (raw || "").trim();
        if (!name) continue;
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

      console.log("[Bitrot FF] payload:", payload);

      if (!payload) {
        console.warn(
          "[Bitrot FF] no payload (artist/title missing or tralbum null)"
        );
        return;
      }

      const lookupRes = await browser.runtime.sendMessage({
        type: "BITROT_POST",
        path: "/release/lookup",
        body: payload
      });

      console.log("[Bitrot FF] lookup result:", lookupRes);

      if (!lookupRes || !lookupRes.ok || !lookupRes.data) return;
      const releaseId = lookupRes.data.release_id;
      if (!releaseId) return;

      const encounterRes = await browser.runtime.sendMessage({
        type: "BITROT_POST",
        path: "/user_encounter",
        body: {
          release_id: releaseId,
          source: "extension:discography_grid_firefox"
        }
      });

      console.log("[Bitrot FF] encounter result:", encounterRes);
    } catch (e) {
      console.warn("[Bitrot FF] Error sending release:", e);
    }
  }

  async function waitForReleases(maxTries) {
    for (let i = 0; i < maxTries; i += 1) {
      const links = findReleaseLinks();
      if (links.length > 0) return links;
      await new Promise((r) => setTimeout(r, 600));
    }
    return [];
  }

  // ---------- Main flow ----------

  const cache = await getCache();
  const releases = await waitForReleases(10);

  const tNow = Date.now();

  const tasks = [];

  for (const a of releases) {
    const url = normalize(a.href);
    if (seen.has(url)) continue;
    seen.add(url);

    const wrap = ensureBadgeAfterLink(a);

    const cached = cache[url];
    if (
      cached &&
      cached.t &&
      tNow - cached.t < CACHE_TTL &&
      cached.label
    ) {
      setBadge(wrap, cached.label, cached.kind);
      continue;
    }

    tasks.push(
      limit(async () => {
        try {
          const data = await fetchAndCompute(url);
          if (!data) {
            setBadge(wrap, "ERR", "muted");
            return;
          }

          const { label, kind, tralbum, html } = data;

          const tagsFromHtml = html ? extractTagsFromHtml(html) : [];

          cache[url] = {
            label,
            kind,
            t: Date.now(),
          };
          setBadge(wrap, label, kind);

          await setCache(cache);

          // Bitrot integration via background script
          await sendToBitrot(url, tralbum, { label, kind }, tagsFromHtml);
        } catch (e) {
          console.warn("[FF] Error in task:", e);
          setBadge(wrap, "ERR", "muted");
        }
      })
    );
  }

  await Promise.allSettled(tasks);
})();
