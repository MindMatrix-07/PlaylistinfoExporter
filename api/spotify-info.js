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

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (clientId && clientSecret) {
      console.log('Using official Spotify Client Credentials flow...');
      const token = await getClientCredentialsToken(clientId, clientSecret);
      const playlistMeta = await fetchPlaylistMeta(token, playlistId);
      const allTracks = await fetchAllTracks(token, playlistId);
      
      return res.status(200).json({
        source: 'api_credentials',
        name: playlistMeta.name,
        owner: {
          display_name: playlistMeta.owner?.display_name || 'Unknown'
        },
        images: playlistMeta.images || [],
        tracks: {
          total: allTracks.length,
          items: allTracks.map(t => ({
            track: {
              name: t.name,
              artists: t.artists,
              album: { name: t.album },
              external_urls: { spotify: t.url },
              external_ids: { isrc: t.isrc },
              albumArt: t.albumArt
            }
          }))
        }
      });
    } else {
      console.log('Falling back to spotify-url-info scraping...');
      if (!spotifyUrlInfo) {
        throw new Error('spotify-url-info is not installed or failed to load.');
      }

      const playlistData = await spotifyUrlInfo.getData(url);
      const rawTracks = await spotifyUrlInfo.getTracks(url);

      const playlistImage = playlistData.coverArt?.sources?.[0]?.url || '';

      const items = rawTracks.map(t => {
        // Extract track ID from URI (e.g. "spotify:track:ID")
        const trackId = t.uri ? t.uri.split(':').pop() : '';
        const trackUrl = trackId ? `https://open.spotify.com/track/${trackId}` : '';
        
        return {
          track: {
            name: t.name || 'Unknown',
            artists: [{ name: t.artist || 'Unknown Artist' }],
            album: { name: 'Unknown Album' },
            external_urls: { spotify: trackUrl },
            external_ids: { isrc: '—' },
            albumArt: playlistImage // Use playlist image as fallback cover art
          }
        };
      });

      return res.status(200).json({
        source: 'spotify_url_info',
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
    }
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

async function fetchPlaylistMeta(token, playlistId) {
  const resp = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name,owner.display_name,images`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!resp.ok) {
    throw new Error('Failed to fetch playlist metadata.');
  }
  return resp.json();
}

async function fetchAllTracks(token, playlistId) {
  let tracks = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const resp = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}&fields=next,items(track(name,id,artists(name),album(name,images),external_urls.spotify,external_ids.isrc))`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      throw new Error('Failed to fetch playlist tracks.');
    }
    const data = await resp.json();
    const items = (data.items || []).filter(i => i && i.track && i.track.id);
    
    tracks = tracks.concat(items.map(i => {
      const t = i.track;
      const isrc = t.external_ids?.isrc || '—';
      const albumArt = t.album?.images?.[t.album.images.length - 1]?.url || t.album?.images?.[0]?.url || '';
      return {
        name: t.name || 'Unknown',
        artists: (t.artists || []).map(a => ({ name: a.name })),
        album: t.album?.name || '',
        albumArt: albumArt,
        url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
        isrc: isrc
      };
    }));

    if (!data.next) break;
    offset += limit;
  }

  return tracks;
}
