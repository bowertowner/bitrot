// Firefox background script: handles Bitrot API calls on behalf of content scripts.

const BITROT_API = "http://localhost:3000";

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "BITROT_POST") {
    return;
  }

  const path = msg.path || "/";
  const body = msg.body || {};
  const url = BITROT_API + path;

  // Return a Promise so the content script can await the result
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  })
    .then(async (res) => {
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return {
        ok: res.ok,
        status: res.status,
        data
      };
    })
    .catch((err) => {
      console.warn("[Bitrot FF bg] fetch error:", err);
      return {
        ok: false,
        status: 0,
        error: String(err || "unknown error")
      };
    });
});
