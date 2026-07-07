/* ============================================
   Spotify Playlist Exporter v2.0 (Test Lab)
   ============================================ */

let allTracks = [];
let playlistData = null;
let aiDetectionInProgress = false;
let activeMode = 'premium'; // 'premium' or 'web'
const resultsPreviewAudio = new Audio();
let activeResultsPreviewButton = null;

// Heuristic Language Detector
function detectLanguage(title, isrc) {
  if (!title) return 'English';
  
  // 1. Unicode script detections
  if (/[\uac00-\ud7af]/.test(title)) return 'Korean';
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(title)) return 'Japanese';
  if (/[\u4e00-\u9faf]/.test(title)) return 'Chinese';
  if (/[\u0900-\u097f]/.test(title)) return 'Hindi / Indian';
  if (/[\u0600-\u06ff]/.test(title)) return 'Arabic';
  if (/[\u0400-\u04ff]/.test(title)) return 'Cyrillic';

  // 2. ISRC prefix lookup mapping
  if (isrc && isrc !== '—') {
    const code = isrc.slice(0, 2).toUpperCase();
    const mapping = {
      'IN': 'Hindi / Punjabi',
      'US': 'English', 'GB': 'English', 'CA': 'English', 'AU': 'English', 'NZ': 'English',
      'QZ': 'English', 'QM': 'English', 'DG': 'English', 'ZZ': 'English',
      'KR': 'Korean',
      'JP': 'Japanese',
      'ES': 'Spanish', 'MX': 'Spanish', 'CO': 'Spanish', 'AR': 'Spanish', 'CL': 'Spanish',
      'BR': 'Portuguese', 'PT': 'Portuguese',
      'FR': 'French',
      'DE': 'German',
      'IT': 'Italian',
      'NL': 'Dutch',
      'SE': 'Swedish', 'NO': 'Norwegian', 'DK': 'Danish', 'FI': 'Finnish',
      'RU': 'Russian', 'UA': 'Ukrainian',
      'TR': 'Turkish',
      'CN': 'Chinese', 'TW': 'Chinese', 'HK': 'Chinese',
      'ZA': 'English'
    };
    if (mapping[code]) return mapping[code];
  }

  // 3. Latinized Hindi/Punjabi keywords matching common lyric vocab
  const commonHindiWords = /\b(tere|bina|guzara|jiya|laage|na|duhaai|dil|pyar|tum|meri|jaan|kuch|hota|hai|sath|rabba|ishq|sanam|ki|se|ko|ek|do|teen|lagi|padi|saahel|raahi|o|re|mann|tanha|dua)\b/i;
  if (commonHindiWords.test(title)) {
    return 'Hindi / Punjabi';
  }

  return 'English';
}

const SCOPES = 'playlist-read-private playlist-read-collaborative';
const REDIRECT_URI = window.location.origin + '/test.html'; // Callback to test.html in lab
const RENDER_ORIGIN = 'https://playlistinfoexporter.onrender.com';
const VERCEL_ORIGIN = 'https://playlistinfoexporter.vercel.app';

// ─── PKCE Helpers ────────────────────────────

async function generateCodeVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ─── Auth ────────────────────────────────────

async function connectSpotify() {
  const clientId = document.getElementById('clientId').value.trim();
  if (!clientId) { showError('Please enter your Spotify Client ID first.'); return; }

  const verifier  = await generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  localStorage.setItem('sp_verifier',  verifier);
  localStorage.setItem('sp_client_id', clientId);

  const params = new URLSearchParams({
    client_id:             clientId,
    response_type:         'code',
    redirect_uri:          REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge:        challenge,
    scope:                 SCOPES,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const error  = params.get('error');

  if (error) {
    showError('Spotify denied access: ' + error);
    window.history.replaceState({}, '', '/test.html');
    return;
  }
  if (!code) return;

  const clientId = localStorage.getItem('sp_client_id');
  const verifier = localStorage.getItem('sp_verifier');

  if (!clientId || !verifier) {
    showError('Auth state missing — please try connecting again.');
    window.history.replaceState({}, '', '/test.html');
    return;
  }

  try {
    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.error_description || `Token exchange failed (${resp.status})`);
    }

    const data = await resp.json();
    localStorage.setItem('sp_token',   data.access_token);
    localStorage.setItem('sp_expiry',  String(Date.now() + data.expires_in * 1000));
    if (data.refresh_token) localStorage.setItem('sp_refresh', data.refresh_token);
    localStorage.removeItem('sp_verifier');

  } catch (err) {
    showError('Authentication failed: ' + err.message);
  }

  window.history.replaceState({}, '', '/test.html');
}

function getToken() {
  const token  = localStorage.getItem('sp_token');
  const expiry = parseInt(localStorage.getItem('sp_expiry') || '0');
  return (token && Date.now() < expiry) ? token : null;
}

// Fetches the current user profile ID and caches it.
async function getCurrentUserId(token) {
  let userId = localStorage.getItem('sp_user_id');
  if (userId) return userId;

  try {
    const resp = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (resp.ok) {
      const meData = await resp.json();
      localStorage.setItem('sp_user_id', meData.id);
      localStorage.setItem('sp_user_name', meData.display_name || meData.id);
      return meData.id;
    }
  } catch (err) {
    console.warn('[Auth] Failed to fetch current user ID:', err);
  }
  return null;
}

function disconnectSpotify() {
  ['sp_token','sp_expiry','sp_refresh','sp_client_id','sp_user_id','sp_user_name'].forEach(k => localStorage.removeItem(k));
  updateAuthUI();
}

// ─── Mode Selector ───────────────────────────

function setFetchMode(mode) {
  if (mode === 'web' && window.location.hostname !== 'playlistinfoexporter.onrender.com') {
    window.location.href = RENDER_ORIGIN + '/';
    return;
  }

  if (mode === 'premium' && window.location.hostname !== 'playlistinfoexporter.vercel.app') {
    window.location.href = VERCEL_ORIGIN + '/';
    return;
  }

  activeMode = mode;

  // Toggle active class on buttons
  const premiumBtn = document.getElementById('modePremiumBtn');
  const webBtn = document.getElementById('modeWebBtn');

  if (mode === 'premium') {
    premiumBtn.classList.add('active');
    webBtn.classList.remove('active');
    document.getElementById('webFetchInfoBox').style.display = 'none';
    document.getElementById('webFetchRenderNote').style.display = 'none';
  } else {
    premiumBtn.classList.remove('active');
    webBtn.classList.add('active');
    document.getElementById('webFetchInfoBox').style.display = 'flex';
    document.getElementById('webFetchRenderNote').style.display = 'flex';
  }

  updateAuthUI();
}

// ─── UI State ─────────────────────────────────

