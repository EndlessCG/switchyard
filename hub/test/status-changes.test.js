'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FleetState } = require('../state');
const { Dashboard } = require('../dashboard');
const { StatusLog, StatusLogError } = require('../status-log');
const { createApp } = require('../routes');
const { normalizeConfig } = require('../config');
const { tempDir, cleanupTempDirs } = require('./fixtures');

after(() => cleanupTempDirs());

const HELLO = { type: 'hello', protocol: 2, python: '3.10', hostname: 'box3', home: '/home/u',
  claude: null, codex: null, notes: [] };

function sess(id, state, extra = {}) {
  return { key: `claude:${id}`, agent: 'claude', id, name: `n-${id}`, cwd: '/w', gitBranch: null,
    kind: 'interactive', pid: 7, short: null, tmuxPane: null, state, waitingFor: null, error: null,
    goal: null, updatedAt: 1000, stepsSource: null, steps: [], ...extra };
}

// One host, 'box3', already connected; the clock advances 1 ms per call.
function setup({ statusLogFile = null } = {}) {
  const dir = tempDir('sy-chg-');
  let t = 50_000;
  const now = () => t++;
  const state = new FleetState(['box3']);
  state.apply('box3', HELLO, now());
  const dash = new Dashboard(state, { stateFile: path.join(dir, 'dashboard.json'), statusLogFile, now });
  const seen = [];
  dash.on('status-change', (c) => seen.push(c));
  const put = (s) => state.apply('box3', { type: 'session', session: s });
  const tick = () => state.apply('box3', { type: 'tick' });
  const gone = (key) => state.apply('box3', { type: 'removed', key });
  return { state, dash, seen, put, tick, gone };
}
const moves = (list) => list.map((c) => [c.key, c.from, c.to]);

// ── recording ───────────────────────────────────────────────────────────────

test('sessions in the first snapshot are not changes; a later change of state is', () => {
  const { dash, seen, put, tick } = setup();
  put(sess('a', 'working'));
  put(sess('b', 'idle'));
  tick();
  assert.deepEqual(seen, []);
  put(sess('a', 'idle'));
  assert.deepEqual(moves(seen), [['claude:a', 'working', 'idle']]);
  const [c] = seen;
  assert.equal(c.id, 1);
  assert.equal(c.host, 'box3');
  assert.equal(c.agent, 'claude');
  assert.equal(c.name, 'n-a');
  assert.equal(c.reason, null);
  assert.equal(typeof c.at, 'number');
  assert.deepEqual(dash.statusChanges(0), [c]);
});

test('the same state again, including after a reconnect re-sends everything, is not a change', () => {
  const { state, seen, put, tick } = setup();
  put(sess('a', 'working'));
  tick();
  put(sess('a', 'working', { updatedAt: 2000 }));
  state.apply('box3', HELLO); // a reconnect: FleetState resets and the collector re-sends
  put(sess('a', 'working'));
  tick();
  assert.deepEqual(seen, []);
  put(sess('a', 'idle'));
  assert.deepEqual(moves(seen), [['claude:a', 'working', 'idle']]);
});

test('a session first seen after the first tick is recorded as new', () => {
  const { seen, put, tick } = setup();
  tick();
  put(sess('c', 'working'));
  assert.deepEqual(moves(seen), [['claude:c', null, 'working']]);
});

test('a session its host stops reporting is recorded, and if it comes back it is new again', () => {
  const { seen, put, tick, gone } = setup();
  put(sess('a', 'idle'));
  tick();
  gone('claude:a');
  put(sess('a', 'working'));
  assert.deepEqual(moves(seen), [['claude:a', 'idle', null], ['claude:a', null, 'working']]);
  assert.equal(seen[0].name, 'n-a');
});

test('waiting records the reason Claude gives, and error records the error text', () => {
  const { seen, put, tick } = setup();
  put(sess('a', 'working'));
  tick();
  put(sess('a', 'waiting', { waitingFor: 'input needed' }));
  put(sess('a', 'error', { error: 'boom' }));
  put(sess('a', 'idle'));
  assert.deepEqual(seen.map((c) => c.reason), ['input needed', 'boom', null]);
});

test('hidden sessions are recorded too', () => {
  const { dash, seen, put, tick } = setup();
  const old = sess('old', 'idle', { key: 'codex:old', agent: 'codex', pid: null, updatedAt: 1 });
  put(old);
  tick();
  put({ ...old, state: 'done' });
  assert.deepEqual(moves(seen), [['codex:old', 'idle', 'done']]);
  assert.equal(dash.snapshot().sessions.length, 0);
});

// ── the status file ─────────────────────────────────────────────────────────

