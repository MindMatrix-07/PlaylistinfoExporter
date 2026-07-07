const fetch = require('isomorphic-unfetch');

// Dynamic require for spotify-url-info to avoid initialization errors
let spotifyUrlInfo;
try {
  spotifyUrlInfo = require('spotify-url-info')(fetch);
} catch (e) {
  console.error('Failed to load spotify-url-info:', e);
}

// Soundplate's PHP proxy — returns ISRC + album art per Spotify track URL
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

const EMPTY_DETAILS = {
  isrc: '—',
  albumName: 'Unknown Album'
};

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

      return {
        track: {
          name: t.name || 'Unknown',
          artists: artistNames.map(name => ({ name })),
          album: { name: albumName || 'Unknown Album' },
          external_urls: { spotify: trackUrl },
          external_ids: { isrc },
          preview_url: t.preview_url || t.previewUrl || '',
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

// Helper: pause execution for given milliseconds
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  const trackUrl = getSpotifyTrackUrl(track, trackId);
  const maxAttempts = options.maxAttempts || 4;
  const rateLimitSleepMs = options.rateLimitSleepMs ?? 70000;

  if (!trackUrl) {
    return {
      ...EMPTY_DETAILS,
      albumArt: playlistImage,
      trackUrl: '',
      lookupStatus: 'missing_spotify_track_url'
    };
  }

  // ── Step 1: Odesli → Deezer (primary — no rate limits) ──────────────────
  const deezerIsrc = await fetchOdesliDeezerISRC(trackUrl);
  if (deezerIsrc) {
    return {
      isrc: deezerIsrc,
      albumArt: playlistImage,
      albumName: 'Unknown Album',
      trackUrl,
      lookupStatus: 'deezer_ok'
    };
  }

  // ── Step 2: Soundplate fallback (for tracks not on Deezer) ───────────────
  console.log(`[Fallback] Deezer miss — trying Soundplate for ${trackId || trackUrl}`);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) await sleep(4000 * attempt);

      const resp = await fetch(
        `${SOUNDPLATE_API}?q=${encodeURIComponent(trackUrl)}`,
        { headers: SOUNDPLATE_HEADERS }
      );
      const data = await resp.json().catch(() => ({}));

      if (resp.status === 429) {
        if (attempt < maxAttempts - 1) {
          await sleep(rateLimitSleepMs);
          continue;
        }
        throw new Error(data.error || 'Soundplate rate limit exceeded');
      }

      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      if (data.error) throw new Error(data.error);

      if (data.isrc) {
        return {
          isrc: data.isrc,
          albumArt: data.artwork_url || playlistImage,
          albumName: data.album || 'Unknown Album',
          trackUrl,
          lookupStatus: 'soundplate_ok'
        };
      }

      throw new Error('Soundplate returned no ISRC');
    } catch (e) {
      if (attempt === maxAttempts - 1) {
        console.warn(`[Soundplate] Failed for ${trackId || trackUrl} after ${maxAttempts} attempts:`, e.message);
      }
    }
  }

  return {
    ...EMPTY_DETAILS,
    albumArt: playlistImage,
    trackUrl,
    lookupStatus: 'no_isrc'
  };
}

// Odesli → Deezer: resolves Spotify URL to Deezer ID via Odesli,
// then fetches ISRC from Deezer's public track API (no auth required).
async function fetchOdesliDeezerISRC(spotifyTrackUrl) {
  try {
    // Step 1: Odesli lookup to get Deezer track ID
    const odesliRes = await fetch(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyTrackUrl)}`,
      { headers: { 'User-Agent': 'PlaylistInfoExporter/2.0' } }
    );
    if (!odesliRes.ok) return null;
    const odesliData = await odesliRes.json().catch(() => null);
    if (!odesliData) return null;

    const entities = odesliData.entitiesByUniqueId || {};
    const deezerEntry = Object.entries(entities).find(([key]) => key.startsWith('DEEZER_SONG::'));
    if (!deezerEntry) return null;
    const deezerId = deezerEntry[1].id;

    // Step 2: Deezer public track API to get ISRC
    const deezerRes = await fetch(`https://api.deezer.com/track/${deezerId}`);
    if (!deezerRes.ok) return null;
    const deezerData = await deezerRes.json().catch(() => null);
    return deezerData?.isrc || null;
  } catch (e) {
    console.warn('[Deezer] Odesli→Deezer failed:', e.message);
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

module.exports.helpers = {
  fetchSoundplateDetails,
  getTracksFromPlaylistData,
  normalizeArtists,
  extractSpotifyItem,
  getBestImage,
  getSpotifyTrackUrl,
  extractSpotifyTrackId
};
