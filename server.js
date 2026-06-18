const fs = require('fs');
const http = require('http');
const path = require('path');

const spotifyInfoHandler = require('./api/spotify-info');
const spotifyTrackDetailsHandler = require('./api/spotify-track-details');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (parsedUrl.pathname === '/api/spotify-info') {
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());
    addVercelResponseHelpers(res);
    await spotifyInfoHandler(req, res);
    return;
  }

  if (parsedUrl.pathname === '/api/spotify-track-details') {
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());
    addVercelResponseHelpers(res);
    await spotifyTrackDetailsHandler(req, res);
    return;
  }

  serveStatic(parsedUrl.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Playlist Info Exporter listening on port ${PORT}`);
});

function serveStatic(urlPath, res) {
  const requestedPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(requestedPath)));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function addVercelResponseHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.json = (body) => {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(body));
  };
}
