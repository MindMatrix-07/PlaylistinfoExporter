const fetch = require('isomorphic-unfetch');

// Dynamic require for spotify-url-info to avoid initialization errors
let spotifyUrlInfo;
try {
  spotifyUrlInfo = require('spotify-url-info')(fetch);
} catch (e) {
  console.error('Failed to load spotify-url-info:', e);
}

// Soundplate's PHP proxy — returns ISRC + album art per Spotify track URL
// NOTE: Soundplate returns 404 for clean URLs but 200 when the ?si= parameter is present.
// Always pass the original URL (with ?si= intact) to this API.
const SOUNDPLATE_API = 'https://phpstack-822472-6184058.cloudwaysapps.com/api/spotify.php';
const SOUNDPLATE_HEADERS = {
  'accept': '*/*',
  'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7,ml;q=0.6',
  'dnt': '1',
  'priority': 'u=1, i',
  'referer': 'https://phpstack-822472-6184058.cloudwaysapps.com/?',
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-storage-access': 'active',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
};

// credits.fm public search API — accepts Spotify URLs directly, returns ISRC
// Endpoint discovered via HAR analysis of isrc.fm (powered by credits.fm).
// No auth required. Full URL including ?si= parameter works fine.
const CREDITS_FM_SEARCH = 'https://api.credits.fm/v1/search';
const CREDITS_FM_HEADERS = { 'User-Agent': 'PlaylistInfoExporter/3.0' };

const EMPTY_DETAILS = {
  isrc: '—',
  albumName: 'Unknown Album'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch with a hard timeout — aborts and throws if ms exceeded
async function fetchWithTimeout(url, opts = {}, ms = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function spotifyInfoHandler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { url, debug, details } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing Spotify URL parameter.' });
  }

  const spotifyItem = extractSpotifyItem(url);
  if (!spotifyItem) {
    return res.status(400).json({ error: 'Paste a Spotify playlist, album, or track URL.' });
  }

  try {
    if (!spotifyUrlInfo) {
      throw new Error('spotify-url-info is not installed or failed to load.');
    }

    // Step 1: Scrape Spotify info and track list (names, uris)
    console.log(`Scraping ${spotifyItem.type} via spotify-url-info...`);
    const playlistData = await spotifyUrlInfo.getData(url);
    const rawTracks = getTracksFromPlaylistData(playlistData);
    const playlistImage = getBestImage(playlistData);

    const shouldFetchDetails = details !== '0' && details !== 'false';
    const trackDetails = [];

    if (shouldFetchDetails) {
      // Step 2: For each track, call Soundplate using the same request shape as its iframe widget.
      console.log(`Fetching ISRC + album art for ${rawTracks.length} tracks via soundplate (sequential)...`);

      const TRACK_DELAY_MS = 2200;

      for (let i = 0; i < rawTracks.length; i++) {
        const details = await fetchSoundplateDetails(rawTracks[i], rawTracks[i].albumArt || playlistImage);
        trackDetails.push(details);

        if (i + 1 < rawTracks.length) {
          await sleep(TRACK_DELAY_MS);
        }
      }
    }

    // Step 3: Build final track list
    const items = rawTracks.map((t, i) => {
      const fallbackTrackUrl = getSpotifyTrackUrl(t, extractSpotifyTrackId(t));
      const fallbackAlbumArt = t.albumArt || playlistImage;
      const { isrc, albumArt, albumName, trackUrl, lookupStatus } = trackDetails[i] || {
        isrc: '—',
        albumArt: fallbackAlbumArt,
        albumName: 'Unknown Album',
        trackUrl: fallbackTrackUrl,
        lookupStatus: 'pending'
      };
      const artistNames = normalizeArtists(t);
      const addedBy = normalizeAddedByObj(t.addedBy || t.added_by || t.added_at_user || (t.addedByUserId ? { id: t.addedByUserId, display_name: t.addedByName } : null));

      return {
        added_by: addedBy,
        track: {
          name: t.name || 'Unknown',
          artists: artistNames.map(name => ({ name })),
          album: { name: albumName || 'Unknown Album' },
          external_urls: { spotify: trackUrl },
          external_ids: { isrc },
          preview_url: t.preview_url || t.previewUrl || '',
          addedBy,
          albumArt,
          lookupStatus
        }
      };
    });

    const responseBody = {
      source: 'soundplate_api',
      name: playlistData.name || playlistData.title || titleForType(spotifyItem.type),
      owner: {
        display_name: ownerForSpotifyData(playlistData)
      },
      images: [{ url: playlistImage }],
      tracks: {
        total: items.length,
        items
      }
    };

    if (debug === '1' || debug === 'true') {
      responseBody.diagnostics = items.map((item, index) => ({
        index: index + 1,
        name: item.track.name,
        artists: item.track.artists.map(artist => artist.name).join(', '),
        isrc: item.track.external_ids.isrc,
        trackUrl: item.track.external_urls.spotify,
        lookupStatus: item.track.lookupStatus,
        rawUri: rawTracks[index]?.uri || '',
        rawKeys: Object.keys(rawTracks[index] || {})
      }));
    }

    return res.status(200).json(responseBody);

  } catch (err) {
    console.error('Error fetching Spotify data:', err);
    return res.status(500).json({ error: err.message || 'Server error fetching Spotify link.' });
  }
}

