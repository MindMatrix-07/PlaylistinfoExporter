/* ============================================================
   Spotify Playlist Exporter — Page Connector Content Script
   ============================================================ */

console.log("[PlaylistExporter Ext] Page Connector active.");

// Listen to window messages from the web page
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "PING_PLAYLIST_EXPORTER_EXT") {
    window.postMessage({ type: "PONG_PLAYLIST_EXPORTER_EXT" }, "*");
  }

  if (event.data?.type === "FROM_PAGE_ASK_AI_LANG" || event.data?.type === "TO_EXT_AI_LANG_REQUEST") {
    const { song, artists, requestId } = event.data;

    chrome.runtime.sendMessage(
      { type: "ASK_GOOGLE_AI_LANG", song, artists, requestId },
      (res) => {
        if (chrome.runtime.lastError) {
          window.postMessage({
            type: "FROM_EXT_AI_LANG_RESPONSE",
            ok: false,
            error: chrome.runtime.lastError.message,
            song,
            requestId
          }, "*");
        } else {
          window.postMessage({
            type: "FROM_EXT_AI_LANG_RESPONSE",
            ok: res?.ok ?? false,
            language: res?.language,
            error: res?.error,
            debug: res?.debug,
            song,
            requestId
          }, "*");
        }
      }
    );
  }

  if (event.data?.type === "FROM_PAGE_FETCH_SPOTIFY_PROFILES") {
    const { userIds, requestId } = event.data;

    chrome.runtime.sendMessage(
      { type: "FETCH_SPOTIFY_PROFILES", userIds, requestId },
      (res) => {
        if (chrome.runtime.lastError) {
          window.postMessage({
            type: "FROM_EXT_SPOTIFY_PROFILES_RESPONSE",
            ok: false,
            error: chrome.runtime.lastError.message,
            requestId
          }, "*");
        } else {
          window.postMessage({
            type: "FROM_EXT_SPOTIFY_PROFILES_RESPONSE",
            ok: res?.ok ?? false,
            profiles: res?.profiles || {},
            error: res?.error,
            requestId
          }, "*");
        }
      }
    );
  }

  if (event.data?.type === "FROM_PAGE_GET_AI_DEBUG_LOG") {
    chrome.runtime.sendMessage({ type: "GET_AI_DEBUG_LOG" }, (res) => {
      window.postMessage({
        type: "FROM_EXT_AI_DEBUG_LOG",
        entries: res?.entries || []
      }, "*");
    });
  }

  if (event.data?.type === "FROM_PAGE_CLEAR_AI_DEBUG_LOG") {
    chrome.runtime.sendMessage({ type: "CLEAR_AI_DEBUG_LOG" }, () => {});
  }
});

// Notify presence immediately on content script load
function notifyInstalled() {
  window.postMessage({ type: "PONG_PLAYLIST_EXPORTER_EXT" }, "*");
}

notifyInstalled();
// Re-notify after DOM is loaded to ensure page script catches it
setTimeout(notifyInstalled, 500);
setTimeout(notifyInstalled, 1500);
setTimeout(notifyInstalled, 3000);
