const fetch = require('isomorphic-unfetch');

// Dynamic require for spotify-url-info to avoid initialization errors
let spotifyUrlInfo;
try {
  spotifyUrlInfo = require('spotify-url-info')(fetch);
} catch (e) {
  console.error('Failed to load spotify-url-info:', e);
}

module.exports = async (req, res) => {
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

  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing Spotify URL parameter.' });
  }

  try {
    const playlistId = extractPlaylistId(url);
    if (!playlistId) {
      return res.status(400).json({ error: 'Invalid playlist URL format.' });
    }

    if (!spotifyUrlInfo) {
      throw new Error('spotify-url-info is not installed or failed to load.');
    }

    // Step 1: Scrape first (spotify-url-info)
    console.log('Scraping playlist info via spotify-url-info...');
    const playlistData = await spotifyUrlInfo.getData(url);
    const rawTracks = await spotifyUrlInfo.getTracks(url);
    const playlistImage = playlistData.coverArt?.sources?.[0]?.url || '';

    // Step 2: Extract track IDs
    const trackIds = rawTracks
      .map(t => t.uri ? t.uri.split(':').pop() : '')
      .filter(id => id && /^[a-zA-Z0-9]{22}$/.test(id));

    // Step 3: Fetch credentials if configured
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    let detailsMap = {};

    let usedCredentials = false;
    let debugInfo = {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      error: null
    };

    if (clientId && clientSecret && trackIds.length > 0) {
      console.log('Developer credentials found. Fetching ISRCs in chunks...');
      try {
        const token = await getClientCredentialsToken(clientId, clientSecret);
        detailsMap = await fetchIsrcsAndAlbumArt(token, trackIds);
        usedCredentials = true;
      } catch (credError) {
        console.error('Spotify API Credentials flow failed:', credError.message);
        debugInfo.error = credError.message;
      }
    }

    // Step 4: Map back to tracks
    const items = rawTracks.map(t => {
      const trackId = t.uri ? t.uri.split(':').pop() : '';
      const details = detailsMap[trackId] || {};
      
      return {
        track: {
          name: t.name || 'Unknown',
          artists: [{ name: t.artist || 'Unknown Artist' }],
          album: { name: 'Unknown Album' },
          external_urls: { spotify: trackId ? `https://open.spotify.com/track/${trackId}` : '' },
          external_ids: { isrc: details.isrc || '—' },
          albumArt: details.albumArt || playlistImage // Fallback to playlist image if no API art is retrieved
        }
      };
    });

    return res.status(200).json({
      source: Object.keys(detailsMap).length > 0 ? 'scraped_with_api_isrc' : 'scraped_only',
      name: playlistData.name || playlistData.title || 'Playlist',
      owner: {
        display_name: playlistData.subtitle || 'Unknown'
      },
      images: [{ url: playlistImage }],
      tracks: {
        total: items.length,
        items: items
      },
      debug: debugInfo
    });

  } catch (err) {
    console.error('Error fetching playlist data:', err);
    return res.status(500).json({ error: err.message || 'Server error fetching playlist.' });
  }
};

function extractPlaylistId(urlStr) {
  try {
    const match = urlStr.match(/\/playlist\/([a-zA-Z0-9]{22})/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

async function getClientCredentialsToken(clientId, clientSecret) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!resp.ok) {
    throw new Error('Failed to retrieve Spotify access token.');
  }
  const data = await resp.json();
  return data.access_token;
}

async function fetchIsrcsAndAlbumArt(token, trackIds) {
  const chunks = [];
  for (let i = 0; i < trackIds.length; i += 50) {
    chunks.push(trackIds.slice(i, i + 50));
  }

  const results = {};
  for (const chunk of chunks) {
    const resp = await fetch(`https://api.spotify.com/v1/tracks?ids=${chunk.join(',')}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Spotify API tracks lookup failed (HTTP ${resp.status}): ${errText}`);
    }
    const data = await resp.json();
    (data.tracks || []).forEach(t => {
      if (t && t.id) {
        results[t.id] = {
          isrc: t.external_ids?.isrc || '—',
          albumArt: t.album?.images?.[t.album.images.length - 1]?.url || t.album?.images?.[0]?.url || ''
        };
      }
    });
  }
  return results;
}