test('changes are appended to the status file and read back after a restart', () => {
  const dir = tempDir('sy-chg-file-');
  const file = path.join(dir, 'sub', 'status-changes.jsonl'); // under a missing subdir, to exercise mkdir -p
  const { put, tick } = setup({ statusLogFile: file });
  put(sess('a', 'working'));
  tick();
  put(sess('a', 'idle'));
  put(sess('a', 'working'));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((c) => [c.id, c.from, c.to]), [[1, 'working', 'idle'], [2, 'idle', 'working']]);
  const again = new StatusLog({ file });
  assert.deepEqual(again.since(0).map((c) => c.id), [2, 1]);
  assert.deepEqual(again.since(lines[1].at).map((c) => c.id), [2]);
  const next = again.append({ at: lines[1].at + 1, host: 'box3', key: 'claude:a', agent: 'claude',
    name: 'n-a', from: 'working', to: 'idle', reason: null });
  assert.equal(next.id, 3);
});

test('a missing status file starts empty', () => {
  const dir = tempDir('sy-chg-none-');
  assert.deepEqual(new StatusLog({ file: path.join(dir, 'nope.jsonl') }).since(0), []);
});

test('a status file line that is not JSON is reported with its line number, and the file is left alone', () => {
  const dir = tempDir('sy-chg-bad-');
  const file = path.join(dir, 'status-changes.jsonl');
  const good = JSON.stringify({ id: 1, at: 5, host: 'h', key: 'claude:a', agent: 'claude', name: 'a',
    from: 'idle', to: 'working', reason: null });
  const text = `${good}\nnot json\n`;
  fs.writeFileSync(file, text);
  assert.throws(() => new StatusLog({ file }), (err) => err instanceof StatusLogError && /line 2/.test(err.message));
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('a status file line that is JSON but not a change is rejected', () => {
  const dir = tempDir('sy-chg-shape-');
  const file = path.join(dir, 'status-changes.jsonl');
  fs.writeFileSync(file, '{"at": 1}\n');
  assert.throws(() => new StatusLog({ file }), (err) => err instanceof StatusLogError && /line 1/.test(err.message));
});

test('statusLogFile defaults to status-changes.jsonl next to stateFile, and can be set', () => {
  const base = { hosts: [{ name: 'a', ssh: null }], stateFile: '/srv/sy/dashboard.json' };
  assert.equal(normalizeConfig(base).statusLogFile, '/srv/sy/status-changes.jsonl');
  assert.equal(normalizeConfig({ ...base, statusLogFile: '/elsewhere/log.jsonl' }).statusLogFile, '/elsewhere/log.jsonl');
  assert.throws(() => normalizeConfig({ ...base, statusLogFile: '' }), /statusLogFile must be a non-empty string/);
});

// ── routes ──────────────────────────────────────────────────────────────────

async function withServer(fn) {
  const ctx = setup();
  const server = createApp(ctx.dash).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ ...ctx, base });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// Reads `data:` events off an SSE response; each call resolves with the first event (seen so
// far or still to come) matching `pred`.
function sseReader(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  return async (pred) => {
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      const { value, done } = await reader.read();
      if (done) throw new Error('the event stream ended');
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
      }
    }
  };
}

test('GET /api/status-changes returns changes newest first, filtered by since', () => withServer(async ({ put, tick, base }) => {
  put(sess('a', 'working'));
  tick();
  put(sess('a', 'idle'));
  put(sess('a', 'working'));
  const all = await (await fetch(`${base}/api/status-changes`)).json();
  assert.deepEqual(all.changes.map((c) => [c.from, c.to]), [['idle', 'working'], ['working', 'idle']]);
  const recent = await (await fetch(`${base}/api/status-changes?since=${all.changes[0].at}`)).json();
  assert.deepEqual(recent.changes.map((c) => c.id), [all.changes[0].id]);
}));

test('a bad since gives 400', () => withServer(async ({ base }) => {
  for (const q of ['since=abc', 'since=-1', 'since=', 'since=1&since=2']) {
    const res = await fetch(`${base}/api/status-changes?${q}`);
    assert.equal(res.status, 400, q);
    assert.match((await res.json()).error, /since must be a time in epoch milliseconds/);
  }
}));

test('the event stream carries each status change as it happens', () => withServer(async ({ put, tick, base }) => {
  put(sess('a', 'working'));
  tick();
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const next = sseReader(res);
  await next((e) => e.type === 'connected');
  put(sess('a', 'waiting', { waitingFor: 'input needed' }));
  const ev = await next((e) => e.type === 'status-change');
  assert.deepEqual([ev.change.from, ev.change.to, ev.change.reason], ['working', 'waiting', 'input needed']);
  ac.abort();
}));
