'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FleetState } = require('../state');
const { createApp } = require('../routes');

test('roadmap page and its assets are served', async () => {
  const server = createApp(new FleetState(['a'])).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<title>Switchyard<\/title>/);
    assert.match(html, /src="layout\.js"[\s\S]*src="roadmap\.js"/);
    for (const asset of ['roadmap.css', 'roadmap.js', 'layout.js', 'board.html']) {
      assert.equal((await fetch(`${base}/${asset}`)).status, 200, asset);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('the track scrolls without a colored scrollbar band in dark mode', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'roadmap.css'), 'utf8');
  const additions = css.slice(css.indexOf('live page additions'));
  assert.match(additions, /\.track\s*\{[^}]*scrollbar-color:\s*var\(--rule-2\)\s+transparent[^}]*\}/);
});
