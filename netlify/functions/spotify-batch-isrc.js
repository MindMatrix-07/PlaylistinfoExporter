const fetch = require('isomorphic-unfetch');

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

let cachedClientToken = null;
let clientTokenExpiresAt = 0;
let cachedAnonToken = null;
let anonTokenExpiresAt = 0;

async function getSpotifyClientToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  if (cachedClientToken && Date.now() < clientTokenExpiresAt - 60000) {
    return cachedClientToken;
  }
  try {
    const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
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
    console.error('[Batch ISRC] Client credentials token error:', e.message);
  }
  return null;
}

async function getSpotifyAnonToken(sampleTrackId) {
  if (cachedAnonToken && Date.now() < anonTokenExpiresAt - 60000) {
    return cachedAnonToken;
  }

  const idsToTry = [sampleTrackId, '4r4oQiB8CEOqeGugFAC0qJ', '4cOdK2wGLETKBW3PvgPWqT'].filter(Boolean);

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

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const trackIds = body.trackIds || [];

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, isrcMap: {} })
      };
    }

    // Prioritize: 1) Client-provided user token, 2) Official Client Credentials token, 3) Scraped Embed token
    let token = body.accessToken || await getSpotifyClientToken() || await getSpotifyAnonToken(trackIds[0]);

    if (!token) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Could not obtain Spotify token', isrcMap: {} })
      };
    }

    const isrcMap = {};
    const BATCH_SIZE = 50;

    for (let i = 0; i < trackIds.length; i += BATCH_SIZE) {
      const batch = trackIds.slice(i, i + BATCH_SIZE);
      const ids = batch.join(',');
      try {
        let r = await fetch(`https://api.spotify.com/v1/tracks?ids=${ids}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        // If 401 or 429, attempt to fallback to Client Credentials or Anon token refresh
        if (r.status === 401 || r.status === 429) {
          console.warn(`[Batch ISRC] Spotify API returned ${r.status}, attempting fallback token...`);
          cachedAnonToken = null;
          token = await getSpotifyClientToken() || await getSpotifyAnonToken(trackIds[0]);
          if (token) {
            r = await fetch(`https://api.spotify.com/v1/tracks?ids=${ids}`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
          }
        }

        if (!r.ok) {
          console.warn(`[Batch ISRC] Spotify API returned status ${r.status}`);
          continue;
        }

        const d = await r.json();
        (d.tracks || []).forEach(t => {
          if (!t) return;
          const id = t.id;
          const isrc = t.external_ids?.isrc;
          if (id && isrc) {
            isrcMap[id] = {
              isrc,
              albumName: t.album?.name || '',
              albumArt: t.album?.images?.[0]?.url || ''
            };
          }
        });
      } catch (err) {
        console.error('[Batch ISRC] Batch request failed:', err.message);
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ok: true,
        resolvedCount: Object.keys(isrcMap).length,
        totalRequested: trackIds.length,
        isrcMap
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: false, error: err.message, isrcMap: {} })
    };
  }
};