function updateAuthUI() {
  const token = getToken();
  const disclaimer = document.getElementById('premiumPlaylistDisclaimer');

  if (activeMode === 'premium') {
    document.getElementById('authCard').style.display     = token ? 'none'  : 'block';
    document.getElementById('playlistCard').style.display  = token ? 'block' : 'none';
    document.getElementById('connectedStatus').style.display  = token ? 'flex'  : 'none';
    document.getElementById('notConnectedBadge').style.display = token ? 'none' : 'inline-flex';
    if (disclaimer) disclaimer.style.display = token ? 'flex' : 'none';
  } else {
    // Web fetch mode doesn't need auth card or connected status
    document.getElementById('authCard').style.display     = 'none';
    document.getElementById('playlistCard').style.display  = 'block';
    document.getElementById('connectedStatus').style.display  = 'none';
    document.getElementById('notConnectedBadge').style.display = 'inline-flex';
    if (disclaimer) disclaimer.style.display = 'none';
  }

  // Restore saved clientId
  const savedId = localStorage.getItem('sp_client_id');
  if (savedId) document.getElementById('clientId').value = savedId;

  // Restore last playlist URL
  const savedUrl = localStorage.getItem('sp_last_url');
  if (savedUrl) document.getElementById('playlistUrl').value = savedUrl;
}

function showError(msg, boxId = 'errorBox') {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.innerHTML = `<svg style="width:16px;height:16px;flex-shrink:0" viewBox="0 0 24 24" fill="none">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/>
  </svg> ${msg}`;
  box.style.display = 'flex';
}

function showSpotifyApiError(err, rawUrl, playlistOwnerId = null, currentUserId = null) {
  const details = formatSpotifyErrorDetails(err);
  
  let customExplanation = '';
  if (err?.status === 403 || isSpotifyForbiddenError(err)) {
    if (playlistOwnerId && currentUserId && playlistOwnerId !== currentUserId) {
      customExplanation = `
        <div style="margin-top:8px; line-height:1.4; color:#fca5a5;">
          <strong>Ownership Restriction:</strong> This playlist is owned by another user (ID: <code>${escHtml(playlistOwnerId)}</code>), but you are logged in as <code>${escHtml(currentUserId)}</code>.<br>
          Since Spotify's API changes in March 2026, Development Mode apps can only access tracks of playlists that you own or collaborate on.<br>
          <strong style="display:block; margin-top:6px;">Workarounds:</strong>
          <ul style="margin: 4px 0 0; padding-left: 20px;">
            <li>Switch to <strong>Web Fetch Mode</strong> (no login required).</li>
            <li>Or copy/add all songs of this playlist to a new playlist in Spotify (which you own), and fetch that new playlist URL instead!</li>
          </ul>
        </div>`;
    } else {
      customExplanation = `
        <div style="margin-top:8px; line-height:1.4; color:#fca5a5;">
          <strong>Why is this forbidden?</strong> Since March 2026, Spotify's API restricts Development Mode apps from fetching tracks of playlists unless you are the owner or a collaborator.<br>
          <strong style="display:block; margin-top:6px;">Workarounds:</strong>
          <ul style="margin: 4px 0 0; padding-left: 20px;">
            <li>Switch to <strong>Web Fetch Mode</strong>.</li>
            <li>Or copy all songs to a new playlist you own, then fetch the new playlist here.</li>
          </ul>
        </div>`;
    }
  }

  showError(`
    <div style="width:100%">
      <div><strong>Spotify API error:</strong> ${escHtml(err.message || 'Unknown error')}</div>
      ${customExplanation}
      ${details ? `<pre style="margin:10px 0 0;white-space:pre-wrap;font:12px/1.45 Consolas,monospace;color:#fecaca;">${escHtml(details)}</pre>` : ''}
      <div style="margin-top:12px;">
        <a href="${RENDER_ORIGIN}/" style="display:inline-flex;color:#fca5a5;font-weight:700;text-decoration:underline;">Switch to Web Fetch (No Login Required)</a>
      </div>
    </div>
  `, 'errorBox2');
}

function hideError(boxId = 'errorBox2') {
  const box = document.getElementById(boxId);
  if (box) box.style.display = 'none';
}

function showToast(msg, duration = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function setLoading(show, text = 'Fetching…') {
  document.getElementById('loadingState').style.display = show ? 'flex' : 'none';
  document.getElementById('loadingText').textContent = text;
}

function setFetchBtn(disabled) {
  const btn = document.getElementById('fetchBtn');
  if (!btn) return;
  btn.disabled = disabled;
  btn.querySelector('.btn-text').textContent = disabled ? 'Loading…' : 'Fetch Playlist';
}

// ─── Playlist ID Extractor ───────────────────

function extractPlaylistId(input) {
  input = input.trim();
  const uri = input.match(/spotify:playlist:([a-zA-Z0-9]+)/);
  if (uri) return uri[1];
  const url = input.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  if (url) return url[1];
  if (/^[a-zA-Z0-9]{22}$/.test(input)) return input;
  return null;
}

// ─── Spotify API ──────────────────────────────

async function fetchPlaylistMeta(token, playlistId) {
  const resp = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    const errMsg = errBody?.error?.message || `HTTP ${resp.status}`;
    const error = new Error(`Failed to load playlist metadata: ${errMsg} (${resp.status})`);
    error.status = resp.status;
    error.spotifyResponse = errBody;
    throw error;
  }
  return resp.json();
}

async function fetchAllTracks(token, playlistId, totalExpected, onProgress) {
  const limit = 100;
  let offset = 0;
  let tracks = [];

  while (true) {
    const resp = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const errMsg = errBody?.error?.message || `HTTP ${resp.status}`;
      const error = new Error(`Failed to fetch tracks: ${errMsg} (${resp.status})`);
      error.status = resp.status;
      error.spotifyResponse = errBody;
      throw error;
    }
    const data = await resp.json();

    const items = (data.items || []).filter(i => i && (i.track || i.item) && (i.track || i.item).id);
    tracks = tracks.concat(items.map(i => {
      const t = i.track || i.item;
      const isrc = t.external_ids?.isrc || '—';
      return {
        name:    t.name    || 'Unknown',
        artists: (t.artists || []).map(a => a.name).join(', '),
        album:   t.album?.name || '',
        albumArt: t.album?.images?.[t.album.images.length - 1]?.url || t.album?.images?.[0]?.url || '',
        url:     t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
        isrc:    isrc,
        previewUrl: t.preview_url || '',
        language: ''
      };
    }));

    if (onProgress) onProgress(tracks.length, totalExpected || data.total);
    if (!data.next) break;
    offset += limit;
  }

  return tracks;
}

// ─── Main Fetch Handler ───────────────────────

