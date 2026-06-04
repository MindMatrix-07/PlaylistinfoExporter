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
  'accept-language': 'en-US,en;q=0.9',
  'referer': 'https://phpstack-822472-6184058.cloudwaysapps.com/',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
};

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

    // Step 1: Scrape playlist info and track list (names, uris)
    console.log('Scraping playlist via spotify-url-info...');
    const [playlistData, rawTracks] = await Promise.all([
      spotifyUrlInfo.getData(url),
      spotifyUrlInfo.getTracks(url)
    ]);
    const playlistImage = playlistData.coverArt?.sources?.[0]?.url || '';

    // Step 2: For each track, call soundplate API in batches of 5 to avoid rate limiting
    console.log(`Fetching ISRC + album art for ${rawTracks.length} tracks via soundplate (batched)...`);

    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 150;
    const trackDetails = [];

    for (let i = 0; i < rawTracks.length; i += BATCH_SIZE) {
      const batch = rawTracks.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (t) => {
          const trackId = t.uri ? t.uri.split(':').pop() : '';
          const trackUrl = trackId ? `https://open.spotify.com/track/${trackId}` : '';

          if (!trackUrl) return { isrc: '—', albumArt: playlistImage, trackUrl: '' };

          // Try up to 2 times
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              if (attempt > 0) await sleep(500); // wait before retry
              const resp = await fetch(
                `${SOUNDPLATE_API}?q=${encodeURIComponent(trackUrl)}`,
                { headers: SOUNDPLATE_HEADERS }
              );
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const data = await resp.json();
              if (data.error) throw new Error(data.error);

              return {
                isrc: data.isrc || '—',
                albumArt: data.artwork_url || playlistImage,
                albumName: data.album || 'Unknown Album',
                trackUrl
              };
            } catch (e) {
              if (attempt === 1) {
                console.warn(`Failed for track ${trackId} after 2 attempts:`, e.message);
              }
            }
          }
          return { isrc: '—', albumArt: playlistImage, albumName: 'Unknown Album', trackUrl };
        })
      );

      trackDetails.push(...batchResults);

      // Delay between batches (skip after the last batch)
      if (i + BATCH_SIZE < rawTracks.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // Step 3: Build final track list
    const items = rawTracks.map((t, i) => {
      const { isrc, albumArt, albumName, trackUrl } = trackDetails[i];
      const artistNames = normalizeArtists(t);

      return {
        track: {
          name: t.name || 'Unknown',
          artists: artistNames.map(name => ({ name })),
          album: { name: albumName || 'Unknown Album' },
          external_urls: { spotify: trackUrl },
          external_ids: { isrc },
          preview_url: t.preview_url || t.previewUrl || '',
          albumArt
        }
      };
    });

    return res.status(200).json({
      source: 'soundplate_api',
      name: playlistData.name || playlistData.title || 'Playlist',
      owner: {
        display_name: playlistData.subtitle || 'Unknown'
      },
      images: [{ url: playlistImage }],
      tracks: {
        total: items.length,
        items
      }
    });

  } catch (err) {
    console.error('Error fetching playlist data:', err);
    return res.status(500).json({ error: err.message || 'Server error fetching playlist.' });
  }
};

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
