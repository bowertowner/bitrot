// MV3 service worker: performs fetches on behalf of the content script.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "BCPB_FETCH" || !msg.url) return;

  (async () => {
    try {
      const resp = await fetch(msg.url, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow"
      });

      const text = await resp.text().catch(() => "");
      sendResponse({
        ok: resp.ok,
        status: resp.status,
        url: resp.url,
        text
      });
    } catch (e) {
      sendResponse({
        ok: false,
        status: 0,
        url: msg.url,
        text: String(e || "")
      });
    }
  })();

  // Keep the message channel open for async sendResponse
  return true;
});