async function fetchPlaylist() {
  hideError('errorBox2');
  const rawUrl = document.getElementById('playlistUrl').value.trim();

  const playlistId = extractPlaylistId(rawUrl);
  if (!playlistId) {
    showError('Invalid playlist URL. Example: https://open.spotify.com/playlist/37i9dQZF1DX...', 'errorBox2');
    return;
  }

  localStorage.setItem('sp_last_url', rawUrl);
  setFetchBtn(true);
  document.getElementById('resultsSection').style.display = 'none';

  if (activeMode === 'web') {
    // WEB FETCH MODE (Calls Serverless Endpoint)
    setLoading(true, 'Fetching playlist via Web Fetch…');
    try {
      const apiUrl = `/api/spotify-info?url=${encodeURIComponent(rawUrl)}`;
      const resp = await fetch(apiUrl);
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${resp.status}`);
      }
      
      const resData = await resp.json();
      playlistData = {
        name: resData.name,
        owner: resData.owner,
        images: resData.images,
        external_urls: { spotify: rawUrl }
      };

      allTracks = resData.tracks.items.map(item => {
        const t = item.track;
        return {
          name: t.name,
          artists: t.artists.map(a => a.name).join(', '),
          album: t.album?.name || '',
          albumArt: t.albumArt,
          url: t.external_urls?.spotify,
          isrc: t.external_ids?.isrc || '—',
          previewUrl: t.preview_url || '',
          language: ''
        };
      });

      await enrichMissingPreviewUrls();
      setLoading(false);
      renderResults();

      // Trigger Google AI language detection if selected
      const aiModeCheckbox = document.getElementById('aiModeCheckbox');
      if (aiModeCheckbox && aiModeCheckbox.checked) {
        aiDetectionInProgress = false;
        setTimeout(() => {
          startGoogleAiLanguageDetection();
        }, 100);
      }
    } catch (err) {
      setLoading(false);
      showError(err.message || 'Something went wrong during Web Fetch.', 'errorBox2');
    } finally {
      setFetchBtn(false);
    }
  } else {
    // SPOTIFY PREMIUM MODE (PKCE Access Flow)
    const token = getToken();
    if (!token) {
      showError('Session expired — please reconnect Spotify.', 'errorBox2');
      disconnectSpotify();
      setFetchBtn(false);
      return;
    }

    let currentUserId = null;
    try {
      currentUserId = await getCurrentUserId(token);
    } catch (e) {
      console.warn('[Spotify] Could not fetch current user ID:', e);
    }

    setLoading(true, 'Fetching playlist info…');
    try {
      playlistData = await fetchPlaylistMeta(token, playlistId);
      if (!playlistData || playlistData.error) {
        throw new Error(`Could not load playlist: ${playlistData?.error?.message || 'unknown error'}`);
      }

      const total = playlistData?.tracks?.total ?? null;
      setLoading(true, `Fetching tracks${total ? ` (0 / ${total})` : '…'}…`);

      allTracks = await fetchAllTracks(token, playlistId, total, (done, all) => {
        setLoading(true, `Fetching tracks (${done}${all ? ' / ' + all : ''})…`);
      });

      setLoading(false);
      renderResults();

      const aiModeCheckbox = document.getElementById('aiModeCheckbox');
      if (aiModeCheckbox && aiModeCheckbox.checked) {
        aiDetectionInProgress = false;
        setTimeout(() => {
          startGoogleAiLanguageDetection();
        }, 100);
      }

    } catch (err) {
      setLoading(false);
      if (isSpotifyForbiddenError(err)) {
        showSpotifyApiError(err, rawUrl, playlistData?.owner?.id, currentUserId);
        return;
      }
      showError(err.message || 'Something went wrong.', 'errorBox2');
    } finally {
      setFetchBtn(false);
    }
  }
}

// ─── Render Results ───────────────────────────

function renderResults() {
  const meta = document.getElementById('playlistMeta');
  const img  = playlistData.images?.[0]?.url;
  meta.innerHTML = `
    ${img
      ? `<img class="playlist-cover" src="${img}" alt="Cover" />`
      : `<div class="playlist-cover-placeholder"><svg style="width:32px;height:32px;color:#fff" viewBox="0 0 24 24" fill="none"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" fill="currentColor"/></svg></div>`
    }
    <div class="playlist-info">
      <h2>${escHtml(playlistData.name)}</h2>
      <p>By ${escHtml(playlistData.owner?.display_name || 'Unknown')} &nbsp;·&nbsp; ${allTracks.length} tracks</p>
      <a class="playlist-link" href="${playlistData.external_urls?.spotify}" target="_blank">
        Open on Spotify
        <svg viewBox="0 0 24 24" fill="none" style="width:12px;height:12px"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </a>
    </div>`;

  document.getElementById('trackCountLabel').innerHTML = `<strong>${allTracks.length}</strong> tracks found`;

  const body = document.getElementById('tracksBody');
  body.innerHTML = '';

  const aiModeCheckbox = document.getElementById('aiModeCheckbox');
  const isAiOn = aiModeCheckbox && aiModeCheckbox.checked;

  allTracks.forEach((track, i) => {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.style.animationDelay = `${Math.min(i * 18, 500)}ms`;
    const thumbMarkup = track.albumArt
      ? track.previewUrl
        ? `<button class="track-thumb-button" type="button" data-preview-url="${escAttr(track.previewUrl)}" aria-label="Play preview for ${escAttr(track.name)}"><img class="track-thumb" src="${escAttr(track.albumArt)}" alt="" /><span class="track-thumb-state">&#9654;</span></button>`
        : `<img class="track-thumb" src="${escAttr(track.albumArt)}" alt="" title="No preview available" />`
      : `<div class="track-thumb-placeholder"></div>`;
    row.innerHTML = `
      <span class="col-num">${i + 1}</span>
      <div class="col-title" style="flex-direction: row; align-items: center; gap: 8px;">
        ${thumbMarkup}
        <div style="display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1;">
          <span class="track-name" title="${escHtml(track.name)}">${escHtml(track.name)}</span>
          <span class="track-album" title="${escHtml(track.album)}">${escHtml(track.album)}</span>
        </div>
      </div>
      <span class="col-artists" title="${escHtml(track.artists)}">${escHtml(track.artists)}</span>
      <span class="col-isrc"><span class="isrc-badge">${escHtml(track.isrc)}</span></span>
      <span class="col-lang">
        <span class="lang-badge ${isAiOn ? 'scanning-text' : ''}" id="lang-badge-${i}">
          ${isAiOn ? 'Scanning…' : escHtml(track.language || detectLanguage(track.name, track.isrc))}
        </span>
      </span>
      <span class="col-link">
        <a href="${track.url}" target="_blank">
          <svg viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Open
        </a>
      </span>
    `;
    body.appendChild(row);
  });
  initResultsPreviewControls();

  const table = document.querySelector('.tracks-table');
  if (table) {
    if (isAiOn) table.classList.remove('no-ai-mode');
    else table.classList.add('no-ai-mode');
  }

  document.getElementById('resultsSection').style.display = 'block';
  document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('Playlist loaded successfully.');
}

function initResultsPreviewControls() {
  document.querySelectorAll('.track-thumb-button[data-preview-url]').forEach(button => {
    button.addEventListener('click', () => {
      const previewUrl = button.dataset.previewUrl;
      if (!previewUrl) return;
      if (activeResultsPreviewButton === button && !resultsPreviewAudio.paused) {
        stopResultsPreview();
        return;
      }
      stopResultsPreview();
      activeResultsPreviewButton = button;
      button.classList.add('playing');
      const state = button.querySelector('.track-thumb-state');
      if (state) state.textContent = '\u275a\u275a';
      resultsPreviewAudio.src = previewUrl;
      resultsPreviewAudio.play().catch(() => {
        if (state) state.textContent = '!';
        setTimeout(stopResultsPreview, 800);
      });
    });
  });
}

function stopResultsPreview() {
  resultsPreviewAudio.pause();
  resultsPreviewAudio.removeAttribute('src');
  resultsPreviewAudio.load();
  if (activeResultsPreviewButton) {
    activeResultsPreviewButton.classList.remove('playing');
    const state = activeResultsPreviewButton.querySelector('.track-thumb-state');
    if (state) state.textContent = '\u25b6';
  }
  activeResultsPreviewButton = null;
}

