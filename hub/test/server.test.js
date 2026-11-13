'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { configPathFromArgs } = require('../../server');
const { makeHome, waitFor, tempDir, cleanupTempDirs } = require('./fixtures');

after(() => cleanupTempDirs());

test('config path: --config, then $SWITCHYARD_CONFIG, then the default', () => {
  assert.equal(configPathFromArgs(['--config', '/tmp/x.json']), '/tmp/x.json');
  process.env.SWITCHYARD_CONFIG = '/tmp/env.json';
  assert.equal(configPathFromArgs([]), '/tmp/env.json');
  delete process.env.SWITCHYARD_CONFIG;
  assert.match(configPathFromArgs([]), /\.config\/switchyard\/hosts\.json$/);
  assert.throws(() => configPathFromArgs(['--config']), /needs a file path/);
});

test('server starts on 127.0.0.1, serves the fleet, and shuts down cleanly', async () => {
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const f = makeHome();
  const dir = tempDir('sy-srv-');
  const cfg = path.join(dir, 'hosts.json');
  const stateFile = path.join(dir, 'dashboard.json');
  fs.writeFileSync(cfg, JSON.stringify({ port, pollSeconds: 0.2, stateFile, hosts: [{ name: 'box', ssh: null, claude: f.claude, codex: f.codex, home: f.home }] }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js'), '--config', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  try {
    await waitFor(() => out.includes(`http://127.0.0.1:${port}`));
    let fleet = null;
    const end = Date.now() + 15000;
    while (Date.now() < end && !(fleet && fleet.sessions.length === 1)) {
      fleet = await (await fetch(`http://127.0.0.1:${port}/api/fleet`)).json();
      if (fleet.sessions.length !== 1) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(fleet.sessions.length, 1);
    assert.equal(fleet.hosts[0].status, 'online');
  } finally {
    child.kill('SIGTERM');
  }
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
});
