// Cloudflare Pages Function — pure ESM, uses native fetch only

const SOUNDPLATE_API = 'https://phpstack-822472-6184058.cloudwaysapps.com/api/spotify.php';
const CREDITS_FM_SEARCH = 'https://api.credits.fm/v1/search';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(), 'content-type': 'application/json; charset=utf-8' }
  });
}

async function getClientToken(clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (r.ok) { const d = await r.json(); return d.access_token || null; }
  } catch (e) { /* ignore */ }
  return null;
}

async function fetchCreditsFm(spotifyUrl) {
  try {
    const signal = AbortSignal.timeout(7000);
    const r = await fetch(`${CREDITS_FM_SEARCH}?q=${encodeURIComponent(spotifyUrl)}&type=isrc&limit=1&offset=0`, {
      signal, headers: { 'User-Agent': 'PlaylistInfoExporter/3.0' }
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    const rec = d?.recordings?.items?.[0];
    if (!rec?.isrc) return null;
    return { isrc: rec.isrc, albumArt: rec.cover_art_url || '' };
  } catch (e) { return null; }
}

async function fetchSoundplate(trackUrl) {
  try {
    const signal = AbortSignal.timeout(5000);
    const r = await fetch(`${SOUNDPLATE_API}?q=${encodeURIComponent(trackUrl)}`, {
      signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d?.isrc) return null;
    return { isrc: d.isrc, albumArt: d.artwork_url || '' };
  } catch (e) { return null; }
}

async function fetchOembedArt(trackId) {
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F${trackId}`);
    if (!r.ok) return '';
    const d = await r.json().catch(() => null);
    return d?.thumbnail_url || '';
  } catch (e) { return ''; }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors() });

  const reqUrl = new URL(request.url);
  const trackId = reqUrl.searchParams.get('id') || '';
  const spotifyUrl = reqUrl.searchParams.get('url') || (trackId ? `https://open.spotify.com/track/${trackId}` : '');

  if (!trackId && !spotifyUrl) return json({ error: 'Missing id or url parameter.' }, 400);

  const clientId = env?.SPOTIFY_CLIENT_ID || '';
  const clientSecret = env?.SPOTIFY_CLIENT_SECRET || '';

  try {
    let isrc = '—';
    let albumArt = '';
    let albumName = 'Unknown Album';

    // Step 1: Official Spotify API (most reliable)
    if (trackId && clientId && clientSecret) {
      const token = await getClientToken(clientId, clientSecret);
      if (token) {
        const r = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (r.ok) {
          const d = await r.json();
          isrc = d?.external_ids?.isrc || '—';
          albumArt = d?.album?.images?.[0]?.url || '';
          albumName = d?.album?.name || 'Unknown Album';
        }
      }
    }

    // Step 2: credits.fm fallback
    if (isrc === '—' && spotifyUrl) {
      const r = await fetchCreditsFm(spotifyUrl);
      if (r) { isrc = r.isrc || '—'; albumArt = albumArt || r.albumArt; }
    }

    // Step 3: Soundplate fallback
    if (isrc === '—' && spotifyUrl) {
      const r = await fetchSoundplate(spotifyUrl);
      if (r) { isrc = r.isrc || '—'; albumArt = albumArt || r.albumArt; }
    }

    // Step 4: oEmbed for album art if still missing
    if (!albumArt && trackId) albumArt = await fetchOembedArt(trackId);

    return json({ isrc, albumArt, albumName });
  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500);
  }
}
