const spotifyTrackDetailsHandler = require('../../api/spotify-track-details');

export async function onRequest(context) {
  const { request, env } = context;

  if (env) {
    if (env.SPOTIFY_CLIENT_ID) process.env.SPOTIFY_CLIENT_ID = env.SPOTIFY_CLIENT_ID;
    if (env.SPOTIFY_CLIENT_SECRET) process.env.SPOTIFY_CLIENT_SECRET = env.SPOTIFY_CLIENT_SECRET;
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders()
    });
  }

  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());

  let bodyData = null;
  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
    try {
      bodyData = await request.json();
    } catch (e) {
      try {
        bodyData = await request.text();
      } catch (_) {}
    }
  }

  const req = {
    method: request.method,
    url: request.url,
    query,
    body: bodyData,
    headers: Object.fromEntries(request.headers.entries())
  };

  let statusCode = 200;
  const responseHeaders = corsHeaders();
  let responseBody = '';

  const res = {
    statusCode: 200,
    setHeader(key, value) {
      responseHeaders[key] = value;
    },
    status(code) {
      statusCode = code;
      this.statusCode = code;
      return this;
    },
    json(body) {
      responseHeaders['content-type'] = 'application/json; charset=utf-8';
      responseBody = JSON.stringify(body);
    },
    end(body = '') {
      if (typeof body === 'object') {
        responseHeaders['content-type'] = 'application/json; charset=utf-8';
        responseBody = JSON.stringify(body);
      } else {
        responseBody = body;
      }
    }
  };

  try {
    await spotifyTrackDetailsHandler(req, res);
    return new Response(responseBody, {
      status: statusCode,
      headers: responseHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Server error' }), {
      status: 500,
      headers: {
        ...corsHeaders(),
        'content-type': 'application/json; charset=utf-8'
      }
    });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PATCH, DELETE, PUT',
    'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  };
}
