const fetch = require('isomorphic-unfetch');

// Cache anonymous bearer token in warm Lambda instances (15 min TTL)
let cachedAnonToken = null;
let tokenExpiresAt = 0;

async function getSpotifyAnonToken(sampleTrackId) {
  if (cachedAnonToken && Date.now() < tokenExpiresAt - 60000) {
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
        tokenExpiresAt = Date.now() + 15 * 60 * 1000;
        return token;
      }
    } catch (e) {
      console.warn(`[Batch ISRC] Token fetch failed for ${trackId}:`, e.message);
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

    let token = await getSpotifyAnonToken(trackIds[0]);
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

        // If token expired (401), force refresh token once and retry batch
        if (r.status === 401) {
          console.warn('[Batch ISRC] Token 401 Unauthorized, refreshing token...');
          cachedAnonToken = null;
          tokenExpiresAt = 0;
          token = await getSpotifyAnonToken(trackIds[0]);
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
