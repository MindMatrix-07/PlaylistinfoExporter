# Deployment Notes

Render free usage can suspend the web-fetch backend during the billing period. The app can run on any Node host that supports `npm start` and a `PORT` environment variable.

## Koyeb Web Fetch Backend

1. Create a new Koyeb Web Service from the GitHub repo `MindMatrix-07/PlaylistinfoExporter`.
2. Use branch `main`.
3. Use either the Node buildpack or Docker.
4. Build command: `npm install`
5. Run command: `npm start`
6. Port: Koyeb sets `PORT`; the server reads it automatically.

After Koyeb gives you the live URL, update `WEB_FETCH_ORIGIN` in `app.js` from the Render URL to the Koyeb URL and push again. Vercel will then send Spotify Web Fetch users to Koyeb.

The backend-hosted copy of the site automatically starts in Web Fetch mode on any non-Vercel host, so the Koyeb URL itself should work immediately.