resultsPreviewAudio.addEventListener('ended', stopResultsPreview);

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function copyToClipboard() {
  if (!allTracks.length) return;
  const headerLine = 'Track #\tSong Name\tArtists\tISRC\tLanguage\tSpotify Link';
  const rows = allTracks.map((t, idx) => {
    const lang = t.language || detectLanguage(t.name, t.isrc);
    return `${idx + 1}\t${t.name}\t${t.artists}\t${t.isrc}\t${lang}\t${t.url}`;
  });
  const text = [headerLine, ...rows].join('\n');

  navigator.clipboard.writeText(text)
    .then(() => showToast('Copied list tab-separated to clipboard.'))
    .catch(() => showToast('Failed to copy. Please copy manually.'));
}

function isSpotifyForbiddenError(err) {
  return err?.status === 403 || /\bForbidden \(403\)/i.test(err?.message || '');
}

function formatSpotifyErrorDetails(err) {
  const body = err?.spotifyResponse;
  if (!body || !Object.keys(body).length) return '';
  return JSON.stringify(body, null, 2);
}

async function exportToHTML() {
  if (!allTracks.length || !playlistData) return;

  const htmlBtn = document.getElementById('htmlBtn');
  if (htmlBtn) htmlBtn.disabled = true;

  try {
    await enrichMissingPreviewUrls();

    const playlistName = playlistData.name || 'Playlist';
    const playlistOwner = playlistData.owner?.display_name || 'Unknown';
    const playlistUrl = playlistData.external_urls?.spotify || '';
    const playlistImage = playlistData.images?.[0]?.url || '';
    const exportedAt = new Date().toLocaleString();
    const safeName = makeSafeFilename(playlistName);
    const storageKey = `playlist-checklist:${safeName}:${allTracks.length}`;
    const htmlFileName = `${safeName}_checklist.html`;
    const spotifyLogoUrl = new URL('Spotify_Primary_Logo_RGB_White.png', window.location.href).href;
    const aiModeCheckbox = document.getElementById('aiModeCheckbox');
    const includeLanguageColumn = Boolean(aiModeCheckbox?.checked && allTracks.some(track => track.language));

    const rows = allTracks.map((track, index) => {
      const trackKey = getTrackKey(track, index);
      const artMarkup = track.albumArt
        ? track.previewUrl
          ? `<button class="art-play no-copy" type="button" data-preview-url="${escAttr(track.previewUrl)}" aria-label="Play preview for ${escAttr(track.name)}"><img src="${escAttr(track.albumArt)}" alt="" draggable="false"><span class="play-state">&#9654;</span></button>`
          : `<img class="no-copy song-art" src="${escAttr(track.albumArt)}" alt="" draggable="false" title="No preview available">`
        : '<span class="art-placeholder no-copy" title="No preview available"></span>';
      return `
        <tr>
          <td class="num">${index + 1}</td>
          <td class="song">
            ${artMarkup}
            <div>
              <strong>${escHtml(track.name)}</strong>
              <span class="album-name no-copy">${escHtml(track.album || '')}</span>
            </div>
          </td>
          <td>${escHtml(track.artists)}</td>
          <td><code>${escHtml(track.isrc || '-')}</code></td>
          ${includeLanguageColumn ? `<td>${escHtml(track.language || '')}</td>` : ''}
          <td><a class="open-link" href="${escAttr(track.url)}" target="_blank" rel="noopener">Open</a></td>
          <td class="done-cell"><input type="checkbox" data-track-key="${escAttr(trackKey)}" aria-label="Mark ${escAttr(track.name)} done"></td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(playlistName)} Checklist</title>
  <style>
    :root { color-scheme: light; font-family: Inter, Arial, sans-serif; --green:#1db954; --ink:#101828; --muted:#667085; --line:#e4e7ec; --soft:#f8fafc; --page:#f3f6f8; --panel:#ffffff; --head:#ffffff; --brand-bg:#f8fafc; --brand-border:#d0d5dd; --brand-filter:none; }
    html[data-theme="dark"] { color-scheme: dark; --ink:#f4f6fb; --muted:#a6acc7; --line:#2a2f3a; --soft:#11141b; --page:#070910; --panel:#141720; --head:#0a0a14; --brand-bg:#0a0a14; --brand-border:#3b4252; --brand-filter:none; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: var(--page); }
    header { background: #0a0a14; color: white; padding: 28px 32px; border-top: 12px solid var(--green); }
    .head { max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: auto 1fr auto; gap: 20px; align-items: center; }
    .cover { width: 86px; height: 86px; border-radius: 8px; object-fit: cover; background: #202436; }
    .spotify-mark { width: 86px; height: 86px; display: flex; align-items: center; justify-content: center; }
    .spotify-mark img { width: 86px; height: 86px; object-fit: contain; display: block; }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; }
    .meta { margin: 0; color: #b8c0d4; font-size: 14px; }
    main { max-width: 1180px; margin: 24px auto 34px; padding: 0 18px; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
    .toolbar p { margin: 0; color: var(--muted); font-size: 14px; }
    .toolbar-actions { display:flex; gap:10px; align-items:center; }
    .clear, .theme-toggle, .save-copy { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 7px; padding: 9px 12px; cursor: pointer; }
    .save-copy { border-color: var(--green); color: #087f3f; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-shadow: 0 12px 32px rgba(16,24,40,.08); }
    th { background: var(--green); color: white; text-align: left; font-size: 13px; padding: 11px 10px; }
    td { border-top: 1px solid var(--line); padding: 10px; vertical-align: middle; font-size: 14px; }
    tr.done { background: rgba(29,185,84,.10); }
    tr.done .song strong { text-decoration: line-through; color: var(--muted); }
    .num { width: 42px; color: var(--muted); }
    .song { display: flex; gap: 10px; align-items: center; min-width: 280px; }
    .song-art, .song img, .art-placeholder, .art-play { width: 44px; height: 44px; border-radius: 5px; object-fit: cover; flex: 0 0 auto; background: var(--line); }
    .art-play { position: relative; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; cursor: pointer; overflow: hidden; }
    .art-play img { width: 100%; height: 100%; border-radius: 5px; object-fit: cover; display: block; transition: filter .18s, transform .18s; }
    .art-play .play-state { position: absolute; right: 3px; bottom: 3px; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; background: rgba(0,0,0,.72); font-size: 10px; font-weight: 800; opacity: 1; transition: opacity .18s, background .18s; text-shadow: 0 1px 6px rgba(0,0,0,.8); }
    .art-play:hover img, .art-play.playing img { filter: brightness(.65); transform: scale(1.04); }
    .art-play:hover .play-state, .art-play.playing .play-state { opacity: 1; }
    .art-play.playing .play-state { background: rgba(29,185,84,.72); }
    .song strong { display: block; margin-bottom: 4px; }
    .song span { color: var(--muted); font-size: 12px; }
    code { color: #00897b; font-weight: 700; font-family: inherit; }
    .open-link { display: inline-flex; align-items: center; justify-content: center; min-width: 54px; height: 32px; border: 1px solid var(--green); color: #087f3f; border-radius: 7px; text-decoration: none; font-weight: 700; }
    .done-cell { text-align: center; width: 64px; }
    input[type="checkbox"] { width: 22px; height: 22px; accent-color: var(--green); cursor: pointer; }
    .no-copy, .num, .album-name, .spotify-mark, .spotify-mark img { -webkit-user-select: none; user-select: none; -webkit-user-drag: none; }
    .num, .album-name { pointer-events: none; }
    .site-footer { text-align: center; color: var(--muted); font-size: 13px; padding: 0 18px 36px; }
    .site-footer a { color: var(--green); font-weight: 700; text-decoration: none; margin: 0 8px; }
    @media (max-width: 760px) { table { font-size: 13px; } th:nth-child(4), td:nth-child(4) { display:none; } ${includeLanguageColumn ? 'th:nth-child(5), td:nth-child(5) { display:none; }' : ''} .head { grid-template-columns: auto 1fr; align-items:flex-start; } .spotify-mark { display:none; } }
  </style>
</head>
<body>
  <header>
    <div class="head">
      ${playlistImage ? `<img class="cover" src="${escAttr(playlistImage)}" alt="">` : '<div class="cover"></div>'}
      <div>
        <h1>${escHtml(playlistName)}</h1>
        <p class="meta">By ${escHtml(playlistOwner)} · ${allTracks.length} tracks · Exported ${escHtml(exportedAt)}${playlistUrl ? ` · <a href="${escAttr(playlistUrl)}" target="_blank" rel="noopener" style="color:#7df0a2">Open playlist</a>` : ''}</p>
      </div>
      <div class="spotify-mark">
        <img class="no-copy" src="${escAttr(spotifyLogoUrl)}" alt="Spotify" draggable="false">
      </div>
    </div>
  </header>
  <main>
    <div class="toolbar">
      <p>Done ticks are saved in this browser for this HTML checklist.</p>
      <div class="toolbar-actions">
        <button class="save-copy" id="saveCopy">Save HTML Copy</button>
        <button class="theme-toggle" id="themeToggle">Dark Mode</button>
        <button class="clear" id="clearDone">Clear Done</button>
      </div>
    </div>
    <table>
      <thead><tr><th>#</th><th>Song</th><th>Artists</th><th>ISRC</th>${includeLanguageColumn ? '<th>Language</th>' : ''}<th>Spotify</th><th>Done</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
  <footer class="site-footer">
    <a href="https://playlistinfoexporter.vercel.app/" target="_blank" rel="noopener">playlistinfoexporter.vercel.app</a>
    <a href="https://playlistinfoexporter.onrender.com/" target="_blank" rel="noopener">playlistinfoexporter.onrender.com</a>
  </footer>
  <script type="application/json" id="embeddedDone">{}</script>
  <script type="application/json" id="embeddedTheme">"light"</script>
  <script>
    const storageKey = ${JSON.stringify(storageKey)};
    const fileName = ${JSON.stringify(htmlFileName)};
    const themeKey = storageKey + ':theme';
    const themeToggle = document.getElementById('themeToggle');
    const embeddedDone = document.getElementById('embeddedDone');
    const embeddedTheme = document.getElementById('embeddedTheme');
    const previewAudio = new Audio();
    let activePreviewButton = null;

    let hasStorage = true;
    try {
      const testKey = '__storage_test__';
      window.localStorage.setItem(testKey, testKey);
      window.localStorage.removeItem(testKey);
    } catch (e) {
      hasStorage = false;
    }
    function safeGetItem(key) {
      if (!hasStorage) return null;
      try { return window.localStorage.getItem(key); } catch (_) { return null; }
    }
    function safeSetItem(key, val) {
      if (!hasStorage) return;
      try { window.localStorage.setItem(key, val); } catch (_) {}
    }

    function readEmbeddedJson(el, fallback) {
      try { return JSON.parse(el.textContent || ''); } catch (_) { return fallback; }
    }
    function applyTheme(theme) {
      document.documentElement.dataset.theme = theme;
      themeToggle.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
      safeSetItem(themeKey, theme);
      embeddedTheme.textContent = JSON.stringify(theme);
    }
    const embeddedThemeValue = readEmbeddedJson(embeddedTheme, 'light');
    applyTheme(safeGetItem(themeKey) || embeddedThemeValue || 'light');
    themeToggle.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      updateEmbeddedState();
    });
    const embeddedState = readEmbeddedJson(embeddedDone, {});
    const saved = Object.assign({}, embeddedState, JSON.parse(safeGetItem(storageKey) || '{}'));
    const boxes = document.querySelectorAll('input[type="checkbox"][data-track-key]');
    document.querySelectorAll('img.no-copy').forEach(img => {
      img.addEventListener('contextmenu', event => event.preventDefault());
      img.addEventListener('dragstart', event => event.preventDefault());
    });
    function stopPreview() {
      previewAudio.pause();
      previewAudio.removeAttribute('src');
      previewAudio.load();
      if (activePreviewButton) {
        activePreviewButton.classList.remove('playing');
        const state = activePreviewButton.querySelector('.play-state');
        if (state) state.textContent = '\\u25b6';
      }
      activePreviewButton = null;
    }
    document.querySelectorAll('.art-play[data-preview-url]').forEach(button => {
      button.addEventListener('contextmenu', event => event.preventDefault());
      button.addEventListener('dragstart', event => event.preventDefault());
      button.addEventListener('click', () => {
        const previewUrl = button.dataset.previewUrl;
        if (!previewUrl) return;
        if (activePreviewButton === button && !previewAudio.paused) {
          stopPreview();
          return;
        }
        stopPreview();
        activePreviewButton = button;
        button.classList.add('playing');
        const state = button.querySelector('.play-state');
        if (state) state.textContent = '\\u275a\\u275a';
        previewAudio.src = previewUrl;
        previewAudio.play().catch(() => {
          if (state) state.textContent = '!';
          setTimeout(stopPreview, 800);
        });
      });
    });
    previewAudio.addEventListener('ended', stopPreview);
    previewAudio.addEventListener('pause', () => {
      if (previewAudio.ended) stopPreview();
    });
    function syncRow(box) { box.closest('tr').classList.toggle('done', box.checked); }
    function currentDoneState() {
      const state = {};
      boxes.forEach(box => { if (box.checked) state[box.dataset.trackKey] = true; });
      return state;
    }
    function updateEmbeddedState() {
      embeddedDone.textContent = JSON.stringify(currentDoneState());
      embeddedTheme.textContent = JSON.stringify(document.documentElement.dataset.theme || 'light');
    }
    function downloadCurrentHtml() {
      stopPreview();
      updateEmbeddedState();
      const html = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    boxes.forEach(box => {
      box.checked = saved[box.dataset.trackKey] === true;
      syncRow(box);
      box.addEventListener('change', () => {
        saved[box.dataset.trackKey] = box.checked;
        safeSetItem(storageKey, JSON.stringify(saved));
        syncRow(box);
        updateEmbeddedState();
      });
    });
    updateEmbeddedState();
    document.getElementById('saveCopy').addEventListener('click', downloadCurrentHtml);
    document.getElementById('clearDone').addEventListener('click', () => {
      boxes.forEach(box => { box.checked = false; delete saved[box.dataset.trackKey]; syncRow(box); });
      safeSetItem(storageKey, JSON.stringify(saved));
      updateEmbeddedState();
    });
  </script>
</body>
</html>`;

    downloadTextFile(htmlFileName, html, 'text/html');
    showToast('HTML checklist downloaded.');
  } catch (err) {
    console.error('HTML export failed:', err);
    showToast('HTML export failed. Please check console.');
  } finally {
    if (htmlBtn) htmlBtn.disabled = false;
  }
}

async function enrichMissingPreviewUrls() {
  const missing = allTracks.filter(track => !track.previewUrl && track.name && track.artists);
  if (!missing.length) return;

  const htmlBtn = document.getElementById('htmlBtn');
  const originalText = htmlBtn?.querySelector?.('.btn-text')?.textContent || htmlBtn?.textContent || '';
  setLoading(true, `Finding playable previews (0 / ${missing.length})...`);

  let found = 0;
  for (let i = 0; i < missing.length; i++) {
    const track = missing[i];
    const previewUrl = await findPreviewUrl(track);
    if (previewUrl) {
      track.previewUrl = previewUrl;
      track.previewSource = 'apple_music';
      found++;
    }
    setLoading(true, `Finding playable previews (${i + 1} / ${missing.length})...`);
  }

  setLoading(false);
  if (found) showToast(`Added ${found} playable preview${found === 1 ? '' : 's'} to HTML.`);
  if (htmlBtn?.querySelector?.('.btn-text')) htmlBtn.querySelector('.btn-text').textContent = originalText;
}

async function findPreviewUrl(track) {
  const primaryArtist = (track.artists || '').split(',')[0].trim();
  const term = [track.name, primaryArtist].filter(Boolean).join(' ');
  if (!term) return '';

  try {
    const resp = await fetch(`https://itunes.apple.com/search?${new URLSearchParams({
      term,
      media: 'music',
      entity: 'song',
      limit: '5'
    })}`);
    if (!resp.ok) return '';
    const data = await resp.json();
    const candidates = data.results || [];
    const normalizedName = normalizePreviewText(track.name);
    const normalizedArtist = normalizePreviewText(primaryArtist);
    const match = candidates.find(item => {
      const itemName = normalizePreviewText(item.trackName || '');
      const itemArtist = normalizePreviewText(item.artistName || '');
      return item.previewUrl && (!normalizedName || itemName.includes(normalizedName) || normalizedName.includes(itemName)) && (!normalizedArtist || itemArtist.includes(normalizedArtist) || normalizedArtist.includes(itemArtist));
    }) || candidates.find(item => item.previewUrl);
    return match?.previewUrl || '';
  } catch (err) {
    console.warn('[Preview] Failed to find preview:', track.name, err.message);
    return '';
  }
}

function normalizePreviewText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function downloadTextFile(filename, text, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function makeSafeFilename(value) {
  return String(value || 'playlist').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'playlist';
}

function getTrackKey(track, index) {
  return track.url || `${index + 1}:${track.name}:${track.artists}`;
}

function escAttr(str) {
  return escHtml(String(str || '')).replace(/'/g, '&#39;');
}

// ─── Image Downloader (Cover Art Base64) ─────

async function svgToPngDataUrl(svgString, width = 120, height = 120) {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
  });
}

async function getImageUrlAsJpeg(url, maxW, maxH) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function drawOpenTrackButton(doc, x, y, url) {
  const size = 6;
  doc.setDrawColor(29, 185, 84);
  doc.setFillColor(237, 252, 244);
  doc.roundedRect(x, y, size, size, 1.2, 1.2, 'FD');
  doc.setLineWidth(0.45);
  doc.line(x + 1.7, y + 4.1, x + 4.1, y + 1.7);
  doc.line(x + 2.9, y + 1.7, x + 4.1, y + 1.7);
  doc.line(x + 4.1, y + 1.7, x + 4.1, y + 2.9);
  doc.link(x, y, size, size, { url });
}

function addDoneCheckbox(doc, fieldName, x, y, size) {
  if (typeof doc.AcroFormCheckBox === 'function' && typeof doc.addField === 'function') {
    try {
      const checkbox = new doc.AcroFormCheckBox();
      checkbox.fieldName = fieldName;
      checkbox.Rect = [x, y, size, size];
      checkbox.value = 'Off';
      checkbox.appearanceState = 'Off';
      checkbox.defaultValue = 'Off';
      checkbox.readOnly = false;
      checkbox.required = false;
      checkbox.noToggleToOff = false;
      doc.addField(checkbox);
      return;
    } catch (err) {
      console.warn('[PDF] Falling back to visual checkbox:', err.message);
    }
  }

  doc.setDrawColor(29, 185, 84);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x, y, size, size, 0.8, 0.8, 'FD');
}

// ─── PDF Exporter ─────────────────────────────

async function exportToPDF() {
  if (!allTracks.length || !playlistData) return;

  const pdfBtn  = document.getElementById('pdfBtn');
  const copyBtn = document.getElementById('copyBtn');

  if (pdfBtn)  pdfBtn.disabled = true;
  if (copyBtn) copyBtn.disabled = true;

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

    const pageW = doc.internal.pageSize.getWidth(); // 210
    const pageH = doc.internal.pageSize.getHeight(); // 297
    const mL = 16;
    const cW = pageW - (mL * 2);

    let y = 0;

    // Pre-fetch cover artwork
    let coverJpg = null;
    if (playlistData.images?.[0]?.url) {
      setLoading(true, 'Downloading high-res cover art…');
      coverJpg = await getImageUrlAsJpeg(playlistData.images[0].url, 800, 800);
    }

    // Helper for header styling on track list pages
    const drawHeader = () => {
      doc.setFillColor(248, 250, 252); doc.rect(0, 0, pageW, 24, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(29, 185, 84);
      doc.text('Playlist Info Exporter', mL, 15);
      
      const plLabel = playlistData.name.slice(0, 32) + (playlistData.name.length > 32 ? '…' : '');
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140, 140, 160);
      const rightTextWidth = doc.getTextWidth(plLabel);
      doc.text(plLabel, pageW - mL - rightTextWidth, 15);

      doc.setDrawColor(220, 224, 230); doc.setLineWidth(0.4);
      doc.line(mL, 24, pageW - mL, 24);
    };

    // Helper for footer with interactive link
    const drawFooter = (pageNum, totalPages) => {
      doc.setDrawColor(220, 224, 230); doc.setLineWidth(0.2);
      doc.line(mL, pageH - 16, pageW - mL, pageH - 16);

      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(160, 160, 180);
      doc.text(`Page ${pageNum} of ${totalPages}`, mL, pageH - 10);

      const footnote = 'Note: AI language detection is search-based and may occasionally make mistakes.';
      const fnW = doc.getTextWidth(footnote);
      doc.text(footnote, pageW / 2 - fnW / 2, pageH - 13);

      const ghLabel = 'GitHub: MindMatrix-07/PlaylistinfoExporter';
      const ghLabelWidth = doc.getTextWidth(ghLabel);
      doc.textWithLink(ghLabel, pageW - mL - ghLabelWidth, pageH - 10, { url: 'https://github.com/MindMatrix-07/PlaylistinfoExporter' });
    };

    const checkPage = (heightNeeded) => {
      if (y + heightNeeded > (pageH - 20)) {
        doc.addPage();
        drawHeader();
        y = 32;
      }
    };

    // ─── COVER PAGE ───────────────────────────────
    doc.setFillColor(10, 10, 20); doc.rect(0, 0, pageW, pageH, 'F');
    doc.setFillColor(29, 185, 84); doc.rect(0, 0, pageW, 55, 'F');
    doc.setFillColor(0, 0, 0); doc.circle(pageW / 2, 28, 18, 'F');

    const spotifySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1DB954"/><path d="M17.9 10.9C14.7 9 9.35 8.8 6.3 9.75c-.5.15-1-.15-1.15-.6-.15-.5.15-1 .6-1.15 3.55-1.05 9.4-.85 13.1 1.35.45.25.6.85.35 1.3-.25.35-.85.5-1.3.25zm-.1 2.8c-.25.35-.7.5-1.05.25-2.7-1.65-6.8-2.15-9.95-1.15-.4.1-.8-.1-.9-.5-.1-.4.1-.8.5-.9 3.65-1.1 8.15-.55 11.25 1.35.3.15.45.65.15 1zm-1.2 2.75c-.2.3-.55.4-.85.2-2.35-1.45-5.3-1.75-8.8-.95-.35.1-.65-.15-.75-.45-.1-.35.15-.65.45-.75 3.8-.85 7.1-.5 9.7 1.1.35.15.4.55.25.85z" fill="white"/></svg>`;
    const logoPng = await svgToPngDataUrl(spotifySvg, 120, 120);
    if (logoPng) {
      doc.addImage(logoPng, 'PNG', pageW / 2 - 12, 16, 24, 24);
    }

    doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(255, 255, 255);
    doc.text(doc.splitTextToSize(playlistData?.name || 'Playlist', cW), pageW / 2, 72, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(160, 220, 160);
    doc.text(`by ${playlistData?.owner?.display_name || 'Unknown'}`, pageW / 2, 84, { align: 'center' });
    doc.setFontSize(10); doc.setTextColor(130, 130, 180);
    doc.text(`${allTracks.length} tracks`, pageW / 2, 92, { align: 'center' });

    if (coverJpg) {
      const coverSize = 160;
      const coverY = 98;
      const coverX = pageW / 2 - coverSize / 2;
      doc.addImage(coverJpg, 'JPEG', coverX, coverY, coverSize, coverSize);
    }

    doc.setFontSize(8.5); doc.setTextColor(29, 185, 84);
    doc.text(playlistData?.external_urls?.spotify || '', pageW / 2, pageH - 30, { align: 'center' });
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(140, 140, 150);
    doc.text('Note: AI language detection is search-based and may occasionally make mistakes.', pageW / 2, pageH - 23, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 100);
    doc.text('Generated with Playlist Info Exporter', pageW / 2, pageH - 16, { align: 'center' });
    doc.setFontSize(7.5); doc.setTextColor(100, 100, 140);
    const ghLabel = '[ GitHub ]  github.com/MindMatrix-07/PlaylistinfoExporter';
    const ghLabelWidth = doc.getTextWidth(ghLabel);
    doc.textWithLink(ghLabel, pageW / 2 - ghLabelWidth / 2, pageH - 9, { url: 'https://github.com/MindMatrix-07/PlaylistinfoExporter' });

    // ─── TRACKS PAGE ──────────────────────────────
    doc.addPage(); drawHeader(); y = 32;
    doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(20,20,40);
    doc.text('Track List', mL, y); y += 8;

    const aiModeCheckbox = document.getElementById('aiModeCheckbox');
    const isAiOn = aiModeCheckbox && aiModeCheckbox.checked;

    const thumbSize = 9; // mm — album art thumbnail square

    let cN, cS, cA, cI, cLa, cOpen, cDone;
    let songWrapWidth, albumWrapWidth, artistWrapWidth, langWrapWidth;

    if (isAiOn) {
      cN = mL;
      cS = mL + 18;        // shifted right: #(4) + thumb(9) + gap(5)
      cA = mL + 70;
      cI = mL + 110;
      cLa = mL + 138;
      cOpen = mL + 158;
      cDone = mL + 171;
      songWrapWidth = 46;
      albumWrapWidth = 46;
      artistWrapWidth = 38;
      langWrapWidth = 20;
    } else {
      cN = mL;
      cS = mL + 18;
      cA = mL + 80;
      cI = mL + 130;
      cLa = null;
      cOpen = mL + 154;
      cDone = mL + 170;
      songWrapWidth = 56;
      albumWrapWidth = 56;
      artistWrapWidth = 46;
      langWrapWidth = 0;
    }

    doc.setFillColor(29,185,84); doc.rect(mL,y,cW,8,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(255,255,255);
    doc.text('#',cN,y+5.5); doc.text('Song',cS,y+5.5);
    doc.text('Artists',cA,y+5.5); doc.text('ISRC',cI,y+5.5);
    if (isAiOn) {
      doc.text('Language',cLa,y+5.5);
    }
    doc.text('Open',cOpen,y+5.5);
    doc.text('Done',cDone,y+5.5);
    y += 10;

    // Pre-fetch all album art thumbnails in parallel
    const thumbDataUrls = await Promise.all(
      allTracks.map(track => track.albumArt ? getImageUrlAsJpeg(track.albumArt, 80, 80) : Promise.resolve(null))
    );

    for (let i = 0; i < allTracks.length; i++) {
      const track = allTracks[i];
      const thumbData = thumbDataUrls[i];
      // Split text to fit columns for multi-line wrapping
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      const songLines = doc.splitTextToSize(track.name, songWrapWidth);

      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
      const artistLines = doc.splitTextToSize(track.artists, artistWrapWidth);

      let langLines = [];
      if (isAiOn) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
        langLines = doc.splitTextToSize(track.language || 'English', langWrapWidth);
      }

      // Calculate row height dynamically (min 11mm to always fit thumbnail)
      const songH = songLines.length * 3.2 + 3.5;
      const artistH = artistLines.length * 3.0 + 3.5;
      const langH = isAiOn ? (langLines.length * 2.8 + 3.5) : 0;
      const rH = Math.max(thumbSize + 2, songH, artistH, langH);

      checkPage(rH + 2);

      // Alternate row backgrounds
      if (i % 2 === 0) {
        doc.setFillColor(248, 250, 252);
        doc.rect(mL, y - 1, cW, rH, 'F');
      }

      // Draw index
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(140, 140, 160);
      doc.text(String(i + 1), cN, y + 5.5);

      // Draw album art thumbnail
      const thumbX = mL + 5;
      const thumbY = y + (rH - thumbSize) / 2;
      if (thumbData) {
        doc.addImage(thumbData, 'JPEG', thumbX, thumbY, thumbSize, thumbSize);
      } else {
        doc.setFillColor(220, 220, 230);
        doc.rect(thumbX, thumbY, thumbSize, thumbSize, 'F');
      }

      // Draw Song Lines
      let songY = y + 5.0;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(20, 20, 40);
      songLines.forEach(line => {
        doc.text(line, cS, songY);
        songY += 3.2;
      });

      // Draw Artist Lines
      let artistY = y + 5.0;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(60, 60, 100);
      artistLines.forEach(line => {
        doc.text(line, cA, artistY);
        artistY += 3.0;
      });

      if (isAiOn) {
        // Draw Language Lines
        let langY = y + 5.0;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(80, 80, 100);
        langLines.forEach(line => {
          doc.text(line, cLa, langY);
          langY += 2.8;
        });
      }

      // Draw ISRC (centered vertically in row)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(0, 150, 136);
      doc.text(track.isrc !== '—' ? track.isrc : '—', cI, y + (rH / 2) + 1);

      // Draw compact Spotify open button and interactive done checkbox.
      const actionY = y + (rH - 6) / 2;
      drawOpenTrackButton(doc, cOpen + 2, actionY, track.url);
      addDoneCheckbox(doc, `done_track_${i + 1}`, cDone + 2, actionY, 6);

      // Draw cell separator line
      doc.setDrawColor(225, 228, 240); doc.setLineWidth(0.2);
      doc.line(mL, y + rH - 1, mL + cW, y + rH - 1);

      y += rH;
    }

    y += 6; checkPage(14);
    doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(160,160,180);
    const disclaimerBlock = doc.splitTextToSize('Disclaimer: The track info, links and ISRCs are retrieved from public Spotify indexes. AI language detection is search-based and is a best-effort prediction that may contain inaccuracies. Save the PDF after ticking Done boxes to keep those marks next time you open it.', cW);
    doc.text(disclaimerBlock, mL, y);

    // Apply footer numbers & links to all pages after rendering
    const totalPages = doc.getNumberOfPages();
    for (let pNum = 2; pNum <= totalPages; pNum++) {
      doc.setPage(pNum);
      drawFooter(pNum, totalPages);
    }

    const filename = (playlistData.name || 'playlist')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_tracklist.pdf';
    doc.save(filename);
    showToast('PDF booklet downloaded.');

  } catch (err) {
    console.error('PDF export failed:', err);
    showToast('Export failed. Please check console.');
  } finally {
    setLoading(false);
    if (pdfBtn)  pdfBtn.disabled = false;
    if (copyBtn) copyBtn.disabled = false;
  }
}

// ─── Google AI Mode Extension Handler ──────────

let hasExtension = false;
const pendingRequests = new Map();

function checkExtensionPresence() {
  const isNativeExt = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;
  const isPresent = isNativeExt || hasExtension;
  const container = document.getElementById('aiModeInstallContainer');
  const toggleContainer = document.getElementById('aiModeContainer');

  if (isPresent) {
    if (container) container.style.display = 'none';
    if (toggleContainer) toggleContainer.style.display = 'block';
  } else {
    if (container) container.style.display = 'block';
    if (toggleContainer) toggleContainer.style.display = 'none';
  }
}

function initAiToggleListener() {
  const cb = document.getElementById('aiModeCheckbox');
  if (!cb) return;

  cb.addEventListener('change', () => {
    if (cb.checked && allTracks.length > 0 && !aiDetectionInProgress) {
      startGoogleAiLanguageDetection();
    } else if (!cb.checked) {
      aiDetectionInProgress = false;
    }
  });
}

function askGoogleAiLang(song, artists) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'ASK_GOOGLE_AI_LANG', song, artists },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (res && res.ok) {
            resolve(res.language);
          } else {
            reject(new Error(res?.error || 'AI Mode failed.'));
          }
        }
      );
    });
  }

  return new Promise((resolve, reject) => {
    const key = `${song}||${artists}`;
    const timeout = setTimeout(() => {
      pendingRequests.delete(key);
      reject(new Error('AI Request timed out.'));
    }, 60000);

    pendingRequests.set(key, { resolve, reject, timeout });

    window.postMessage({ type: "FROM_PAGE_ASK_AI_LANG", song, artists }, "*");
  });
}

