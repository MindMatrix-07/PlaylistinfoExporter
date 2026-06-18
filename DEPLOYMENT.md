# Deployment Notes

Render free usage can suspend the web-fetch backend during the billing period. Netlify is the preferred no-credit-card replacement for the Web Fetch copy of the site.

## Netlify Web Fetch Backend

1. Create a new Netlify site from the GitHub repo `MindMatrix-07/PlaylistinfoExporter`.
2. Use branch `main`.
3. Build command: `npm install`
4. Publish directory: `.`
5. Functions directory: `netlify/functions`
6. If Netlify lets you choose the site name, use `playlistinfoexporter` so the URL becomes `https://playlistinfoexporter.netlify.app/`.

The repo includes `netlify.toml`, which routes:

- `/api/spotify-info` to the fast Spotify-list function.
- `/api/spotify-track-details` to the short per-track ISRC function.

Web Fetch is split into smaller calls so Netlify does not need to keep one long-running function alive for a full playlist. The page first loads all tracks, then fills ISRC and album details in parallel.

Vercel stays as the Spotify Premium host. Its Spotify Web Fetch button points to `https://playlistinfoexporter.netlify.app/`.
