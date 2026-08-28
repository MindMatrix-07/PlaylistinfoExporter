const fetch = require('isomorphic-unfetch');

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

function cleanSongTitle(t) {
  if (!t) return '';
  let s = t.split('(')[0].split('-')[0].trim();
  s = s.replace(/["'”]/g, '').trim();
  return s;
}

async function fetchMusicBrainz(query) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2200);
    const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25&inc=isrcs`;
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'PlaylistInfoExporter/7.4 (https://playlistinfoexporter.netlify.app)' }
    });
    clearTimeout(timeout);
    if (r.ok) return await r.json();
  } catch (e) {}
  return null;
}

async function resolveTrackFreeFallback(trackId) {
  try {
    const embedUrl = `https://open.spotify.com/embed/track/${trackId}`;
    const r = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const startTag = '<script id="__NEXT_DATA__" type="application/json">';
    const s = html.indexOf(startTag);
    if (s === -1) return null;
    const jsonStart = s + startTag.length;
    const jsonEnd = html.indexOf('</script>', jsonStart);
    const data = JSON.parse(html.substring(jsonStart, jsonEnd));
    const entity = data?.props?.pageProps?.state?.data?.entity;
    if (!entity) return null;

    const rawTitle = entity.title || entity.name || '';
    const artistsArr = (entity.artists || []).map(a => a.name).join(' ');
    const artist = entity.artists?.[0]?.name || '';
    let albumArt = entity.visualIdentity?.image?.[0]?.url || '';
    let albumName = rawTitle;
    let isrc = '—';

    if (rawTitle) {
      const cleanTitle = cleanSongTitle(rawTitle);
      const firstArtist = artist ? artist.split(',')[0].split('&')[0].trim() : '';

      const [itunesRes, mbData1] = await Promise.all([
        fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle + ' ' + firstArtist)}&entity=song&limit=1`).then(res => res.json()).catch(() => null),
        fetchMusicBrainz(`${cleanTitle} ${firstArtist}`)
      ]);

      if (itunesRes?.results?.[0]) {
        const match = itunesRes.results[0];
        if (match.collectionName) albumName = match.collectionName;
        if (match.artworkUrl100) albumArt = match.artworkUrl100.replace('100x100bb', '600x600bb');
      }

      let recs = mbData1?.recordings || [];
      
      const isOfficialMatch = (rec) => {
        if (!rec.isrcs || !rec.isrcs.length) return false;
        const recTitle = (rec.title || '').toLowerCase();
        const artistCredit = (rec['artist-credit'] || []).map(a => (a.name || a.artist?.name || '').toLowerCase()).join(' ');
        
        if (recTitle.includes('8-bit') || recTitle.includes('karaoke') || recTitle.includes('tribute') || recTitle.includes('cover')) {
          return false;
        }

        const lowerCleanTitle = cleanTitle.toLowerCase();
        const lowerFirstArtist = firstArtist.toLowerCase();

        const titleMatches = recTitle.includes(lowerCleanTitle) || lowerCleanTitle.includes(recTitle);
        const artistMatches = artistCredit.includes(lowerFirstArtist) || recTitle.includes(lowerFirstArtist);

        return titleMatches && artistMatches;
      };

      let match = recs.find(isOfficialMatch);

      if (!match && cleanTitle && artistsArr) {
        await new Promise(res => setTimeout(res, 50));
        const mbData2 = await fetchMusicBrainz(`${cleanTitle} ${artistsArr.replace(/,/g, ' ')}`);
        recs = mbData2?.recordings || [];
        match = recs.find(isOfficialMatch);
      }

      if (match && match.isrcs && match.isrcs.length > 0) {
        isrc = match.isrcs[0];
      }
    }

    return {
      isrc,
      albumName,
      albumArt
    };
  } catch (e) {
    return null;
  }
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
