'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FleetState } = require('../state');
const { Dashboard } = require('../dashboard');
const { StepLog, StepLogError } = require('../step-log');
const { Notes, NotesFileError } = require('../notes');
const { createApp } = require('../routes');
const { normalizeConfig } = require('../config');
const { tempDir, cleanupTempDirs } = require('./fixtures');

after(() => cleanupTempDirs());

const HELLO = { type: 'hello', protocol: 2, python: '3.10', hostname: 'box3', home: '/home/u',
  claude: null, codex: null, notes: [] };

const step = (id, status, title = `step ${id}`) => ({ id, title, status, blockedBy: [], blocks: [],
  description: '', activeForm: null, updatedAt: 1000 });

function sess(id, steps, extra = {}) {
  return { key: `claude:${id}`, agent: 'claude', id, name: `n-${id}`, cwd: '/w', gitBranch: null,
    kind: 'interactive', pid: 7, short: null, tmuxPane: null, state: 'working', waitingFor: null,
    error: null, goal: null, updatedAt: 1000, stepsSource: 'claude-tasks', steps, ...extra };
}

function setup({ stepLogFile = null } = {}) {
  const dir = tempDir('sy-th-');
  let t = 50_000;
  const now = () => t++;
  const state = new FleetState(['box3']);
  state.apply('box3', HELLO, now());
  const dash = new Dashboard(state, { stateFile: path.join(dir, 'dashboard.json'), stepLogFile, now });
  const put = (s) => state.apply('box3', { type: 'session', session: s });
  return { dir, state, dash, put };
}

// ── task history ────────────────────────────────────────────────────────────

test('a session keeps every task it has ever had, with the statuses each went through', () => {
  const { dash, put } = setup();
  put(sess('a', [step('1', 'current'), step('2', 'pending')]));
  put(sess('a', [step('1', 'done'), step('2', 'current'), step('3', 'pending')]));
  put(sess('a', [step('1', 'done'), step('3', 'pending')])); // task 2 deleted by the agent
  const tasks = dash.sessionSteps('box3', 'claude:a');
  assert.deepEqual(tasks.map((t) => [t.stepId, t.status, t.gone]),
    [['1', 'done', false], ['2', 'current', true], ['3', 'pending', false]]);
  assert.deepEqual(tasks[0].history.map((h) => h.status), ['current', 'done']);
  assert.equal(tasks[1].title, 'step 2'); // the deleted task keeps its title and last status
  assert.ok(tasks[0].firstSeenAt <= tasks[0].lastChangeAt);
});

test('a session re-sent unchanged records nothing new', () => {
  const { dash, put } = setup();
  const steps = [step('1', 'current')];
  put(sess('a', steps));
  put(sess('a', steps));
  put(sess('a', steps, { updatedAt: 9999 }));
  assert.equal(dash.stepLog.events.length, 1);
});

test('a renamed task is recorded, and tasks are kept per session', () => {
  const { dash, put } = setup();
  put(sess('a', [step('1', 'current', 'Write the tests')]));
  put(sess('a', [step('1', 'current', 'Write better tests')]));
  put(sess('b', [step('1', 'pending', 'Another session')]));
  const a = dash.sessionSteps('box3', 'claude:a');
  assert.equal(a.length, 1);
  assert.equal(a[0].title, 'Write better tests');
  assert.equal(a[0].history.length, 2);
  assert.deepEqual(dash.sessionSteps('box3', 'claude:b').map((t) => t.title), ['Another session']);
});

test('the task history is written as JSON Lines and reloaded after a restart', () => {
  const dir = tempDir('sy-th-file-');
  const file = path.join(dir, 'sub', 'task-history.jsonl'); // under a missing subdir
  const { put } = setup({ stepLogFile: file });
  put(sess('a', [step('1', 'pending')]));
  put(sess('a', [step('1', 'done')]));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => [e.id, e.stepId, e.from, e.status]),
    [[1, '1', null, 'pending'], [2, '1', 'pending', 'done']]);
  const again = new StepLog({ file });
  assert.deepEqual(again.forSession('box3', 'claude:a').map((t) => [t.stepId, t.status]), [['1', 'done']]);
  // What it already knows must not be recorded a second time after a restart.
  assert.deepEqual(again.observe('box3', 'claude:a', [{ id: '1', title: 'step 1', status: 'done' }], 1), []);
});

test('a corrupt task-history line names its line number', () => {
  const dir = tempDir('sy-th-bad-');
  const file = path.join(dir, 'task-history.jsonl');
  fs.writeFileSync(file, '{"nope": 1}\n');
  assert.throws(() => new StepLog({ file }), (err) => err instanceof StepLogError && /line 1/.test(err.message));
});

