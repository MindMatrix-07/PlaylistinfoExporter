const fetch = require('isomorphic-unfetch');

async function check(url) {
  try {
    const embedUrl = url.replace('open.spotify.com/', 'open.spotify.com/embed/');
    console.log('Fetching:', embedUrl);
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    console.log('Status:', res.status);
    const html = await res.text();
    console.log('HTML length:', html.length);
    if (html.includes('Page not found') || html.includes('404')) {
      console.log('Contains 404/Page not found');
    } else {
      console.log('Looks OK!');
    }
  } catch (e) {
    console.error(e);
  }
}

async function run() {
  await check('https://open.spotify.com/playlist/6VFEHjrIGyV3EcPwm1GT3O');
}

run();
