const { helpers } = require('./spotify-info');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { url, albumArt } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing Spotify track URL parameter.' });
  }

  try {
    const details = await helpers.fetchSoundplateDetails(
      { url },
      albumArt || '',
      { maxAttempts: 2, rateLimitSleepMs: 6000 }
    );

    return res.status(200).json(details);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error fetching track details.' });
  }
};