// ── notes ───────────────────────────────────────────────────────────────────

test('a note is saved, read back after a reload, and removed when blanked', () => {
  const dir = tempDir('sy-notes-');
  const file = path.join(dir, 'sub', 'notes.json');
  let t = 1000;
  const notes = new Notes({ file, now: () => t++ });
  assert.equal(notes.get('box3', 'claude:a'), null);
  assert.equal(notes.set('box3', 'claude:a', '  watch the GPU limit  ').text, 'watch the GPU limit');
  notes.set('box3', 'claude:b', 'second');
  const again = new Notes({ file });
  assert.equal(again.get('box3', 'claude:a').text, 'watch the GPU limit');
  assert.deepEqual(again.all().map((n) => [n.host, n.key, n.text]),
    [['box3', 'claude:a', 'watch the GPU limit'], ['box3', 'claude:b', 'second']]);
  assert.equal(again.set('box3', 'claude:a', '   '), null);
  assert.equal(new Notes({ file }).get('box3', 'claude:a'), null);
});

test('a notes file that is not JSON, or has the wrong shape, is reported and left alone', () => {
  const dir = tempDir('sy-notes-bad-');
  const file = path.join(dir, 'notes.json');
  fs.writeFileSync(file, '{oops');
  assert.throws(() => new Notes({ file }), (err) => err instanceof NotesFileError && /not valid JSON/.test(err.message));
  const wrong = JSON.stringify({ version: 1, notes: { 'box3|claude:a': { text: 5 } } });
  fs.writeFileSync(file, wrong);
  assert.throws(() => new Notes({ file }), (err) => err instanceof NotesFileError && /unexpected shape/.test(err.message));
  assert.equal(fs.readFileSync(file, 'utf8'), wrong);
});

test('stepLogFile and notesFile default next to stateFile, and can be set', () => {
  const base = { hosts: [{ name: 'a', ssh: null }], stateFile: '/srv/sy/dashboard.json' };
  const c = normalizeConfig(base);
  assert.equal(c.stepLogFile, '/srv/sy/task-history.jsonl');
  assert.equal(c.notesFile, '/srv/sy/notes.json');
  assert.equal(normalizeConfig({ ...base, notesFile: '/elsewhere/n.json' }).notesFile, '/elsewhere/n.json');
  assert.throws(() => normalizeConfig({ ...base, stepLogFile: '' }), /stepLogFile must be a non-empty string/);
});

// ── routes ──────────────────────────────────────────────────────────────────

async function withServer(fn) {
  const ctx = setup();
  const notes = new Notes({ file: path.join(ctx.dir, 'notes.json') });
  const server = createApp(ctx.dash, { notes }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ ...ctx, notes, base });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("GET /api/session-steps returns a session's task history and checks its arguments", () => withServer(async ({ put, base }) => {
  put(sess('a', [step('1', 'current')]));
  put(sess('a', [step('1', 'done')]));
  const { steps } = await (await fetch(`${base}/api/session-steps?host=box3&key=claude:a`)).json();
  assert.deepEqual(steps.map((t) => [t.stepId, t.status]), [['1', 'done']]);
  assert.equal((await fetch(`${base}/api/session-steps?host=box3`)).status, 400);
  assert.equal((await fetch(`${base}/api/session-steps?host=box3&key=nonsense`)).status, 400);
  const unknown = await (await fetch(`${base}/api/session-steps?host=box3&key=claude:zzz`)).json();
  assert.deepEqual(unknown.steps, []);
}));

test('notes are saved and read back over the API, and removed when blank', () => withServer(async ({ base, notes }) => {
  const post = (body) => fetch(`${base}/api/notes`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await (await post({ host: 'box3', key: 'claude:a', text: 'check the gpu limit' })).json();
  assert.equal(saved.note.text, 'check the gpu limit');
  const all = await (await fetch(`${base}/api/notes`)).json();
  assert.deepEqual(all.notes.map((n) => [n.host, n.key, n.text]), [['box3', 'claude:a', 'check the gpu limit']]);
  assert.equal((await (await post({ host: 'box3', key: 'claude:a', text: '' })).json()).note, null);
  assert.deepEqual((await (await fetch(`${base}/api/notes`)).json()).notes, []);
  assert.equal(notes.get('box3', 'claude:a'), null);
  assert.equal((await post({ host: 'box3', key: 'claude:a' })).status, 400);
}));

test('a note POST from another origin is refused', () => withServer(async ({ base }) => {
  const res = await fetch(`${base}/api/notes`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ host: 'box3', key: 'claude:a', text: 'x' }) });
  assert.equal(res.status, 403);
}));
