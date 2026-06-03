/* ===================================================
   Spotify Playlist Exporter — app.js
   Uses Spotify Web API (Client Credentials) + jsPDF
   ISRC fetched directly from Spotify track data
   =================================================== */

let allTracks = [];
let playlistData = null;

// ─── Helpers ─────────────────────────────────────────

function showToast(msg, duration = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.innerHTML = `<svg style="width:16px;height:16px;flex-shrink:0" viewBox="0 0 24 24" fill="none">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/>
  </svg> ${msg}`;
  box.style.display = 'flex';
}

function hideError() {
  document.getElementById('errorBox').style.display = 'none';
}

function setLoading(show, text = 'Fetching playlist…') {
  document.getElementById('loadingState').style.display = show ? 'flex' : 'none';
  document.getElementById('loadingText').textContent = text;
}

function setFetchBtn(disabled) {
  const btn = document.getElementById('fetchBtn');
  btn.disabled = disabled;
  btn.querySelector('.btn-text').textContent = disabled ? 'Loading…' : 'Fetch Playlist';
}

// ─── Extract Playlist ID from URL or URI ─────────────

function extractPlaylistId(input) {
  input = input.trim();
  const uriMatch = input.match(/spotify:playlist:([a-zA-Z0-9]+)/);
  if (uriMatch) return uriMatch[1];
  const urlMatch = input.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9]{22}$/.test(input)) return input;
  return null;
}

// ─── Spotify API ──────────────────────────────────────

async function getAccessToken(clientId, clientSecret) {
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret)
    },
    body: 'grant_type=client_credentials'
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error_description || `Auth failed (${resp.status})`);
  }
  const data = await resp.json();
  return data.access_token;
}

async function fetchPlaylistMeta(token, playlistId) {
  const resp = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!resp.ok) throw new Error(`Playlist not found or private (${resp.status})`);
  return resp.json();
}

async function fetchAllTracks(token, playlistId, totalExpected, onProgress) {
  const limit = 100;
  let offset = 0;
  let tracks = [];

  while (true) {
    // Request external_ids (contains ISRC) along with other track fields
    const fields = 'items(track(id,name,artists(name),album(name),external_urls,external_ids)),next,total';
    const resp = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}&fields=${encodeURIComponent(fields)}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!resp.ok) throw new Error(`Failed to fetch tracks (${resp.status})`);
    const data = await resp.json();

    const items = data.items.filter(i => i.track && i.track.id);
    tracks = tracks.concat(items.map(i => ({
      name:    i.track.name,
      artists: i.track.artists.map(a => a.name).join(', '),
      album:   i.track.album?.name || '',
      url:     i.track.external_urls?.spotify || `https://open.spotify.com/track/${i.track.id}`,
      isrc:    i.track.external_ids?.isrc || '—'
    })));

    if (onProgress) onProgress(tracks.length, totalExpected || data.total);
    if (!data.next) break;
    offset += limit;
  }

  return tracks;
}

// Load credentials on startup
document.addEventListener('DOMContentLoaded', () => {
  const savedId = localStorage.getItem('spotify_client_id');
  const savedSecret = localStorage.getItem('spotify_client_secret');
  if (savedId) {
    document.getElementById('clientId').value = savedId;
  }
  if (savedSecret) {
    document.getElementById('clientSecret').value = savedSecret;
  }
});

// ─── Main Fetch Handler ───────────────────────────────

