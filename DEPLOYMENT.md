# Deployment Notes

## Cloudflare Pages (Recommended)

Cloudflare Pages provides global edge hosting with zero cold starts, fast serverless Functions, and high uptime.

### Method 1: Git Integration (Cloudflare Dashboard)

1. Log into [Cloudflare Dashboard](https://dash.cloudflare.com/) and navigate to **Workers & Pages** -> **Create Application** -> **Pages** -> **Connect to Git**.
2. Select your repository: `MindMatrix-07/PlaylistinfoExporter` (branch `main`).
3. Set build settings:
   - **Framework preset**: None
   - **Build command**: `npm install`
   - **Build output directory**: `.`
4. (Optional) Set Environment Variables in **Settings** -> **Environment variables**:
   - `SPOTIFY_CLIENT_ID` (optional, for higher rate limits & instant official Spotify API ISRC lookups)
   - `SPOTIFY_CLIENT_SECRET` (optional)
5. Save and Deploy. Cloudflare will auto-detect the `functions/` folder and set up `/api/spotify-info`, `/api/spotify-track-details`, and `/api/spotify-batch-isrc`.

### Method 2: Direct Wrangler CLI Deployment

1. Install dependencies locally: `npm install`
2. Deploy directly to Cloudflare Pages using Wrangler:
   ```bash
   npx wrangler pages deploy . --project-name=playlist-info-exporter
   ```

### Local Development on Cloudflare Pages
To simulate Cloudflare Pages Functions locally:
```bash
npm run pages:dev
```

---

## Netlify Web Fetch Backend

1. Create a new Netlify site from the GitHub repo `MindMatrix-07/PlaylistinfoExporter`.
2. Use branch `main`.
3. Build command: `npm install`
4. Publish directory: `.`
5. Functions directory: `netlify/functions`
6. Recommended site name: `playlistinfoexporter` (URL: `https://playlistinfoexporter.netlify.app/`).

The repo includes `netlify.toml`, which routes `/api/*` endpoints to Netlify functions.

---

## Vercel Deployment

1. Import project in Vercel.
2. `vercel.json` routes `/api/spotify-info`, `/api/spotify-track-details`, and `/api/spotify-batch-isrc`.
