// Firefox Bandcamp Minimum Price Badges + Bitrot integration
// Discography mode: runs on /music pages.
// Release-page mode: runs on /album/* and /track/* to capture Bandcamp embed IDs + artwork
// without any Bitrot-side fetching.

(async () => {
  const path = location.pathname || "";

  const isDiscography = path.startsWith("/music");
  const isReleasePage = path.startsWith("/album/") || path.startsWith("/track/");

  if (!isDiscography && !isReleasePage) return;

  // ----------------------------
  // Shared helpers
  // ----------------------------
  function normalize(url) {
    try {
      const u = new URL(url, location.href);
      u.hash = "";
      return u.toString();
    } catch {
      return url;
    }
  }

  function decodeHtmlEntities(str) {
    const txt = document.createElement("textarea");
    txt.innerHTML = str;
    return txt.value;
  }

  function decodeUntilStable(str, maxRounds = 4) {
    let decoded = str || "";
    for (let i = 0; i < maxRounds; i += 1) {
      const next = decodeHtmlEntities(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return decoded;
  }

  function safeJsonParse(str) {
    if (!str) return null;
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function safeNumber(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Parse Bandcamp page properties meta in LIVE DOM -> { item_type, item_id }
  function getBcPagePropertiesFromDom() {
    const meta = document.querySelector('meta[name="bc-page-properties"]');
    if (!meta) return null;

    const raw = meta.getAttribute("content") || "";
    if (!raw) return null;

    const decoded = decodeUntilStable(raw);
    const obj = safeJsonParse(decoded);
    if (!obj || typeof obj !== "object") return null;

    const itemType = obj.item_type != null ? String(obj.item_type) : null;
    const itemId = safeNumber(obj.item_id);

    if (!itemType || !itemId || Number.isNaN(itemId)) return null;
    return { bandcamp_item_type: itemType, bandcamp_item_id: itemId };
  }

  // Artwork URL: use OG image if present (LIVE DOM)
  function getArtworkUrlFromDom() {
    const og = document.querySelector('meta[property="og:image"]');
    if (og && og.content) return String(og.content);

    const tw = document.querySelector('meta[name="twitter:image"]');
    if (tw && tw.content) return String(tw.content);

    return null;
  }

  // Tags visible on page (release pages)
  function extractTagsFromLiveDom() {
    try {
      const selectors = [
        ".tralbum-tags a",
        "#albumTags a",
        "#trackTags a",
        ".tags a",
        ".tag a",
      ];
      const set = new Set();
      for (const sel of selectors) {
        const links = document.querySelectorAll(sel);
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

  // Pull tralbum JSON from live DOM (release pages)
  function parseTralbumFromLiveDom() {
    const node =
      document.querySelector("[data-tralbum]") ||
      document.querySelector("#tralbum-data[data-tralbum]") ||
      document.querySelector("div[data-tralbum]");
    if (node) {
      const raw = node.getAttribute("data-tralbum") || "";
      const decoded = decodeUntilStable(raw);
      const obj = safeJsonParse(decoded);
      if (obj) return obj;
    }

    const pd = document.querySelector("#pagedata[data-blob]");
    if (pd) {
      const rawBlob = pd.getAttribute("data-blob") || "";
      const decoded = decodeUntilStable(rawBlob);
      const obj = safeJsonParse(decoded);
      if (obj) {
        if (obj.tralbum_data) return obj.tralbum_data;
        return obj;
      }
    }

    return null;
  }

  function findArtistAndTitle(tralbum) {
    if (!tralbum || typeof tralbum !== "object") return { artist: "", title: "" };

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

  // ✅ robust price extraction (supports tralbum.current nesting)
  function computePriceLabelFromTralbum(tralbum) {
    if (!tralbum || typeof tralbum !== "object") {
      return { label: "?", kind: "muted" };
    }

    const cur = tralbum.current && typeof tralbum.current === "object" ? tralbum.current : {};

    const currencySymbol =
      cur.currency_symbol ||
      tralbum.currency_symbol ||
      tralbum.currency ||
      (cur.price && cur.price.currency_symbol) ||
      (tralbum.price && tralbum.price.currency_symbol) ||
      "$";

    const minCandidates = [
      tralbum.minimum_price,
      tralbum.min_price,
      tralbum.download_min_price,
      tralbum.download_minimum_price,
      tralbum.download_min_price_amount,
      tralbum.download_minimum_price_amount,
      tralbum.min_price_amount,
      tralbum.minimum_price_amount,

      cur.minimum_price,
      cur.min_price,
      cur.download_min_price,
      cur.download_minimum_price,
      cur.download_min_price_amount,
      cur.download_minimum_price_amount,
      cur.min_price_amount,
      cur.minimum_price_amount,

      tralbum.price && tralbum.price.minimum_price,
      tralbum.price && tralbum.price.min_price,
      tralbum.price && tralbum.price.download_min_price,
      tralbum.price && tralbum.price.download_minimum_price,

      cur.price && cur.price.minimum_price,
      cur.price && cur.price.min_price,
      cur.price && cur.price.download_min_price,
      cur.price && cur.price.download_minimum_price,
    ];

    let minVal = null;
    for (const v of minCandidates) {
      const n = safeNumber(v);
      if (n === null) continue;
      minVal = n;
      break;
    }

    if (minVal !== null) {
      if (minVal <= 0) return { label: "FREE DL", kind: "green" };
      return { label: `${currencySymbol}${minVal}+`, kind: "blue" };
    }

    const priceCandidates = [
      tralbum.price,
      tralbum.download_price,
      tralbum.current_price,
      tralbum.amount,
      tralbum.price && tralbum.price.amount,
      tralbum.price && tralbum.price.price,
      tralbum.price && tralbum.price.value,

      cur.price,
      cur.download_price,
      cur.current_price,
      cur.amount,
      cur.price && cur.price.amount,
      cur.price && cur.price.price,
      cur.price && cur.price.value,
    ];

    for (const v of priceCandidates) {
      if (v === null || v === undefined || v === "") continue;

      if (typeof v === "object") {
        const objVal = v.amount ?? v.price ?? v.value;
        const n2 = safeNumber(objVal);
        if (n2 === null) continue;

        if (n2 <= 0) return { label: "FREE DL", kind: "green" };
        return { label: `${currencySymbol}${n2}`, kind: "blue" };
      }

      const n = safeNumber(v);
      if (n === null) continue;

      if (n <= 0) return { label: "FREE DL", kind: "green" };
      return { label: `${currencySymbol}${n}`, kind: "blue" };
    }

    return { label: "?", kind: "muted" };
  }

  // ----------------------------------------
  // Release-page mode (direct page view)
  // ----------------------------------------
  async function runReleasePageMode() {
    const onceKey = "bitrot_release_ingested_v1";
    try {
      if (sessionStorage.getItem(onceKey) === "1") return;
      sessionStorage.setItem(onceKey, "1");
    } catch {
      // ignore
    }

    const url = normalize(location.href);

    const tralbum = parseTralbumFromLiveDom();
    const { artist, title } = findArtistAndTitle(tralbum);

    const bcProps = getBcPagePropertiesFromDom();
    if ((!artist || !title) && !bcProps) {
      console.warn("[Bitrot FF] Release page: missing tralbum and bc-page-properties");
      return;
    }

    const tagsFromDom = extractTagsFromLiveDom();
    const artworkUrl = getArtworkUrlFromDom();

    const computed = computePriceLabelFromTralbum(tralbum);

    // IMPORTANT: do NOT overwrite DB with "?"
    const price_label = computed.label && computed.label !== "?" ? computed.label : null;
    const is_free = computed.kind === "green" ? true : null;

    let tracksPayload = [];
    if (tralbum && Array.isArray(tralbum.trackinfo)) {
      tracksPayload = tralbum.trackinfo.map((t) => ({
        title: t.title || "",
        duration: typeof t.duration === "number" ? Math.round(t.duration) : null,
      }));
    }

    const releaseDateRaw =
      (tralbum &&
        (tralbum.album_release_date ||
          tralbum.release_date ||
          tralbum.publish_date ||
          (tralbum.current && tralbum.current.release_date))) ||
      null;

    const payload = {
      artist: artist || "",
      title: title || "",
      platform: "bandcamp",
      platform_release_id: url,
      url,
      release_date: releaseDateRaw,
      tags: tagsFromDom,
      tracks: tracksPayload,
      price_label,
      is_free,
      ...(bcProps ? bcProps : {}),
      bandcamp_art_url: artworkUrl || null,
    };

    const lookupRes = await browser.runtime.sendMessage({
      type: "BITROT_POST",
      path: "/release/lookup",
      body: payload,
    });

    if (!lookupRes || !lookupRes.ok || !lookupRes.data) return;
    const releaseId = lookupRes.data.release_id;
    if (!releaseId) return;

    await browser.runtime.sendMessage({
      type: "BITROT_POST",
      path: "/user_encounter",
      body: { release_id: releaseId, source: "extension:release_page_firefox" },
    });
  }

  if (isReleasePage) {
    runReleasePageMode().catch((e) => {
      console.warn("[Bitrot FF] Release page mode error:", e);
    });
    return;
  }

  // ----------------------------------------
  // Discography mode (/music)
  // ----------------------------------------
  const CACHE_KEY = "bcpb_v_ff_4";
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

  const MAX_CONCURRENCY = 4;
  const REQUEST_GAP_MS = 420;

  let GLOBAL_COOLDOWN_UNTIL = 0;
  const seen = new Set();

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

      job
        .fn()
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

  function parseJsonLoose(str) {
    if (!str) return null;
    const decoded = decodeUntilStable(str);
    return safeJsonParse(decoded);
  }

  function parseTralbumFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");

    const node =
      doc.querySelector("[data-tralbum]") ||
      doc.querySelector("#tralbum-data[data-tralbum]") ||
      doc.querySelector("div[data-tralbum]");
    if (node) {
      const raw = node.getAttribute("data-tralbum");
      const j = parseJsonLoose(raw);
      if (j) return j;
    }

    const pagedata = doc.querySelector("#pagedata[data-blob]");
    if (pagedata) {
      const rawBlob = pagedata.getAttribute("data-blob");
      const blob = parseJsonLoose(rawBlob);
      if (blob) {
        if (blob.tralbum_data) return blob.tralbum_data;
        return blob;
      }
    }

    const m = html.match(/id="pagedata"[^>]*data-blob\s*=\s*"([^"]+)"/i);
    if (m && m[1]) {
      const blob = parseJsonLoose(m[1]);
      if (blob) {
        if (blob.tralbum_data) return blob.tralbum_data;
        return blob;
      }
    }

    return null;
  }

  // ✅ NEW: parse og:image from fetched HTML (for bandcamp_art_url)
  function extractOgImageFromHtml(html) {
	try {
	  if (!html) return null;
  
	  // 1) DOMParser pass
	  const doc = new DOMParser().parseFromString(html, "text/html");
  
	  const candidates = [
		'meta[property="og:image"]',
		'meta[property="og:image:secure_url"]',
		'meta[name="twitter:image"]',
		'meta[name="twitter:image:src"]',
	  ];
  
	  for (const sel of candidates) {
		const el = doc.querySelector(sel);
		if (el && el.content) return String(el.content);
	  }
  
	  const linkImg = doc.querySelector('link[rel="image_src"]');
	  if (linkImg && linkImg.href) return String(linkImg.href);
  
	  // 2) Raw HTML regex fallbacks (handles odd parsing / quoting)
	  // property="og:image" content="..."
	  const m1 = html.match(/property=['"]og:image['"][^>]*content=['"]([^'"]+)['"]/i);
	  if (m1 && m1[1]) return decodeUntilStable(m1[1]);
  
	  // content="..." property="og:image"
	  const m2 = html.match(/content=['"]([^'"]+)['"][^>]*property=['"]og:image['"]/i);
	  if (m2 && m2[1]) return decodeUntilStable(m2[1]);
  
	  // og:image:secure_url
	  const m3 = html.match(/property=['"]og:image:secure_url['"][^>]*content=['"]([^'"]+)['"]/i);
	  if (m3 && m3[1]) return decodeUntilStable(m3[1]);
  
	  // twitter:image
	  const m4 = html.match(/name=['"]twitter:image(?::src)?['"][^>]*content=['"]([^'"]+)['"]/i);
	  if (m4 && m4[1]) return decodeUntilStable(m4[1]);
  
	  // rel="image_src"
	  const m5 = html.match(/rel=['"]image_src['"][^>]*href=['"]([^'"]+)['"]/i);
	  if (m5 && m5[1]) return decodeUntilStable(m5[1]);
  
	  return null;
	} catch {
	  return null;
	}
  }


  // ✅ NEW: parse bc-page-properties from fetched HTML (for bandcamp_item_type/id)
  function extractBcPagePropertiesFromHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const meta = doc.querySelector('meta[name="bc-page-properties"]');
      if (!meta) return null;

      const raw = meta.getAttribute("content") || "";
      if (!raw) return null;

      const decoded = decodeUntilStable(raw);
      const obj = safeJsonParse(decoded);
      if (!obj || typeof obj !== "object") return null;

      const itemType = obj.item_type != null ? String(obj.item_type) : null;
      const itemId = safeNumber(obj.item_id);

      if (!itemType || !itemId) return null;
      return { bandcamp_item_type: itemType, bandcamp_item_id: itemId };
    } catch {
      return null;
    }
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
    const links = Array.from(document.querySelectorAll("a[href]"));
    return links.filter((a) => {
      const href = a.getAttribute("href") || "";
      return href.includes("/album/") || href.includes("/track/");
    });
  }

  // Place badge UNDER the cover art tile when possible
  function ensureBadgeUnderCover(anchor) {
    const tile =
      anchor.closest("li") ||
      anchor.closest(".music-grid-item") ||
      anchor.closest(".item") ||
      anchor.parentElement;

    if (!tile) return null;

    const existing = tile.querySelector(":scope .bcpb-wrap");
    if (existing) return existing;

    const wrap = document.createElement("div");
    wrap.className = "bcpb-wrap";

    const badge = document.createElement("span");
    badge.className = "bcpb-badge bcpb-muted";
    badge.textContent = "…";

    wrap.appendChild(badge);

    const art =
      tile.querySelector("a img")?.closest("a") ||
      tile.querySelector(".art") ||
      tile.querySelector("img");

    if (art && art.insertAdjacentElement) {
      art.insertAdjacentElement("afterend", wrap);
    } else {
      tile.appendChild(wrap);
    }

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

  function now() {
    return Date.now();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function fetchWithRetry(url) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cdRemaining = GLOBAL_COOLDOWN_UNTIL - now();
      if (cdRemaining > 0) await sleep(cdRemaining);

      const res = await fetch(url, { credentials: "include" }).catch(() => null);
      if (!res) continue;

      if (res.status === 429) {
        GLOBAL_COOLDOWN_UNTIL = now() + 15000;
        continue;
      }

      if (!res.ok) continue;
      const text = await res.text();
      return { ok: true, status: res.status, text };
    }

    return { ok: false, status: 0, text: "" };
  }

  // ✅ UPDATED: payload now can include bandcamp_art_url + bc props from fetched HTML
  function buildBitrotPayload(url, tralbum, computed, extraTags, bandcampExtras) {
    if (!tralbum || typeof tralbum !== "object") return null;

    const { artist, title } = findArtistAndTitle(tralbum);
    if (!artist || !title) return null;

    const releaseDateRaw =
      tralbum.album_release_date ||
      tralbum.release_date ||
      tralbum.publish_date ||
      (tralbum.current && tralbum.current.release_date) ||
      null;

    let tags = [];
    if (Array.isArray(tralbum.tags)) tags = tralbum.tags;
    else if (tralbum.current && Array.isArray(tralbum.current.tags)) tags = tralbum.current.tags;

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
        if (!has) set.add(name);
      }
      tags = Array.from(set);
    } else {
      tags = tags
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter((t) => t.length > 0);
    }

    let tracksPayload = [];
    if (Array.isArray(tralbum.trackinfo)) {
      tracksPayload = tralbum.trackinfo.map((t) => ({
        title: t.title || "",
        duration: typeof t.duration === "number" ? Math.round(t.duration) : null,
      }));
    }

    // never send "?" to Bitrot (prevents overwriting good price data)
    const price_label =
      computed && computed.label && computed.label !== "?" ? computed.label : null;
    const is_free = computed && computed.kind === "green" ? true : null;

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

      // ✅ NEW: bandcamp extras from fetched HTML
      ...(bandcampExtras && typeof bandcampExtras === "object" ? bandcampExtras : {}),
    };
  }

  async function sendToBitrot(url, tralbum, computed, extraTags, bandcampExtras) {
    try {
      const payload = buildBitrotPayload(url, tralbum, computed, extraTags, bandcampExtras);
      if (!payload) return;

      const lookupRes = await browser.runtime.sendMessage({
        type: "BITROT_POST",
        path: "/release/lookup",
        body: payload,
      });

      if (!lookupRes || !lookupRes.ok || !lookupRes.data) return;
      const releaseId = lookupRes.data.release_id;
      if (!releaseId) return;

      await browser.runtime.sendMessage({
        type: "BITROT_POST",
        path: "/user_encounter",
        body: { release_id: releaseId, source: "extension:discography_grid_firefox" },
      });
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

  // ---------- Main flow (/music) ----------
  const cache = await getCache();
  const releases = await waitForReleases(10);
  const tNow = Date.now();

  const tasks = [];

  for (const a of releases) {
    const url = normalize(a.href);
    if (seen.has(url)) continue;
    seen.add(url);

    const wrap = ensureBadgeUnderCover(a);

    const cached = cache[url];
    if (cached && cached.t && tNow - cached.t < CACHE_TTL && cached.label) {
      setBadge(wrap, cached.label, cached.kind);
      continue;
    }

    tasks.push(
      limit(async () => {
        try {
          const res = await fetchWithRetry(url);
          if (!res || !res.ok) {
            setBadge(wrap, "ERR", "muted");
            return;
          }

          const html = res.text || "";
          const tralbum = parseTralbumFromHtml(html);
          const computed = computePriceLabelFromTralbum(tralbum);
          const tagsFromHtml = html ? extractTagsFromHtml(html) : [];

          // ✅ NEW: capture Bandcamp cover art + bc-page-properties from fetched HTML
          const ogImage = html ? extractOgImageFromHtml(html) : null;
          const bcProps = html ? extractBcPagePropertiesFromHtml(html) : null;

          const bandcampExtras = {
            bandcamp_art_url: ogImage || null,
            ...(bcProps ? bcProps : {}),
          };

          cache[url] = { label: computed.label, kind: computed.kind, t: Date.now() };
          setBadge(wrap, computed.label, computed.kind);

          await setCache(cache);

          // Only send if tralbum parsed; otherwise we show badge but do not overwrite DB
          if (tralbum) {
            await sendToBitrot(url, tralbum, computed, tagsFromHtml, bandcampExtras);
          }
        } catch (e) {
          console.warn("[FF] Error in task:", e);
          setBadge(wrap, "ERR", "muted");
        }
      })
    );
  }

  await Promise.allSettled(tasks);
})();
