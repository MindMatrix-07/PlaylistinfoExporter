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

  if (event.data?.type === "FROM_PAGE_ASK_AI_LANG") {
    const { song, artists } = event.data;

    chrome.runtime.sendMessage(
      { type: "ASK_GOOGLE_AI_LANG", song, artists },
      (res) => {
        if (chrome.runtime.lastError) {
          window.postMessage({
            type: "FROM_EXT_AI_LANG_RESPONSE",
            ok: false,
            error: chrome.runtime.lastError.message,
            song
          }, "*");
        } else {
          window.postMessage({
            type: "FROM_EXT_AI_LANG_RESPONSE",
            ok: res?.ok ?? false,
            language: res?.language,
            error: res?.error,
            song
          }, "*");
        }
      }
    );
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
