// Cloudflare Pages Function — pure ESM, uses native fetch (available globally in Workers + Node 18+)

let cachedClientToken = null;
let clientTokenExpiresAt = 0;
let cachedAnonToken = null;
let anonTokenExpiresAt = 0;

async function getSpotifyClientToken(clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;
  if (cachedClientToken && Date.now() < clientTokenExpiresAt - 60000) return cachedClientToken;
  try {
    const auth = btoa(`${clientId}:${clientSecret}`);
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (r.ok) {
      const d = await r.json();
      cachedClientToken = d.access_token;
      clientTokenExpiresAt = Date.now() + (d.expires_in || 3600) * 1000;
      return cachedClientToken;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function getSpotifyAnonToken(sampleTrackId) {
  if (cachedAnonToken && Date.now() < anonTokenExpiresAt - 60000) return cachedAnonToken;
  const ids = [sampleTrackId, '4cOdK2wGLETKBW3PvgPWqT'].filter(Boolean);
  for (const trackId of ids) {
    try {
      const r = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!r.ok) continue;
      const html = await r.text();
      const tag = '<script id="__NEXT_DATA__" type="application/json">';
      const s = html.indexOf(tag);
      if (s === -1) continue;
      const data = JSON.parse(html.substring(s + tag.length, html.indexOf('</script>', s + tag.length)));
      const token = data?.props?.pageProps?.state?.settings?.session?.accessToken;
      if (token) { cachedAnonToken = token; anonTokenExpiresAt = Date.now() + 15 * 60 * 1000; return token; }
    } catch (e) { /* ignore */ }
  }
  return null;
}

async function resolveTrackFreeFallback(trackId) {
  // Primary: unchainedmusic.io — fast, no auth, no rate limit
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
  } catch (e) { /* ignore */ }

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
  } catch (e) { /* ignore */ }

  return null;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: cors() });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...cors(), 'content-type': 'application/json' }
    });
  }

  const clientId = env?.SPOTIFY_CLIENT_ID || '';
  const clientSecret = env?.SPOTIFY_CLIENT_SECRET || '';

  try {
    const body = await request.json().catch(() => ({}));
    const trackIds = body.trackIds || [];

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, isrcMap: {} }), {
        status: 200, headers: { ...cors(), 'content-type': 'application/json' }
      });
    }

    let token = body.accessToken
      || await getSpotifyClientToken(clientId, clientSecret)
      || await getSpotifyAnonToken(trackIds[0]);

    const isrcMap = {};
    const unhandled = [];

    for (let i = 0; i < trackIds.length; i += 50) {
      const batch = trackIds.slice(i, i + 50);
      let ok = false;
      if (token) {
        try {
          let r = await fetch(`https://api.spotify.com/v1/tracks?ids=${batch.join(',')}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (r.status === 401 || r.status === 429) {
            cachedAnonToken = null;
            token = await getSpotifyClientToken(clientId, clientSecret) || await getSpotifyAnonToken(trackIds[0]);
            if (token) r = await fetch(`https://api.spotify.com/v1/tracks?ids=${batch.join(',')}`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
          }
          if (r.ok) {
            const d = await r.json();
            (d.tracks || []).forEach(t => {
              if (!t) return;
              isrcMap[t.id] = {
                isrc: t.external_ids?.isrc || '—',
                albumName: t.album?.name || '',
                albumArt: t.album?.images?.[0]?.url || ''
              };
            });
            ok = true;
          }
        } catch (e) { /* fallback */ }
      }
      if (!ok) unhandled.push(...batch);
    }

    for (const id of unhandled) {
      const info = await resolveTrackFreeFallback(id);
      if (info) isrcMap[id] = info;
      await new Promise(r => setTimeout(r, 50));
    }

    return new Response(JSON.stringify({ ok: true, resolvedCount: Object.keys(isrcMap).length, totalRequested: trackIds.length, isrcMap }), {
      status: 200, headers: { ...cors(), 'content-type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, isrcMap: {} }), {
      status: 500, headers: { ...cors(), 'content-type': 'application/json' }
    });
  }
}
