'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('path');
const { FleetState } = require('../state');
const { Dashboard } = require('../dashboard');
const { createApp } = require('../routes');
const { tempDir, cleanupTempDirs } = require('./fixtures');

after(() => cleanupTempDirs());

const HELLO = { type: 'hello', protocol: 2, python: '3.10', hostname: 'h', home: '/home/u', claude: null, codex: null, notes: [] };
// pid is set so the session is visible under the dashboard-membership rules regardless of the
// real wall-clock time (it would otherwise depend on whether updatedAt is before "now").
const session = { key: 'claude:a', agent: 'claude', id: 'a', name: 'demo-sess', cwd: '/w', gitBranch: null,
  pid: 4242, state: 'working', updatedAt: 1757890000000, stepsSource: 'claude-tasks',
  steps: [{ id: '1', title: 'x', status: 'current', blockedBy: [], blocks: [], description: '', activeForm: null, updatedAt: 1757890000000 }] };
// No pid, an old updatedAt, and never observed transitioning into 'working': hidden by default.
const hiddenSession = { key: 'codex:old', agent: 'codex', id: 'old', name: 'ancient', cwd: '/w', gitBranch: null,
  pid: null, state: 'idle', updatedAt: 1, stepsSource: null, steps: [] };

async function withServer(fn) {
  const dir = tempDir('sy-routes-');
  const state = new FleetState(['box3']);
  state.apply('box3', HELLO);
  const dashboard = new Dashboard(state, { stateFile: path.join(dir, 'dashboard.json') });
  const server = createApp(dashboard).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ state, dashboard, base, port });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('fleet snapshot and board endpoints', () => withServer(async ({ state, base }) => {
  state.apply('box3', { type: 'session', session });
  const fleet = await (await fetch(`${base}/api/fleet`)).json();
  assert.equal(fleet.hosts[0].status, 'online');
  assert.equal(fleet.sessions[0].host, 'box3');
  const sessions = await (await fetch(`${base}/api/sessions?limit=all`)).json();
  assert.equal(sessions[0].id, 'box3~a');
  const tasks = await (await fetch(`${base}/api/sessions/box3~a`)).json();
  assert.equal(tasks[0].status, 'in_progress');
  assert.equal((await fetch(`${base}/api/sessions/box3~zzz`)).status, 404);
  assert.equal((await fetch(`${base}/api/sessions?limit=0`)).status, 400);
  assert.equal((await (await fetch(`${base}/api/tasks/all`)).json()).length, 1);
  const note = await fetch(`${base}/api/tasks/box3~a/1/note`, { method: 'POST' });
  assert.equal(note.status, 501);
  assert.match((await note.json()).error, /isn't available yet/);
  assert.equal((await fetch(`${base}/api/tasks/box3~a/1`, { method: 'DELETE' })).status, 501);
}));

test('SSE streams fleet events and board updates', () => withServer(async ({ state, base }) => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  let text = '';
  const until = async (needle) => {
    while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value);
  };
  await until('"connected"');
  state.apply('box3', { type: 'session', session });
  await until('"type":"update","sessionId":"box3~a"');
  assert.match(text, /"type":"session","host":"box3"/);
  state.apply('box3', { type: 'tick' });
  await until('"type":"tick"');
  ac.abort();
}));

test('the board page is served', () => withServer(async ({ base }) => {
  assert.equal((await fetch(`${base}/board.html`)).status, 200);
}));

// fetch() forbids setting Host or Origin headers, so these use node:http directly.
function rawRequest(port, hostHeader, pathname = '/api/fleet') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET',
      headers: { Host: hostHeader } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawPost(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('a spoofed Host header is rejected (DNS rebinding)', () => withServer(async ({ base }) => {
  const port = Number(new URL(base).port);
  const res = await rawRequest(port, 'evil.example:1234');
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body),
    { error: `Host 'evil.example:1234' is not allowed. Open the dashboard at http://127.0.0.1:${port}/ instead.` });
}));

test('Host: localhost is allowed', () => withServer(async ({ base }) => {
  const port = Number(new URL(base).port);
  const res = await rawRequest(port, `localhost:${port}`);
  assert.equal(res.status, 200);
}));

// ── /api/dashboard/remove and /restore ──────────────────────────────────────

test('/remove works: 200, and /api/fleet then excludes the session', () => withServer(async ({ state, base, port }) => {
  state.apply('box3', { type: 'session', session });
  const res = await rawPost(port, '/api/dashboard/remove', { host: 'box3', key: session.key });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  const fleet = await (await fetch(`${base}/api/fleet`)).json();
  assert.deepEqual(fleet.sessions, []);
}));

test('/restore works: the session comes back', () => withServer(async ({ state, base, port }) => {
  state.apply('box3', { type: 'session', session });
  await rawPost(port, '/api/dashboard/remove', { host: 'box3', key: session.key });
  const res = await rawPost(port, '/api/dashboard/restore', { host: 'box3', key: session.key });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  const fleet = await (await fetch(`${base}/api/fleet`)).json();
  assert.equal(fleet.sessions.length, 1);
}));

