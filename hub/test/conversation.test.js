'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { normalizeConfig } = require('../config');
const { FleetState } = require('../state');
const { Dashboard } = require('../dashboard');
const { createApp } = require('../routes');
const { conversationCommand } = require('../host-link');
const { tempDir, cleanupTempDirs, script, waitFor } = require('./fixtures');

after(() => cleanupTempDirs());

const COLLECTOR_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'collector', 'collector.py'), 'utf8');

function writeClaudeTranscript(home, sessionId, lines) {
  const dir = path.join(home, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}
const userLine = (text) => ({ type: 'user', timestamp: 't', message: { role: 'user', content: text } });
const assistantLine = (text) => ({ type: 'assistant', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text }] } });

async function withServer(hostOverrides, fn) {
  const dir = tempDir('sy-conv-');
  const home = tempDir('sy-conv-home-');
  const config = normalizeConfig({ pollSeconds: 0.2,
    hosts: [{ name: 'box', ssh: null, home, python: 'python3', ...hostOverrides }] });
  const state = new FleetState(['box']);
  const dashboard = new Dashboard(state, { stateFile: path.join(dir, 'dashboard.json') });
  const server = createApp(dashboard, { config, collectorSource: COLLECTOR_SOURCE }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ home, base, port });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

function findPids(needle) {
  try {
    return execSync(`pgrep -f ${JSON.stringify(needle)}`).toString().trim().split('\n').filter(Boolean).map(Number);
  } catch (err) {
    if (err.status === 1) return []; // pgrep: no process matched
    throw err;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

test('GET /api/conversation streams conv-hello, items, then conv-synced', () => withServer({}, async ({ home, base }) => {
  writeClaudeTranscript(home, 's-1', [userLine('hi'), assistantLine('hello')]);
  const ac = new AbortController();
  const res = await fetch(`${base}/api/conversation?host=box&key=${encodeURIComponent('claude:s-1')}`, { signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let text = '';
  const until = async (needle) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before seeing ${JSON.stringify(needle)}; got: ${text}`);
      text += new TextDecoder().decode(value);
    }
  };
  await until('"conv-synced"');
  assert.match(text, /conv-hello/);
  assert.match(text, /"hi"/);
  assert.match(text, /"hello"/);
  ac.abort();
}));

test('after the client disconnects, the collector process is gone', () => withServer({}, async ({ home, base }) => {
  writeClaudeTranscript(home, 's-2', [userLine('hi')]);
  const ac = new AbortController();
  const res = await fetch(`${base}/api/conversation?host=box&key=${encodeURIComponent('claude:s-2')}`, { signal: ac.signal });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('conv-synced')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before conv-synced; got: ${text}`);
    text += new TextDecoder().decode(value);
  }
  const pids = findPids(home);
  assert.ok(pids.length >= 1, 'the collector subprocess should be running');
  ac.abort();
  await waitFor(() => !pids.some(alive), 5000);
}));

test('unknown host gives 404', () => withServer({}, async ({ base }) => {
  const res = await fetch(`${base}/api/conversation?host=nope&key=claude:s-1`);
  assert.equal(res.status, 404);
  assert.equal(typeof (await res.json()).error, 'string');
}));

test('a bad key gives 400', () => withServer({}, async ({ base }) => {
  const res = await fetch(`${base}/api/conversation?host=box&key=${encodeURIComponent('nonsense key!')}`);
  assert.equal(res.status, 400);
  assert.equal(typeof (await res.json()).error, 'string');
}));

test('a missing key gives 400', () => withServer({}, async ({ base }) => {
  const res = await fetch(`${base}/api/conversation?host=box`);
  assert.equal(res.status, 400);
}));

test('the collector exiting non-zero sends a conv-error event, carrying its stderr', async () => {
  const dir = tempDir('sy-conv-');
  const home = tempDir('sy-conv-home-');
  const bin = tempDir('sy-conv-bin-');
  const failing = script(bin, 'crash', 'cat >/dev/null\necho "boom: collector crashed" >&2\nexit 3\n');
  const config = normalizeConfig({ pollSeconds: 0.2,
    hosts: [{ name: 'box', ssh: null, home, python: failing }] });
  const state = new FleetState(['box']);
  const dashboard = new Dashboard(state, { stateFile: path.join(dir, 'dashboard.json') });
  const server = createApp(dashboard, { config, collectorSource: COLLECTOR_SOURCE }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/conversation?host=box&key=claude:s-3`);
    const text = await res.text();
    assert.match(text, /conv-error/);
    assert.match(text, /boom: collector crashed/);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

// ── conversationCommand ──────────────────────────────────────────────────────

test('conversationCommand builds a local python3 command', () => {
  const config = normalizeConfig({ hosts: [{ name: 'a', ssh: null }] });
  const { cmd, args } = conversationCommand({ name: 'a', ssh: null, python: 'python3', home: null }, config, 'claude:abc');
  assert.equal(cmd, 'python3');
  assert.deepEqual(args, ['-', '--conversation', 'claude:abc', '--poll', '2']);
});

test('conversationCommand includes --home when the host sets one', () => {
  const config = normalizeConfig({ hosts: [{ name: 'a', ssh: null, home: '/home/u' }] });
  const { args } = conversationCommand({ name: 'a', ssh: null, python: 'python3', home: '/home/u' }, config, 'codex:xyz');
  assert.deepEqual(args, ['-', '--conversation', 'codex:xyz', '--poll', '2', '--home', '/home/u']);
});

test('conversationCommand builds the ssh-wrapped command, sharing the ssh options with commandFor', () => {
  const config = normalizeConfig({ hosts: [{ name: 'b', ssh: 'b', home: '/home/u' }] });
  const { cmd, args } = conversationCommand({ name: 'b', ssh: 'b', python: 'python3', home: '/home/u' }, config, 'codex:xyz');
  assert.equal(cmd, 'ssh');
  assert.ok(args.includes('BatchMode=yes') && args.includes('ServerAliveInterval=15'));
  assert.equal(args.at(-2), 'b');
  assert.equal(args.at(-1), "'python3' '-' '--conversation' 'codex:xyz' '--poll' '2' '--home' '/home/u'");
});
