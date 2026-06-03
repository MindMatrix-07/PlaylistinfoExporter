/* ============================================
   Spotify Playlist Exporter v2.0 — PKCE OAuth
   ============================================ */

let allTracks = [];
let playlistData = null;
let aiScrapingInProgress = false;

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
const REDIRECT_URI = window.location.origin;

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
    window.history.replaceState({}, '', '/');
    return;
  }
  if (!code) return;

  const clientId = localStorage.getItem('sp_client_id');
  const verifier = localStorage.getItem('sp_verifier');

  if (!clientId || !verifier) {
    showError('Auth state missing — please try connecting again.');
    window.history.replaceState({}, '', '/');
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

  window.history.replaceState({}, '', '/');
}

function getToken() {
  const token  = localStorage.getItem('sp_token');
  const expiry = parseInt(localStorage.getItem('sp_expiry') || '0');
  return (token && Date.now() < expiry) ? token : null;
}

function disconnectSpotify() {
  ['sp_token','sp_expiry','sp_refresh','sp_client_id'].forEach(k => localStorage.removeItem(k));
  updateAuthUI();
}

// ─── UI State ─────────────────────────────────

function updateAuthUI() {
  const token = getToken();
  document.getElementById('authCard').style.display     = token ? 'none'  : 'block';
  document.getElementById('playlistCard').style.display  = token ? 'block' : 'none';
  document.getElementById('connectedStatus').style.display  = token ? 'flex'  : 'none';
  document.getElementById('notConnectedBadge').style.display = token ? 'none' : 'block';

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
    throw new Error(`Failed to load playlist metadata: ${errMsg} (${resp.status})`);
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
      throw new Error(`Failed to fetch tracks: ${errMsg} (${resp.status})`);
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
        url:     t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
        isrc:    isrc,
        language: detectLanguage(t.name || '', isrc)
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

  const token = getToken();
  if (!token) {
    showError('Session expired — please reconnect Spotify.', 'errorBox2');
    disconnectSpotify();
    return;
  }

  localStorage.setItem('sp_last_url', rawUrl);
  setFetchBtn(true);
  document.getElementById('resultsSection').style.display = 'none';
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
      aiScrapingInProgress = false;
      setTimeout(() => {
        startGoogleAiLanguageScraping();
      }, 100);
    }

  } catch (err) {
    setLoading(false);
    showError(err.message || 'Something went wrong.', 'errorBox2');
  } finally {
    setFetchBtn(false);
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
  document.getElementById('connectedName').textContent = '✓ Connected';

  const body = document.getElementById('tracksBody');
  body.innerHTML = '';
  allTracks.forEach((track, i) => {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.style.animationDelay = `${Math.min(i * 18, 500)}ms`;
    row.innerHTML = `
      <span class="col-num">${i + 1}</span>
      <div class="col-title">
        <span class="track-name" title="${escHtml(track.name)}">${escHtml(track.name)}</span>
        <span class="track-album" title="${escHtml(track.album)}">${escHtml(track.album)}</span>
      </div>
      <span class="col-artists" title="${escHtml(track.artists)}">${escHtml(track.artists)}</span>
      <span class="col-isrc"><span class="isrc-badge">${escHtml(track.isrc)}</span></span>
      <span class="col-lang"><span class="lang-badge">${escHtml(track.language)}</span></span>
      <span class="col-link">
        <a href="${track.url}" target="_blank">
          <svg viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Open
        </a>
      </span>`;
    body.appendChild(row);
  });

  document.getElementById('resultsSection').style.display = 'block';
  document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Copy All ─────────────────────────────────

function copyToClipboard() {
  if (!allTracks.length) return;
  const lines = allTracks.map((t, i) =>
    `${i+1}. ${t.name}\n   Artists: ${t.artists}\n   ISRC: ${t.isrc}\n   Language: ${t.language}\n   Link: ${t.url}`);
  const text = `${playlistData?.name || 'Playlist'} — ${allTracks.length} Tracks\n\n` + lines.join('\n\n');
  navigator.clipboard.writeText(text)
    .then(() => showToast('✓ Copied to clipboard!'))
    .catch(() => showToast('Could not copy.'));
}

// Helper to convert Spotify logo SVG to PNG Data URL
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
    img.onerror = () => {
      resolve(null);
    };
  });
}

// Helper to fetch external image URL and convert to JPEG Data URL
async function getImageUrlAsJpeg(url, width = 300, height = 300) {
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      resolve(null);
    };
  });
}

// ─── Export PDF ───────────────────────────────