async function fetchPlaylist() {
  hideError();

  const clientId     = document.getElementById('clientId').value.trim();
  const clientSecret = document.getElementById('clientSecret').value.trim();
  const rawUrl       = document.getElementById('playlistUrl').value.trim();

  if (!clientId || !clientSecret) {
    showError('Please enter your Spotify Client ID and Client Secret.');
    return;
  }

  const playlistId = extractPlaylistId(rawUrl);
  if (!playlistId) {
    showError('Invalid playlist URL or URI. Example: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    return;
  }

  setFetchBtn(true);
  document.getElementById('resultsSection').style.display = 'none';
  setLoading(true, 'Authenticating with Spotify…');

  try {
    const token = await getAccessToken(clientId, clientSecret);

    // Save to localStorage on successful authentication
    localStorage.setItem('spotify_client_id', clientId);
    localStorage.setItem('spotify_client_secret', clientSecret);

    setLoading(true, 'Fetching playlist info…');
    playlistData = await fetchPlaylistMeta(token, playlistId);
    
    if (!playlistData || !playlistData.tracks) {
      console.error('Playlist response:', playlistData);
      throw new Error(`Playlist data could not be retrieved. Response keys: ${playlistData ? Object.keys(playlistData).join(', ') : 'null'}. Response string: ${JSON.stringify(playlistData)}`);
    }
    
    const total = playlistData.tracks.total;

    setLoading(true, `Fetching tracks (0 / ${total})…`);
    allTracks = await fetchAllTracks(token, playlistId, total, (done, all) => {
      setLoading(true, `Fetching tracks (${done} / ${all})…`);
    });

    setLoading(false);
    renderResults();

  } catch (err) {
    setLoading(false);
    showError(err.message || 'Something went wrong. Check your credentials and try again.');
  } finally {
    setFetchBtn(false);
  }
}

// ─── Render Results ───────────────────────────────────

function renderResults() {
  const meta = document.getElementById('playlistMeta');
  const img = playlistData.images?.[0]?.url;
  meta.innerHTML = `
    ${img
      ? `<img class="playlist-cover" src="${img}" alt="Cover" />`
      : `<div class="playlist-cover-placeholder">
           <svg style="width:32px;height:32px;color:#fff" viewBox="0 0 24 24" fill="none">
             <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" fill="currentColor"/>
           </svg>
         </div>`
    }
    <div class="playlist-info">
      <h2>${escHtml(playlistData.name)}</h2>
      <p>By ${escHtml(playlistData.owner?.display_name || 'Unknown')} &nbsp;·&nbsp; ${allTracks.length} tracks</p>
      <a class="playlist-link" href="${playlistData.external_urls?.spotify}" target="_blank">
        Open on Spotify
        <svg viewBox="0 0 24 24" fill="none" style="width:12px;height:12px"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </a>
    </div>
  `;

  document.getElementById('trackCountLabel').innerHTML =
    `<strong>${allTracks.length}</strong> tracks found`;

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
      <span class="col-isrc">
        <span class="isrc-badge" title="${escHtml(track.isrc)}">${escHtml(track.isrc)}</span>
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

  document.getElementById('resultsSection').style.display = 'block';
  document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Copy All ─────────────────────────────────────────

function copyToClipboard() {
  if (!allTracks.length) return;
  const lines = allTracks.map((t, i) =>
    `${i + 1}. ${t.name}\n   Artists: ${t.artists}\n   ISRC: ${t.isrc}\n   Link: ${t.url}`
  );
  const text = `${playlistData?.name || 'Playlist'} — ${allTracks.length} Tracks\n\n` + lines.join('\n\n');
  navigator.clipboard.writeText(text)
    .then(() => showToast('✓ Copied to clipboard!'))
    .catch(() => showToast('Could not copy. Try selecting manually.'));
}

// ─── Export PDF ───────────────────────────────────────

async function exportToPDF() {
  if (!allTracks.length) return;

  const btn = document.getElementById('pdfBtn');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const marginL = 12;
    const marginR = 12;
    const contentW = pageW - marginL - marginR;
    let y = 0;

    function checkPage(needed = 10) {
      if (y + needed > pageH - 16) {
        doc.addPage();
        drawPageHeader();
        y = 34;
      }
    }

    function drawPageHeader() {
      doc.setFillColor(29, 185, 84);
      doc.rect(0, 0, pageW, 6, 'F');
      doc.setFillColor(248, 249, 252);
      doc.rect(0, 6, pageW, 20, 'F');
      const pn = doc.internal.getCurrentPageInfo().pageNumber;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(160, 160, 160);
      doc.text(`Page ${pn}`, pageW - marginR, 14, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(40, 40, 60);
      doc.text(playlistData?.name || 'Playlist', marginL, 14);
    }

    // ── Cover Page ──
    doc.setFillColor(10, 10, 20);
    doc.rect(0, 0, pageW, pageH, 'F');

    doc.setFillColor(29, 185, 84);
    doc.rect(0, 0, pageW, 55, 'F');

    doc.setFillColor(0, 0, 0);
    doc.circle(pageW / 2, 28, 18, 'F');
    doc.setFillColor(29, 185, 84);
    doc.setFontSize(18);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.text('♪', pageW / 2, 32, { align: 'center' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(255, 255, 255);
    const title = playlistData?.name || 'Spotify Playlist';
    const titleLines = doc.splitTextToSize(title, contentW);
    doc.text(titleLines, pageW / 2, 70, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(160, 220, 160);
    doc.text(`by ${playlistData?.owner?.display_name || 'Unknown'}`, pageW / 2, 82, { align: 'center' });

    doc.setFontSize(10);
    doc.setTextColor(130, 130, 180);
    doc.text(`${allTracks.length} tracks`, pageW / 2, 90, { align: 'center' });

    if (playlistData?.description) {
      const desc = playlistData.description.replace(/<[^>]*>/g, '');
      if (desc) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(9);
        doc.setTextColor(120, 120, 160);
        const descLines = doc.splitTextToSize(desc, contentW);
        doc.text(descLines, pageW / 2, 102, { align: 'center' });
      }
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(29, 185, 84);
    const plUrl = playlistData?.external_urls?.spotify || '';
    doc.text(plUrl, pageW / 2, pageH - 22, { align: 'center' });
    doc.setTextColor(80, 80, 100);
    doc.text('Generated with Spotify Playlist Exporter', pageW / 2, pageH - 16, { align: 'center' });

    // ── Track Pages ──
    doc.addPage();
    drawPageHeader();
    y = 32;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(20, 20, 40);
    doc.text('Track List', marginL, y);
    y += 8;

    // Column layout: #  |  Song  |  Artists  |  ISRC  |  Link
    const colNum    = marginL;
    const colSong   = marginL + 10;
    const colArtist = marginL + 76;
    const colISRC   = marginL + 130;
    const colLink   = marginL + 162;

    // Table header
    doc.setFillColor(29, 185, 84);
    doc.rect(marginL, y, contentW, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(255, 255, 255);
    doc.text('#',          colNum,    y + 5.5);
    doc.text('Song Title', colSong,   y + 5.5);
    doc.text('Artists',    colArtist, y + 5.5);
    doc.text('ISRC',       colISRC,   y + 5.5);
    doc.text('Spotify',    colLink,   y + 5.5);
    y += 10;

    // Helper: truncate string to fit within maxWidth (in mm)
    function truncate(text, maxW, fontSize) {
      doc.setFontSize(fontSize);
      if (doc.getTextWidth(text) <= maxW) return text;
      while (doc.getTextWidth(text + '…') > maxW && text.length > 0) text = text.slice(0, -1);
      return text + '…';
    }

    allTracks.forEach((track, i) => {
      const rowH = 11;
      checkPage(rowH + 2);

      if (i % 2 === 0) {
        doc.setFillColor(248, 250, 252);
        doc.rect(marginL, y - 1, contentW, rowH, 'F');
      }

      // #
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(140, 140, 160);
      doc.text(String(i + 1), colNum, y + 6);

      // Song name
      doc.setTextColor(20, 20, 40);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text(truncate(track.name, 62, 8), colSong, y + 5);

      // Album
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(160, 160, 180);
      doc.text(truncate(track.album, 62, 6.5), colSong, y + 9);

      // Artists
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(60, 60, 100);
      doc.text(truncate(track.artists, 50, 7.5), colArtist, y + 6);

      // ISRC — monospace-style, teal colour
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(0, 150, 136);
      doc.text(track.isrc !== '—' ? track.isrc : '—', colISRC, y + 6);

      // Link
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(29, 185, 84);
      const trackId = track.url.replace('https://open.spotify.com/track/', '').slice(0, 12);
      doc.textWithLink(trackId + '…', colLink, y + 6, { url: track.url });

      doc.setDrawColor(225, 228, 240);
      doc.setLineWidth(0.2);
      doc.line(marginL, y + rowH - 1, marginL + contentW, y + rowH - 1);

      y += rowH;
    });

    // Footer
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(180, 180, 200);
    y += 6;
    checkPage(12);
    doc.text(
      `Total: ${allTracks.length} tracks  ·  Exported ${new Date().toLocaleDateString()}  ·  Includes ISRC codes`,
      marginL, y
    );

    const safeName = (playlistData?.name || 'playlist').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    doc.save(`${safeName}_tracklist.pdf`);
    showToast('✓ PDF exported successfully!');

  } catch (err) {
    console.error(err);
    showToast('PDF export failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" style="width:16px;height:16px"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z" fill="currentColor"/></svg> Export PDF`;
  }
}

// ─── Enter key shortcut ───────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const active = document.activeElement;
    if (['clientId','clientSecret','playlistUrl'].includes(active?.id)) {
      fetchPlaylist();
    }
  }
});
