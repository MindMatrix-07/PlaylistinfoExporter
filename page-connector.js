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
          window.postMessage({ type: "FROM_EXT_AI_LANG_RESPONSE", ok: false, error: chrome.runtime.lastError.message, song, requestId }, "*");
        } else {
          window.postMessage({ type: "FROM_EXT_AI_LANG_RESPONSE", ok: res?.ok ?? false, language: res?.language, error: res?.error, debug: res?.debug, song, requestId }, "*");
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
          window.postMessage({ type: "FROM_EXT_SPOTIFY_PROFILES_RESPONSE", ok: false, error: chrome.runtime.lastError.message, requestId }, "*");
        } else {
          window.postMessage({ type: "FROM_EXT_SPOTIFY_PROFILES_RESPONSE", ok: res?.ok ?? false, profiles: res?.profiles || {}, error: res?.error, requestId }, "*");
        }
      }
    );
  }

  if (event.data?.type === "FROM_PAGE_SCRAPE_PLAYLIST_ADDED_BY") {
    const { playlistUrl, totalTracks, requestId } = event.data;
    chrome.runtime.sendMessage(
      { type: "SCRAPE_PLAYLIST_ADDED_BY", playlistUrl, totalTracks, requestId },
      (res) => {
        if (chrome.runtime.lastError) {
          window.postMessage({ type: "FROM_EXT_SCRAPE_ADDED_BY_RESPONSE", ok: false, error: chrome.runtime.lastError.message, tracks: [], requestId }, "*");
        } else {
          window.postMessage({ type: "FROM_EXT_SCRAPE_ADDED_BY_RESPONSE", ok: res?.ok ?? false, tracks: res?.tracks || [], count: res?.count || 0, withNames: res?.withNames || 0, error: res?.error, requestId }, "*");
        }
      }
    );
  }

  if (event.data?.type === "FROM_PAGE_GET_AI_DEBUG_LOG") {
    chrome.runtime.sendMessage({ type: "GET_AI_DEBUG_LOG" }, (res) => {
      window.postMessage({ type: "FROM_EXT_AI_DEBUG_LOG", entries: res?.entries || [] }, "*");
    });
  }

  if (event.data?.type === "FROM_PAGE_CLEAR_AI_DEBUG_LOG") {
    chrome.runtime.sendMessage({ type: "CLEAR_AI_DEBUG_LOG" }, () => {});
  }

  // Batch ISRC fetch — uses the Spotify web player's own login token
  // to call the official Spotify API for up to 50 tracks at a time.
  // Requires the user to have an open Spotify tab (open.spotify.com).
  if (event.data?.type === 'FROM_PAGE_FETCH_ISRC_BATCH') {
    const { trackIds, requestId } = event.data;
    chrome.runtime.sendMessage(
      { type: 'FETCH_ISRC_BATCH', trackIds, requestId },
      (res) => {
        if (chrome.runtime.lastError) {
          window.postMessage({ type: 'FROM_EXT_ISRC_BATCH_RESPONSE', ok: false, error: chrome.runtime.lastError.message, isrcMap: {}, requestId }, '*');
        } else {
          window.postMessage({ type: 'FROM_EXT_ISRC_BATCH_RESPONSE', ok: res?.ok ?? false, isrcMap: res?.isrcMap || {}, error: res?.error, requestId }, '*');
        }
      }
    );
  if (event.data?.type === 'FROM_PAGE_SCRAPE_ISRC_FINDER') {
    const { trackUrl, requestId } = event.data;
    chrome.runtime.sendMessage(
      { type: 'SCRAPE_ISRC_FINDER', trackUrl, requestId },
      (res) => {
        if (chrome.runtime.lastError) {
          window.postMessage({ type: 'FROM_EXT_SCRAPE_ISRC_FINDER_RESPONSE', ok: false, error: chrome.runtime.lastError.message, isrc: '—', requestId }, '*');
        } else {
          window.postMessage({ type: 'FROM_EXT_SCRAPE_ISRC_FINDER_RESPONSE', ok: res?.ok ?? false, isrc: res?.isrc || '—', error: res?.error, requestId }, '*');
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