async function exportToPDF() {
  if (!allTracks.length) return;
  const btn = document.getElementById('pdfBtn');
  btn.disabled = true; btn.textContent = 'Generating…';

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const mL = 12, mR = 12, cW = pageW - mL - mR;
    let y = 0;

    function checkPage(n = 10) {
      if (y + n > pageH - 16) { doc.addPage(); drawHeader(); y = 34; }
    }
    function drawHeader() {
      doc.setFillColor(29,185,84); doc.rect(0,0,pageW,6,'F');
      doc.setFillColor(248,249,252); doc.rect(0,6,pageW,20,'F');
      const pn = doc.internal.getCurrentPageInfo().pageNumber;
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(160,160,160);
      doc.text(`Page ${pn}`, pageW-mR, 14, {align:'right'});
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(40,40,60);
      doc.text(playlistData?.name || 'Playlist', mL, 14);
    }

    // Cover
    doc.setFillColor(10,10,20); doc.rect(0,0,pageW,pageH,'F');
    doc.setFillColor(29,185,84); doc.rect(0,0,pageW,55,'F');
    doc.setFillColor(0,0,0); doc.circle(pageW/2,28,18,'F');
    
    // Draw Spotify Logo inside circle
    const spotifySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1DB954"/><path d="M17.9 10.9C14.7 9 9.35 8.8 6.3 9.75c-.5.15-1-.15-1.15-.6-.15-.5.15-1 .6-1.15 3.55-1.05 9.4-.85 13.1 1.35.45.25.6.85.35 1.3-.25.35-.85.5-1.3.25zm-.1 2.8c-.25.35-.7.5-1.05.25-2.7-1.65-6.8-2.15-9.95-1.15-.4.1-.8-.1-.9-.5-.1-.4.1-.8.5-.9 3.65-1.1 8.15-.55 11.25 1.35.3.15.45.65.15 1zm-1.2 2.75c-.2.3-.55.4-.85.2-2.35-1.45-5.3-1.75-8.8-.95-.35.1-.65-.15-.75-.45-.1-.35.15-.65.45-.75 3.8-.85 7.1-.5 9.7 1.1.35.15.4.55.25.85z" fill="white"/></svg>`;
    const logoPng = await svgToPngDataUrl(spotifySvg, 120, 120);
    if (logoPng) {
      doc.addImage(logoPng, 'PNG', pageW/2 - 12, 16, 24, 24);
    }

    doc.setFontSize(22); doc.setTextColor(255,255,255); doc.setFont('helvetica','bold');
    doc.text(doc.splitTextToSize(playlistData?.name || 'Playlist', cW), pageW/2, 72, {align:'center'});
    doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(160,220,160);
    doc.text(`by ${playlistData?.owner?.display_name || 'Unknown'}`, pageW/2, 84, {align:'center'});
    doc.setFontSize(10); doc.setTextColor(130,130,180);
    doc.text(`${allTracks.length} tracks`, pageW/2, 92, {align:'center'});

    // Draw Playlist Cover Image in the blank space
    const coverUrl = playlistData.images?.[0]?.url;
    if (coverUrl) {
      const coverJpg = await getImageUrlAsJpeg(coverUrl, 500, 500);
      if (coverJpg) {
        const coverSize = 105; // 105mm x 105mm
        doc.addImage(coverJpg, 'JPEG', pageW/2 - coverSize/2, 104, coverSize, coverSize);
        // Draw subtle border around artwork
        doc.setDrawColor(40, 40, 60);
        doc.setLineWidth(0.5);
        doc.rect(pageW/2 - coverSize/2, 104, coverSize, coverSize);
      }
    }

    doc.setFontSize(8.5); doc.setTextColor(29,185,84);
    doc.text(playlistData?.external_urls?.spotify || '', pageW/2, pageH-22, {align:'center'});
    doc.setTextColor(80,80,100);
    doc.text('Generated with Spotify Playlist Exporter', pageW/2, pageH-16, {align:'center'});

    // Tracks
    doc.addPage(); drawHeader(); y = 32;
    doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(20,20,40);
    doc.text('Track List', mL, y); y += 8;

    const cN=mL, cS=mL+10, cA=mL+62, cI=mL+106, cLa=mL+134, cLn=mL+160;
    doc.setFillColor(29,185,84); doc.rect(mL,y,cW,8,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(255,255,255);
    doc.text('#',cN,y+5.5); doc.text('Song',cS,y+5.5);
    doc.text('Artists',cA,y+5.5); doc.text('ISRC',cI,y+5.5); doc.text('Language',cLa,y+5.5); doc.text('Spotify',cLn,y+5.5);
    y += 10;

    allTracks.forEach((track, i) => {
      // Split text to fit columns for multi-line wrapping
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      const songLines = doc.splitTextToSize(track.name, 50);
      
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5);
      const albumLines = doc.splitTextToSize(track.album, 50);
      
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
      const artistLines = doc.splitTextToSize(track.artists, 42);

      doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
      const langLines = doc.splitTextToSize(track.language || 'English', 24);

      // Calculate row height dynamically
      const songH = songLines.length * 3.2 + albumLines.length * 2.6 + 3.5;
      const artistH = artistLines.length * 3.0 + 3.5;
      const langH = langLines.length * 2.8 + 3.5;
      const rH = Math.max(12, songH, artistH, langH);

      checkPage(rH + 2);

      // Alternate row backgrounds
      if (i % 2 === 0) {
        doc.setFillColor(248, 250, 252);
        doc.rect(mL, y - 1, cW, rH, 'F');
      }

      // Draw index
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(140, 140, 160);
      doc.text(String(i + 1), cN, y + 5.5);

      // Draw Song Lines
      let songY = y + 4.5;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(20, 20, 40);
      songLines.forEach(line => {
        doc.text(line, cS, songY);
        songY += 3.2;
      });

      // Draw Album Lines
      let albumY = songY - 0.4;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(160, 160, 180);
      albumLines.forEach(line => {
        doc.text(line, cS, albumY);
        albumY += 2.6;
      });

      // Draw Artist Lines
      let artistY = y + 5.0;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(60, 60, 100);
      artistLines.forEach(line => {
        doc.text(line, cA, artistY);
        artistY += 3.0;
      });

      // Draw Language Lines
      let langY = y + 5.0;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(80, 80, 100);
      langLines.forEach(line => {
        doc.text(line, cLa, langY);
        langY += 2.8;
      });

      // Draw ISRC (centered vertically in row)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(0, 150, 136);
      doc.text(track.isrc !== '—' ? track.isrc : '—', cI, y + (rH / 2) + 1);

      // Draw Spotify link (centered vertically in row)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(29, 185, 84);
      const tid = track.url.replace('https://open.spotify.com/track/', '').slice(0, 12);
      doc.textWithLink(tid + '…', cLn, y + (rH / 2) + 1, { url: track.url });

      // Draw cell separator line
      doc.setDrawColor(225, 228, 240); doc.setLineWidth(0.2);
      doc.line(mL, y + rH - 1, mL + cW, y + rH - 1);

      y += rH;
    });

    y += 6; checkPage(12);
    doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(180,180,200);
    doc.text(`Total: ${allTracks.length} tracks · Exported ${new Date().toLocaleDateString()} · Includes ISRC`, mL, y);

    const safe = (playlistData?.name||'playlist').replace(/[^a-z0-9]/gi,'_').toLowerCase();
    
    // Manual blob download trigger to guarantee filename and extension (.pdf)
    const blob = doc.output('blob');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safe}_tracklist.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('✓ PDF exported!');
  } catch(err) {
    console.error(err); showToast('PDF failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" style="width:16px;height:16px"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z" fill="currentColor"/></svg> Export PDF`;
  }
}

