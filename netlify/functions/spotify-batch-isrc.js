const handler = require('../../api/spotify-batch-isrc');

exports.handler = async (event) => runNodeHandler(handler, event);

function runNodeHandler(handler, event) {
  return new Promise((resolve) => {
    let bodyObj = {};
    if (event.body) {
      try {
        bodyObj = JSON.parse(event.body);
      } catch (e) {
        bodyObj = event.body;
      }
    }
    const req = {
      method: event.httpMethod,
      query: event.queryStringParameters || {},
      body: bodyObj
    };
    const res = createResponse(resolve);
    handler(req, res).catch((err) => {
      resolve({
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: err.message || 'Server error.' })
      });
    });
  });
}

function createResponse(resolve) {
  const headers = corsHeaders();
  return {
    statusCode: 200,
    setHeader(key, value) {
      headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      resolve({
        statusCode: this.statusCode,
        headers,
        body: JSON.stringify(body)
      });
    },
    end(body = '') {
      resolve({
        statusCode: this.statusCode,
        headers,
        body
      });
    }
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}
