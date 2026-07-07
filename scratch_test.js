const fetch = require('isomorphic-unfetch');
const { helpers } = require('./api/spotify-info');

async function run() {
  const tests = [
    // Soundplate track (should have artwork_url)
    { label: 'Soundplate track', url: 'https://open.spotify.com/track/0ASxERcpzFuqFvFLRZAnZA' },
    // Deezer track (global song — Blinding Lights)
    { label: 'Deezer track', url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXscqK' },
    // Wix track (Ya Tum - not on Deezer, Soundplate fails from India)
    { label: 'Wix track', url: 'https://open.spotify.com/track/0afUzDQQ4QavsET1wxwQyc' },
  ];

  for (const t of tests) {
    console.log(`\n[${t.label}]`);
    const r = await helpers.fetchSoundplateDetails({ url: t.url }, '', { maxAttempts: 1, rateLimitSleepMs: 0 });
    console.log('  lookupStatus:', r.lookupStatus);
    console.log('  isrc:        ', r.isrc);
    console.log('  albumName:   ', r.albumName);
    console.log('  albumArt:    ', r.albumArt ? r.albumArt.slice(0, 80) + '...' : '(empty — fallback to playlist image)');
  }
}
run().catch(console.error);
