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

function cleanTitle(t) {
  if (!t) return '';
  return t.split('(')[0].split('-')[0].replace(/["""]/g, '').trim();
}

async function fetchMusicBrainz(query) {
  try {
    const signal = AbortSignal.timeout(2500);
    const r = await fetch(
      `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25&inc=isrcs`,
      { signal, headers: { 'User-Agent': 'PlaylistInfoExporter/7.4 (https://playlistinfoexporter.pages.dev)' } }
    );
    if (r.ok) return await r.json();
  } catch (e) { /* ignore */ }
  return null;
}

async function resolveTrackFreeFallback(trackId) {
  try {
    const r = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const tag = '<script id="__NEXT_DATA__" type="application/json">';
    const s = html.indexOf(tag);
    if (s === -1) return null;
    const data = JSON.parse(html.substring(s + tag.length, html.indexOf('</script>', s + tag.length)));
    const entity = data?.props?.pageProps?.state?.data?.entity;
    if (!entity) return null;

    const rawTitle = entity.title || entity.name || '';
    const artistsArr = (entity.artists || []).map(a => a.name).join(' ');
    const artist = entity.artists?.[0]?.name || '';
    let albumArt = entity.visualIdentity?.image?.[0]?.url || '';
    let albumName = rawTitle;
    let isrc = '—';

    if (rawTitle) {
      const ct = cleanTitle(rawTitle);
      const fa = artist ? artist.split(',')[0].split('&')[0].trim() : '';

      const [itunesRes, mbData] = await Promise.all([
        fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(ct + ' ' + fa)}&entity=song&limit=1`)
          .then(r => r.json()).catch(() => null),
        fetchMusicBrainz(`${ct} ${fa}`)
      ]);

      if (itunesRes?.results?.[0]) {
        const m = itunesRes.results[0];
        if (m.collectionName) albumName = m.collectionName;
        if (m.artworkUrl100) albumArt = m.artworkUrl100.replace('100x100bb', '600x600bb');
      }

      const recs = mbData?.recordings || [];
      const ctL = ct.toLowerCase(), faL = fa.toLowerCase();
      const match = recs.find(rec => {
        if (!rec.isrcs?.length) return false;
        const rt = (rec.title || '').toLowerCase();
        const ac = (rec['artist-credit'] || []).map(a => (a.name || a.artist?.name || '').toLowerCase()).join(' ');
        if (rt.includes('8-bit') || rt.includes('karaoke') || rt.includes('tribute') || rt.includes('cover')) return false;
        return (rt.includes(ctL) || ctL.includes(rt)) && (ac.includes(faL) || rt.includes(faL));
      });

      if (!match && ct && artistsArr) {
        await new Promise(r => setTimeout(r, 50));
        const mbData2 = await fetchMusicBrainz(`${ct} ${artistsArr.replace(/,/g, ' ')}`);
        const recs2 = mbData2?.recordings || [];
        const m2 = recs2.find(rec => {
          if (!rec.isrcs?.length) return false;
          const rt = (rec.title || '').toLowerCase();
          const ac = (rec['artist-credit'] || []).map(a => (a.name || a.artist?.name || '').toLowerCase()).join(' ');
          return (rt.includes(ctL) || ctL.includes(rt)) && (ac.includes(faL) || rt.includes(faL));
        });
        if (m2?.isrcs?.length) isrc = m2.isrcs[0];
      } else if (match?.isrcs?.length) {
        isrc = match.isrcs[0];
      }
    }

    return { isrc, albumName, albumArt };
  } catch (e) { return null; }
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
