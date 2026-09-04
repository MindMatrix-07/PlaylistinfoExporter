// Native fetch is available globally in Node 18+ and Cloudflare Workers

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

let cachedClientToken = null;
let clientTokenExpiresAt = 0;
let cachedAnonToken = null;
let anonTokenExpiresAt = 0;

async function getSpotifyClientToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID || SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (cachedClientToken && Date.now() < clientTokenExpiresAt - 60000) {
    return cachedClientToken;
  }
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    if (r.ok) {
      const d = await r.json();
      cachedClientToken = d.access_token;
      clientTokenExpiresAt = Date.now() + (d.expires_in || 3600) * 1000;
      return cachedClientToken;
    }
  } catch (e) {
    console.error('[Batch ISRC] Client credentials error:', e.message);
  }
  return null;
}

async function getSpotifyAnonToken(sampleTrackId) {
  if (cachedAnonToken && Date.now() < anonTokenExpiresAt - 60000) {
    return cachedAnonToken;
  }

  const idsToTry = [sampleTrackId, '4cOdK2wGLETKBW3PvgPWqT', '4r4oQiB8CEOqeGugFAC0qJ'].filter(Boolean);

  for (const trackId of idsToTry) {
    try {
      const r = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      });
      if (!r.ok) continue;
      const html = await r.text();
      const startTag = '<script id="__NEXT_DATA__" type="application/json">';
      const s = html.indexOf(startTag);
      if (s === -1) continue;
      const jsonStart = s + startTag.length;
      const jsonEnd = html.indexOf('</script>', jsonStart);
      const data = JSON.parse(html.substring(jsonStart, jsonEnd));
      const token = data?.props?.pageProps?.state?.settings?.session?.accessToken || null;
      
      if (token) {
        cachedAnonToken = token;
        anonTokenExpiresAt = Date.now() + 15 * 60 * 1000;
        return token;
      }
    } catch (e) {
      console.warn(`[Batch ISRC] Anon token fetch failed for ${trackId}:`, e.message);
    }
  }

  return null;
}

async function resolveTrackFreeFallback(trackId) {
  // Primary: unchainedmusic.io — fast, no auth, no rate limit, real ISRCs
  try {
    const r = await fetch(`https://www.unchainedmusic.io/api/lookup?track=${trackId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.unchainedmusic.io/tools/isrc-checker/'
      }
    });
    if (r.ok) {
      const d = await r.json();
      if (d.found && d.isrc) {
        return { isrc: d.isrc, albumName: d.album || '', albumArt: d.artwork || '' };
      }
    }
  } catch (e) {
    console.warn('[Batch ISRC] unchainedmusic fallback failed:', e.message);
  }

  // Secondary: wallstream.com — also no auth, returns full Spotify track object
  try {
    const r = await fetch(`https://tools.wallstream.com/api/spotify/isrc?url=https://open.spotify.com/track/${trackId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://tools.wallstream.com/isrc-lookup'
      }
    });
    if (r.ok) {
      const d = await r.json();
      const track = d?.item || d;
      const isrc = track?.external_ids?.isrc;
      if (isrc) {
        return {
          isrc,
          albumName: track?.album?.name || '',
          albumArt: track?.album?.images?.[0]?.url || ''
        };
      }
    }
  } catch (e) {
    console.warn('[Batch ISRC] wallstream fallback failed:', e.message);
  }

  return null;
}

module.exports = async function spotifyBatchIsrcHandler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const trackIds = body.trackIds || [];

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(200).json({ ok: true, isrcMap: {} });
    }

    let token = body.accessToken || await getSpotifyClientToken() || await getSpotifyAnonToken(trackIds[0]);
    const isrcMap = {};
    const BATCH_SIZE = 50;
    const unhandledTrackIds = [];

    for (let i = 0; i < trackIds.length; i += BATCH_SIZE) {
      const batch = trackIds.slice(i, i + BATCH_SIZE);
      const ids = batch.join(',');
      let batchSuccess = false;

      if (token) {
        try {
          let r = await fetch(`https://api.spotify.com/v1/tracks?ids=${ids}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (r.status === 401 || r.status === 429) {
            console.warn(`[Batch ISRC] Spotify API status ${r.status}. Attempting token refresh...`);
            cachedAnonToken = null;
            token = await getSpotifyClientToken() || await getSpotifyAnonToken(trackIds[0]);
            if (token) {
              r = await fetch(`https://api.spotify.com/v1/tracks?ids=${ids}`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
            }
          }

          if (r.ok) {
            const d = await r.json();
            (d.tracks || []).forEach(t => {
              if (!t) return;
              const id = t.id;
              const isrc = t.external_ids?.isrc;
              if (id) {
                isrcMap[id] = {
                  isrc: isrc || '—',
                  albumName: t.album?.name || '',
                  albumArt: t.album?.images?.[0]?.url || ''
                };
              }
            });
            batchSuccess = true;
          }
        } catch (err) {
          console.error('[Batch ISRC] Spotify API call failed:', err.message);
        }
      }

      if (!batchSuccess) {
        unhandledTrackIds.push(...batch);
      }
    }

    if (unhandledTrackIds.length > 0) {
      console.log(`[Fast Strict Engine] Resolving ${unhandledTrackIds.length} tracks...`);
      for (const id of unhandledTrackIds) {
        const info = await resolveTrackFreeFallback(id);
        if (info) {
          isrcMap[id] = info;
        }
        await new Promise(r => setTimeout(r, 50));
      }
    }

    return res.status(200).json({
      ok: true,
      resolvedCount: Object.keys(isrcMap).length,
      totalRequested: trackIds.length,
      isrcMap
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, isrcMap: {} });
  }
};