async function startGoogleAiLanguageDetection() {
  if (aiDetectionInProgress) return;
  aiDetectionInProgress = true;

  const pdfBtn = document.getElementById('pdfBtn');
  const copyBtn = document.getElementById('copyBtn');

  if (pdfBtn) {
    pdfBtn.disabled = true;
    pdfBtn.innerHTML = `<span class="spinner-ring" style="width:12px;height:12px;border-width:2px;margin:0"></span> Scanning Languages…`;
  }
  if (copyBtn) {
    copyBtn.disabled = true;
  }

  showToast('⚡ Google AI Mode Active: Fetching track languages in background…');

  for (let i = 0; i < allTracks.length; i++) {
    if (!aiDetectionInProgress) break;

    const track = allTracks[i];
    if (track.language) continue; // Skip already fetched

    const badge = document.getElementById(`lang-badge-${i}`);
    if (badge) {
      badge.textContent = 'Scanning…';
      badge.classList.add('scanning-text');
    }

    let response = '';
    for (let attempt = 1; attempt <= 3 && aiDetectionInProgress; attempt++) {
      try {
        if (badge) badge.textContent = attempt === 1 ? 'Scanning…' : `Retrying ${attempt}/3…`;
        response = await askGoogleAiLang(track.name, track.artists);
        break;
      } catch (err) {
        console.warn(`[AI Mode] Failed for "${track.name}" attempt ${attempt}:`, err.message);

        if (err.message && err.message.includes('CAPTCHA')) {
          showToast('⚠️ Google CAPTCHA appeared. Please solve it.');
          aiDetectionInProgress = false;
          break;
        }

        if (attempt < 3) {
          await sleep(3000);
        }
      }
    }

    if (!aiDetectionInProgress) break;

    if (response) {
      track.language = response;

      if (badge) {
        badge.classList.remove('scanning-text');
        badge.textContent = response;
      }

      await sleep(2500);
    } else if (badge) {
      badge.classList.remove('scanning-text');
      badge.textContent = 'Skipped';
      showToast(`Skipped language: ${track.name}`);
      await sleep(1500);
    }
  }

  aiDetectionInProgress = false;
  
  // Re-enable buttons
  const cb = document.getElementById('aiModeCheckbox');
  if (cb && cb.checked) {
    if (pdfBtn) {
      pdfBtn.disabled = false;
      pdfBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" style="width:16px;height:16px"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z" fill="currentColor"/></svg> Export PDF`;
    }
    if (copyBtn) {
      copyBtn.disabled = false;
    }
  }
}

// Listen to webpage postMessage channel from content script
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "PONG_PLAYLIST_EXPORTER_EXT") {
    hasExtension = true;
    checkExtensionPresence();
  }

  if (event.data?.type === "FROM_EXT_AI_LANG_RESPONSE") {
    const { ok, language, error, song } = event.data;
    for (const [key, promise] of pendingRequests.entries()) {
      if (key.startsWith(song + "||")) {
        clearTimeout(promise.timeout);
        pendingRequests.delete(key);
        if (ok) {
          promise.resolve(language);
        } else {
          promise.reject(new Error(error || "AI Mode failed."));
        }
        break;
      }
    }
  }
});

// ─── Init ─────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Show redirect URI hint
  const el = document.getElementById('redirectUriDisplay');
  if (el) el.textContent = window.location.origin + '/test.html';

  const defaultMode = window.location.hostname === 'playlistinfoexporter.onrender.com' ? 'web' : 'premium';
  setFetchMode(defaultMode);

  // Handle OAuth callback if page has params
  await handleCallback();

  // Update UI based on auth state
  updateAuthUI();

  // Ping for extension presence and setup toggles
  window.postMessage({ type: "PING_PLAYLIST_EXPORTER_EXT" }, "*");
  checkExtensionPresence();
  initAiToggleListener();

  // Enter key on playlist URL
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.activeElement?.id === 'playlistUrl') fetchPlaylist();
  });
});