module.exports = spotifyInfoHandler;

function normalizeArtists(track) {
  const candidates = [
    track.artists,
    track.artist,
    track.subtitle,
    track.author,
    track.byLine
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const names = candidate
        .map(item => typeof item === 'string' ? item : item?.name)
        .filter(Boolean);
      if (names.length) return names;
    }

    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
        .split(/\s*,\s*|\s+&\s+|\s+feat\.?\s+/i)
        .map(name => name.trim())
        .filter(Boolean);
    }
  }

  return ['Unknown Artist'];
}

function extractSpotifyItem(input) {
  const value = String(input || '').trim();
  const uri = value.match(/spotify:(playlist|album|track):([A-Za-z0-9]+)/i);
  if (uri) return { type: uri[1].toLowerCase(), id: uri[2] };

  const url = value.match(/open\.spotify\.com\/(playlist|album|track)\/([A-Za-z0-9]+)/i);
  if (url) return { type: url[1].toLowerCase(), id: url[2] };

  return null;
}

function titleForType(type) {
  if (type === 'album') return 'Album';
  if (type === 'track') return 'Song';
  return 'Playlist';
}

function ownerForSpotifyData(data) {
  if (Array.isArray(data.artists) && data.artists.length) {
    return data.artists.map(artist => artist.name || artist).filter(Boolean).join(', ');
  }
  return data.subtitle || data.owner?.name || data.owner?.display_name || 'Unknown';
}

function getBestImage(data) {
  const candidates = [
    data.coverArt?.sources?.[0]?.url,
    data.visualIdentity?.image?.[0]?.url,
    data.visualIdentity?.image?.[2]?.url,
    data.images?.[0]?.url,
    data.image,
    data.thumbnail
  ];

  return candidates.find(Boolean) || '';
}

async function fetchSoundplateDetails(track, playlistImage, options = {}) {
  const trackId = extractSpotifyTrackId(track);
  // Preserve the original URL (with ?si= if present) — Soundplate needs it
  const originalUrl = track.url || track.href || track.shareUrl || track.link ||
    track.external_url || track.externalUrl ||
    track.external_urls?.spotify || track.externalUrls?.spotify || '';
  const trackUrl = getSpotifyTrackUrl(track, trackId);

  if (!trackUrl && !originalUrl) {
    return {
      ...EMPTY_DETAILS,
      albumArt: playlistImage,
      trackUrl: '',
      lookupStatus: 'missing_spotify_track_url'
    };
  }

  // The URL we pass to external services — prefer the original (which may have ?si=)
  // but fall back to the clean trackUrl
  const lookupUrl = originalUrl.includes('open.spotify.com/track/') ? originalUrl : trackUrl;

  // ── Step 1: credits.fm — primary source (discovered via HAR of isrc.fm) ──
  // Accepts the full Spotify URL including ?si= parameter. No auth required.
  console.log(`[credits.fm] Looking up ISRC for ${trackId || lookupUrl}`);
  const creditsFmResult = await fetchCreditsFmISRC(lookupUrl);
  if (creditsFmResult?.isrc) {
    // If credits.fm didn't return cover art, enrich via Spotify oEmbed (always works, no auth)
    const albumArt = creditsFmResult.albumArt ||
      await fetchSpotifyOembedAlbumArt(trackId) ||
      playlistImage;
    return {
      isrc: creditsFmResult.isrc,
      albumArt,
      albumName: creditsFmResult.albumName || 'Unknown Album',
      trackUrl: trackUrl || lookupUrl,
      lookupStatus: 'credits_fm_ok'
    };
  }

  // ── Step 2: Soundplate — MUST use URL with ?si= parameter ────────────────
  // HAR analysis confirmed: clean URL (no ?si=) returns 404; with ?si= returns 200.
  console.log(`[Fallback] credits.fm miss — trying Soundplate for ${trackId || lookupUrl}`);
  try {
    const resp = await fetchWithTimeout(
      `${SOUNDPLATE_API}?q=${encodeURIComponent(lookupUrl)}`,
      { headers: SOUNDPLATE_HEADERS },
      5000
    );
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.isrc) {
        const albumArt = data.artwork_url ||
          await fetchSpotifyOembedAlbumArt(trackId) ||
          playlistImage;
        return {
          isrc: data.isrc,
          albumArt,
          albumName: data.album || 'Unknown Album',
          trackUrl: trackUrl || lookupUrl,
          lookupStatus: 'soundplate_ok'
        };
      }
    }
  } catch (e) {
    console.warn(`[Soundplate] ${e.name === 'AbortError' ? 'Timed out' : e.message} — ${trackId || lookupUrl}`);
  }

  // Last resort: still fetch album art via oEmbed even if ISRC lookup failed
  const fallbackArt = await fetchSpotifyOembedAlbumArt(trackId) || playlistImage;
  return {
    ...EMPTY_DETAILS,
    albumArt: fallbackArt,
    trackUrl: trackUrl || lookupUrl,
    lookupStatus: 'no_isrc'
  };
}