test('415 without the JSON content type', () => withServer(async ({ state, port }) => {
  state.apply('box3', { type: 'session', session });
  const res = await rawPost(port, '/api/dashboard/remove', JSON.stringify({ host: 'box3', key: session.key }),
    { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 415);
}));

test('403 with a cross-origin Origin header', () => withServer(async ({ state, port }) => {
  state.apply('box3', { type: 'session', session });
  const res = await rawPost(port, '/api/dashboard/remove', { host: 'box3', key: session.key },
    { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
}));

test('403 when the Origin port differs from the server\'s', () => withServer(async ({ state, port }) => {
  state.apply('box3', { type: 'session', session });
  const res = await rawPost(port, '/api/dashboard/remove', { host: 'box3', key: session.key },
    { Origin: 'http://127.0.0.1:1' });
  assert.equal(res.status, 403);
}));

test('200 with a same-origin Origin header', () => withServer(async ({ state, port }) => {
  state.apply('box3', { type: 'session', session });
  const res = await rawPost(port, '/api/dashboard/remove', { host: 'box3', key: session.key },
    { Origin: `http://127.0.0.1:${port}` });
  assert.equal(res.status, 200);
}));

test('400 for a bad body', () => withServer(async ({ port }) => {
  const res1 = await rawPost(port, '/api/dashboard/remove', { host: 123, key: 'x' });
  assert.equal(res1.status, 400);
  const res2 = await rawPost(port, '/api/dashboard/remove', { host: 'box3' });
  assert.equal(res2.status, 400);
}));

test('404 for an unknown session', () => withServer(async ({ port }) => {
  const res = await rawPost(port, '/api/dashboard/remove', { host: 'box3', key: 'claude:zzz' });
  assert.equal(res.status, 404);
}));

test('an invalid JSON body gives 400 with a JSON error, not Express\'s default HTML error page', () => withServer(async ({ port }) => {
  const res = await rawPost(port, '/api/dashboard/remove', '{not json');
  assert.equal(res.status, 400);
  assert.doesNotMatch(res.body, /<html/i, 'must not be Express\'s default HTML error page');
  const parsed = JSON.parse(res.body); // throws if it isn't JSON at all
  assert.equal(typeof parsed.error, 'string');
}));

test('a cross-origin request with an invalid body gives 403, not 400: Origin is checked before parsing', () => withServer(async ({ port }) => {
  const res = await rawPost(port, '/api/dashboard/remove', '{not json', { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
}));

test('Origin: null gives 403', () => withServer(async ({ state, port }) => {
  state.apply('box3', { type: 'session', session });
  const res = await rawPost(port, '/api/dashboard/remove', { host: 'box3', key: session.key }, { Origin: 'null' });
  assert.equal(res.status, 403);
}));

test('a malformed Origin header gives 403', () => withServer(async ({ state, port }) => {
  state.apply('box3', { type: 'session', session });
  const res = await rawPost(port, '/api/dashboard/remove', { host: 'box3', key: session.key }, { Origin: 'not a url' });
  assert.equal(res.status, 403);
}));

// ── /api/dashboard/hidden and /add ──────────────────────────────────────────

test('GET /api/dashboard/hidden lists hidden sessions', () => withServer(async ({ state, base }) => {
  state.apply('box3', { type: 'session', session: hiddenSession });
  const res = await fetch(`${base}/api/dashboard/hidden`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].host, 'box3');
  assert.equal(body.sessions[0].key, 'codex:old');
}));

test('/add works: 200, and /api/fleet then includes the session, even across a hub restart', () => withServer(async ({ state, base, port }) => {
  state.apply('box3', { type: 'session', session: hiddenSession });
  const res = await rawPost(port, '/api/dashboard/add', { host: 'box3', key: hiddenSession.key });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  const fleet = await (await fetch(`${base}/api/fleet`)).json();
  assert.equal(fleet.sessions.length, 1);
  assert.equal(fleet.sessions[0].key, 'codex:old');
}));

test('/add: 415 without the JSON content type', () => withServer(async ({ state, port }) => {
  state.apply('box3', { type: 'session', session: hiddenSession });
  const res = await rawPost(port, '/api/dashboard/add', JSON.stringify({ host: 'box3', key: hiddenSession.key }),
    { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 415);
}));

test('/add: 403 with a cross-origin Origin header', () => withServer(async ({ state, port }) => {
  state.apply('box3', { type: 'session', session: hiddenSession });
  const res = await rawPost(port, '/api/dashboard/add', { host: 'box3', key: hiddenSession.key },
    { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
}));

test('/add: 400 for a bad body', () => withServer(async ({ port }) => {
  const res1 = await rawPost(port, '/api/dashboard/add', { host: 123, key: 'x' });
  assert.equal(res1.status, 400);
  const res2 = await rawPost(port, '/api/dashboard/add', { host: 'box3' });
  assert.equal(res2.status, 400);
}));

test('/add: 404 for an unknown session', () => withServer(async ({ port }) => {
  const res = await rawPost(port, '/api/dashboard/add', { host: 'box3', key: 'claude:zzz' });
  assert.equal(res.status, 404);
}));

const RUN = { id: 'a', label: 'grpo', status: 'Running', done: 1, total: 10, gpus: [0],
  pid: 4242, mtime: 1760000000.5, alive: true, dir: '/r' };

test('GET /api/fleet includes runs', () => withServer(async ({ state, base }) => {
  state.apply('box3', { type: 'run', run: RUN });
  const body = await (await fetch(`${base}/api/fleet`)).json();
  assert.deepEqual(body.runs.map((r) => [r.host, r.id, r.status]), [['box3', 'a', 'Running']]);
}));

test('/api/events forwards run and run-removed', () => withServer(async ({ state, base }) => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  let text = '';
  const until = async (needle) => {
    while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value);
  };
  await until('"connected"');
  state.apply('box3', { type: 'run', run: RUN });
  await until('"type":"run"');
  assert.match(text, /"host":"box3"/);
  state.apply('box3', { type: 'run-removed', id: 'a' });
  await until('"type":"run-removed"');
  assert.match(text, /"id":"a"/);
  ac.abort();
}));
