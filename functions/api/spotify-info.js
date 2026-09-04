// Cloudflare Pages Function — pure ESM, uses native fetch (no node-fetch, no isomorphic-unfetch)

const SOUNDPLATE_API = 'https://phpstack-822472-6184058.cloudwaysapps.com/api/spotify.php';
const CREDITS_FM_SEARCH = 'https://api.credits.fm/v1/search';

let _clientToken = null;
let _clientTokenExp = 0;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PATCH, DELETE, PUT',
    'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
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
  if (_clientToken && Date.now() < _clientTokenExp - 30000) return _clientToken;
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (r.ok) { const d = await r.json(); _clientToken = d.access_token; _clientTokenExp = Date.now() + (d.expires_in || 3600) * 1000; }
  } catch (e) { /* ignore */ }
  return _clientToken;
}

async function getSpotifyTrackISRC(trackId, token) {
  if (!trackId || !token) return null;
  try {
    const r = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const d = await r.json();
    const isrc = d?.external_ids?.isrc;
    if (!isrc) return null;
    return { isrc, albumArt: d?.album?.images?.[0]?.url || '', albumName: d?.album?.name || 'Unknown Album' };
  } catch (e) { return null; }
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
    return { isrc: rec.isrc, albumArt: rec.cover_art_url || '', albumName: 'Unknown Album' };
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
    return { isrc: d.isrc, albumArt: d.artwork_url || '', albumName: d.album || 'Unknown Album' };
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

function extractTrackId(url) {
  if (!url) return '';
  const m = String(url).match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})|spotify:track:([A-Za-z0-9]{22})/);
  return m ? (m[1] || m[2]) : '';
}

function extractSpotifyItem(raw) {
  const v = String(raw || '').trim();
  const uri = v.match(/spotify:(playlist|album|track):([A-Za-z0-9]+)/i);
  if (uri) return { type: uri[1].toLowerCase(), id: uri[2] };
  const url = v.match(/open\.spotify\.com\/(playlist|album|track)\/([A-Za-z0-9]+)/i);
  if (url) return { type: url[1].toLowerCase(), id: url[2] };
  return null;
}

async function scrapeSpotifyPlaylist(url) {
  // Scrape Spotify public page directly — avoids needing spotify-url-info npm package
  const cleanUrl = url.split('?')[0];
  const item = extractSpotifyItem(cleanUrl);
  if (!item) return null;

  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${item.type}/${item.id}`)}`;
  const [oembedRes, embedRes] = await Promise.allSettled([
    fetch(oembedUrl).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`https://open.spotify.com/embed/${item.type}/${item.id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }).then(r => r.ok ? r.text() : null).catch(() => null)
  ]);

  const oembedData = oembedRes.value;
  const embedHtml = embedRes.value;

  let tracks = [];
  let name = '';
  let owner = '';
  let image = oembedData?.thumbnail_url || '';

  if (embedHtml) {
    const tag = '<script id="__NEXT_DATA__" type="application/json">';
    const s = embedHtml.indexOf(tag);
    if (s !== -1) {
      try {
        const data = JSON.parse(embedHtml.substring(s + tag.length, embedHtml.indexOf('</script>', s + tag.length)));
        const entity = data?.props?.pageProps?.state?.data?.entity;
        if (entity) {
          name = entity.name || entity.title || '';
          image = entity.visualIdentity?.image?.[0]?.url || image;

          if (item.type === 'playlist' || item.type === 'album') {
            const trackList = entity.trackList || entity.tracks?.items || [];
            tracks = trackList.map(t => {
              const track = t.track || t;
              const artistList = track.artists || (track.subtitle ? [{ name: track.subtitle }] : []);
              return {
                name: track.title || track.name || '',
                artists: artistList.map(a => typeof a === 'string' ? a : a.name),
                uri: track.uri || '',
                albumArt: track.visualIdentity?.image?.[0]?.url || image
              };
            }).filter(t => t.name);
          } else if (item.type === 'track') {
            tracks = [{
              name: entity.title || entity.name || '',
              artists: (entity.artists || []).map(a => a.name),
              uri: entity.uri || `spotify:track:${item.id}`,
              albumArt: image
            }];
          }

          owner = entity.ownerDisplayName || entity.owner?.display_name || entity.owner?.name || '';
        }
      } catch (e) { /* ignore parse errors */ }
    }
  }

  if (!name && oembedData) name = oembedData.title || '';
  if (!owner && oembedData) owner = oembedData.author_name || '';

  return { name, owner, image, item, tracks };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors() });

  const reqUrl = new URL(request.url);
  const spotifyUrl = reqUrl.searchParams.get('url') || '';
  const fetchDetails = reqUrl.searchParams.get('details') !== '0';

  if (!spotifyUrl) return json({ error: 'Missing Spotify URL parameter.' }, 400);

  const item = extractSpotifyItem(spotifyUrl);
  if (!item) return json({ error: 'Paste a Spotify playlist, album, or track URL.' }, 400);

  const clientId = env?.SPOTIFY_CLIENT_ID || '';
  const clientSecret = env?.SPOTIFY_CLIENT_SECRET || '';
  const clientToken = await getClientToken(clientId, clientSecret);

  try {
    const scraped = await scrapeSpotifyPlaylist(spotifyUrl);
    if (!scraped || !scraped.tracks?.length) {
      return json({ error: 'Could not scrape playlist. Make sure the playlist is public.' }, 502);
    }

    const trackDetails = [];
    if (fetchDetails) {
      for (const t of scraped.tracks) {
        const trackId = extractTrackId(t.uri) || (t.uri?.split(':')[2] || '');
        const trackUrl = trackId ? `https://open.spotify.com/track/${trackId}` : '';
        let detail = { isrc: '—', albumArt: t.albumArt || scraped.image, albumName: 'Unknown Album', trackUrl };

        if (trackId && clientToken) {
          const r = await getSpotifyTrackISRC(trackId, clientToken);
          if (r) { detail = { ...r, trackUrl }; }
        }

        if (detail.isrc === '—' && trackUrl) {
          const r = await fetchCreditsFm(trackUrl) || await fetchSoundplate(trackUrl);
          if (r) detail = { ...detail, ...r };
        }

        if (!detail.albumArt && trackId) detail.albumArt = await fetchOembedArt(trackId);
        trackDetails.push(detail);
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const items = scraped.tracks.map((t, i) => {
      const trackId = extractTrackId(t.uri) || (t.uri?.split(':')[2] || '');
      const d = trackDetails[i] || {};
      return {
        track: {
          name: t.name || 'Unknown',
          artists: (t.artists || []).map(a => ({ name: a })),
          album: { name: d.albumName || 'Unknown Album' },
          external_urls: { spotify: d.trackUrl || (trackId ? `https://open.spotify.com/track/${trackId}` : '') },
          external_ids: { isrc: d.isrc || '—' },
          albumArt: d.albumArt || t.albumArt || scraped.image
        }
      };
    });

    return json({
      source: 'cloudflare_edge',
      name: scraped.name || 'Playlist',
      owner: { display_name: scraped.owner || 'Unknown' },
      images: [{ url: scraped.image }],
      tracks: { total: items.length, items }
    });
  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500);
  }
}
