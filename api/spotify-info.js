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
    if (!spotifyUrlInfo) {
      throw new Error('spotify-url-info is not installed or failed to load.');
    }

    // Step 1: Scrape playlist info and tracks
    console.log('Scraping playlist via spotify-url-info...');
    const playlistData = await spotifyUrlInfo.getData(url);
    const rawTracks = await spotifyUrlInfo.getTracks(url);
    const playlistImage = playlistData.coverArt?.sources?.[0]?.url || '';

    // Step 2: Fetch ISRCs + per-track album art in parallel (no credentials needed)
    console.log(`Fetching ISRC + album art for ${rawTracks.length} tracks in parallel...`);

    const trackResults = await Promise.all(
      rawTracks.map(async (t) => {
        const trackId = t.uri ? t.uri.split(':').pop() : '';
        const trackUrl = trackId ? `https://open.spotify.com/track/${trackId}` : '';
        const trackName = t.name || '';
        const artistName = t.artist || '';

        // Fetch ISRC and album art concurrently for this track
        const [isrc, albumArt] = await Promise.all([
          // ISRC from boost-collective (no auth)
          trackName
            ? fetchIsrcFromBoostCollective(trackName, artistName).catch(() => '—')
            : Promise.resolve('—'),

          // Album art from Spotify page scrape (no auth)
          trackUrl
            ? fetchAlbumArtFromSpotify(trackUrl).catch(() => playlistImage)
            : Promise.resolve(playlistImage)
        ]);

        return { trackId, trackUrl, isrc, albumArt };
      })
    );

    // Step 3: Build final track list
    const items = rawTracks.map((t, i) => {
      const { trackUrl, isrc, albumArt } = trackResults[i];
      return {
        track: {
          name: t.name || 'Unknown',
          artists: [{ name: t.artist || 'Unknown Artist' }],
          album: { name: 'Unknown Album' },
          external_urls: { spotify: trackUrl || '' },
          external_ids: { isrc: isrc || '—' },
          albumArt: albumArt || playlistImage
        }
      };
    });

    return res.status(200).json({
      source: 'scraped_with_isrc_lookup',
      name: playlistData.name || playlistData.title || 'Playlist',
      owner: {
        display_name: playlistData.subtitle || 'Unknown'
      },
      images: [{ url: playlistImage }],
      tracks: {
        total: items.length,
        items: items
      }
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

// Fetch ISRC from boost-collective (no auth required)
async function fetchIsrcFromBoostCollective(trackName, artistName) {
  const resp = await fetch('https://www.boost-collective.com/api/artist-tools/isrc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'referer': 'https://www.boost-collective.com/blog/isrc-finder-tool-free',
      'origin': 'https://www.boost-collective.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({ trackName, artistName })
  });
  if (!resp.ok) return '—';
  const data = await resp.json();
  return data.isrc || '—';
}

// Scrape per-track album art from Spotify page via spotify-url-info
async function fetchAlbumArtFromSpotify(trackUrl) {
  const data = await spotifyUrlInfo.getData(trackUrl);
  // visualIdentity.image contains artwork at 640, 300, 64 — pick largest (last item)
  const images = data?.visualIdentity?.image || data?.coverArt?.sources || [];
  if (!images.length) return '';
  // Sort descending by maxWidth/width, pick the largest
  const sorted = [...images].sort((a, b) => (b.maxWidth || b.width || 0) - (a.maxWidth || a.width || 0));
  return sorted[0]?.url || '';
}