// Spotify oEmbed API — free, public, no auth needed.
// Returns album art (thumbnail_url) for any Spotify track URL.
// Works 100% of the time regardless of whether the track is in credits.fm.
async function fetchSpotifyOembedAlbumArt(trackId) {
  if (!trackId) return null;
  try {
    const oembedUrl = `https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F${trackId}`;
    const res = await fetchWithTimeout(oembedUrl, {}, 4000);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.thumbnail_url || null;
  } catch (e) {
    console.warn('[oEmbed] Album art fetch failed:', e.message);
    return null;
  }
}

// Discovered via HAR analysis of isrc.fm. No auth needed.
// Pass the full Spotify URL including ?si= — it handles it correctly.
//
// NOTE on timeouts: Netlify functions have a hard 10-second execution limit.
// We set this to 8000ms to allow it to fail gracefully instead of crashing the function.
// The frontend will handle any failures via a direct client-side fallback fetch.
//
// Returns { isrc, albumArt, albumName } or null
async function fetchCreditsFmISRC(spotifyTrackUrl) {
  const TIMEOUT_MS = 8000;
  const apiUrl = `${CREDITS_FM_SEARCH}?q=${encodeURIComponent(spotifyTrackUrl)}&type=isrc&limit=1&offset=0`;

  try {
    const res = await fetchWithTimeout(apiUrl, { headers: CREDITS_FM_HEADERS }, TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`[credits.fm] HTTP ${res.status}`);
      return null; 
    }
    const data = await res.json().catch(() => null);
    const recording = data?.recordings?.items?.[0];
    if (!recording?.isrc) return null;
    return {
      isrc: recording.isrc,
      albumArt: recording.cover_art_url || '',
      albumName: 'Unknown Album' // credits.fm search doesn't return album name
    };
  } catch (e) {
    const isTimeout = e.name === 'AbortError' || e.message === 'TIMEOUT';
    console.warn(`[credits.fm] ${isTimeout ? 'timed out' : 'failed: ' + e.message}`);
    return null;
  }
}

function getTracksFromPlaylistData(playlistData) {
  if (Array.isArray(playlistData.trackList)) {
    return playlistData.trackList.map(track => ({
      artist: track.subtitle,
      duration: track.duration,
      name: track.title,
      previewUrl: track.isPlayable ? track.audioPreview?.url : '',
      uri: track.uri,
      albumArt: getBestImage(track)
    }));
  }

  return [{
    artists: playlistData.artists,
    artist: playlistData.subtitle,
    duration: playlistData.duration,
    name: playlistData.title || playlistData.name,
    previewUrl: playlistData.isPlayable ? playlistData.audioPreview?.url : '',
    uri: playlistData.uri,
    albumArt: getBestImage(playlistData)
  }];
}

function extractSpotifyTrackId(track) {
  const candidates = [
    track.id,
    track.uri,
    track.url,
    track.href,
    track.shareUrl,
    track.link,
    track.external_url,
    track.externalUrl,
    track.external_urls?.spotify,
    track.externalUrls?.spotify,
    track.track?.id,
    track.track?.uri,
    track.track?.external_urls?.spotify
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    const value = candidate.trim();

    const uriMatch = value.match(/spotify:track:([A-Za-z0-9]{22})/);
    if (uriMatch) return uriMatch[1];

    const urlMatch = value.match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/);
    if (urlMatch) return urlMatch[1];

    if (/^[A-Za-z0-9]{22}$/.test(value)) return value;
  }

  return '';
}

function getSpotifyTrackUrl(track, trackId) {
  const candidates = [
    track.url,
    track.href,
    track.shareUrl,
    track.link,
    track.external_url,
    track.externalUrl,
    track.external_urls?.spotify,
    track.externalUrls?.spotify,
    track.track?.external_urls?.spotify
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.includes('open.spotify.com/track/')) {
      return candidate.split('?')[0];
    }
  }

  return trackId ? `https://open.spotify.com/track/${trackId}` : '';
}

function normalizeAddedByObj(addedBy) {
  if (!addedBy) return null;
  if (typeof addedBy === 'string') {
    return { id: addedBy, display_name: addedBy, name: addedBy };
  }
  const id = addedBy.id || addedBy.name || '';
  if (!id && !addedBy.display_name && !addedBy.name) return null;
  return {
    id: id,
    display_name: addedBy.display_name || addedBy.name || id,
    name: addedBy.name || addedBy.display_name || id,
    external_urls: addedBy.external_urls || { spotify: addedBy.url || (id ? `https://open.spotify.com/user/${id}` : '') }
  };
}

module.exports.helpers = {
  fetchSoundplateDetails,
  getTracksFromPlaylistData,
  normalizeArtists,
  extractSpotifyItem,
  getBestImage,
  getSpotifyTrackUrl,
  extractSpotifyTrackId
};