// ─── Google AI Mode Helpers ───────────────────

function checkExtensionPresence() {
  const isExt = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;
  const toggleContainer = document.getElementById('aiModeContainer');
  const installContainer = document.getElementById('aiModeInstallContainer');
  
  if (isExt) {
    if (toggleContainer) toggleContainer.style.display = 'block';
    if (installContainer) installContainer.style.display = 'none';
  } else {
    if (toggleContainer) toggleContainer.style.display = 'none';
    if (installContainer) installContainer.style.display = 'block';
  }
}

function initAiToggleListener() {
  const cb = document.getElementById('aiModeCheckbox');
  if (cb) {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (allTracks && allTracks.length > 0) {
          startGoogleAiLanguageScraping();
        }
      } else {
        aiScrapingInProgress = false;
      }
    });
  }
}

async function startGoogleAiLanguageScraping() {
  if (aiScrapingInProgress) return;
  aiScrapingInProgress = true;

  const tracksToScan = allTracks.map((t, idx) => ({ track: t, idx }));
  const body = document.getElementById('tracksBody');

  for (const item of tracksToScan) {
    if (!aiScrapingInProgress) break;

    const track = item.track;
    const idx = item.idx;
    const row = body ? body.children[idx] : null;
    const badge = row ? row.querySelector('.col-lang .lang-badge') : null;

    if (badge) {
      badge.classList.add('scanning-text');
      badge.textContent = '⚡ Scanning...';
    }

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'ASK_GOOGLE_AI_LANG', song: track.name, artists: track.artists },
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

      track.language = response;

      if (badge) {
        badge.classList.remove('scanning-text');
        badge.textContent = response;
      }
    } catch (err) {
      console.warn(`[AI Mode] Failed for "${track.name}":`, err.message);
      
      const fallback = detectLanguage(track.name, track.isrc);
      track.language = fallback;

      if (badge) {
        badge.classList.remove('scanning-text');
        badge.textContent = fallback;
      }

      if (err.message && err.message.includes('CAPTCHA')) {
        showToast('⚠️ Google CAPTCHA appeared. Please solve it.');
        aiScrapingInProgress = false;
        break;
      }
    }
  }

  aiScrapingInProgress = false;
}

// ─── Init ─────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Show redirect URI hint
  const el = document.getElementById('redirectUriDisplay');
  if (el) el.textContent = window.location.origin;

  // Handle OAuth callback
  await handleCallback();

  // Update UI based on auth state
  updateAuthUI();

  // Check extension presence and setup toggles
  checkExtensionPresence();
  initAiToggleListener();

  // Enter key on playlist URL
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.activeElement?.id === 'playlistUrl') fetchPlaylist();
  });
});
