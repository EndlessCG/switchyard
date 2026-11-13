'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FleetState, ProtocolError } = require('../state');

const HELLO = { type: 'hello', protocol: 2, python: '3.10.12', hostname: 'box3.example', home: '/home/u',
  claude: { path: '/c', version: '2.1.271' }, codex: null, notes: [] };
const step = (id, status, extra = {}) => ({ id, title: `step ${id}`, status, blockedBy: [], blocks: [],
  description: '', activeForm: null, updatedAt: 1757890000000, ...extra });
const claudeSession = (id, steps, updatedAt = 1757890000000) => ({ key: `claude:${id}`, agent: 'claude', id,
  name: 'demo-sess', cwd: '/home/u/proj', gitBranch: null, state: 'working', updatedAt, steps,
  stepsSource: steps.length ? 'claude-tasks' : null });

function collect(state) {
  const events = [];
  for (const e of ['host', 'session', 'removed', 'reset', 'tick']) state.on(e, (...a) => events.push([e, ...a]));
  return events;
}

test('hello marks the host online and clears sessions from an earlier connection', () => {
  const s = new FleetState(['box3']);
  s.apply('box3', { type: 'session', session: claudeSession('old', []) });
  const events = collect(s);
  s.apply('box3', HELLO, 42);
  const h = s.hostView('box3');
  assert.equal(h.status, 'online');
  assert.equal(h.info.hostname, 'box3.example');
  assert.equal(h.sessionCount, 0);
  assert.equal(h.lastSyncAt, 42);
  assert.deepEqual(events.map((e) => e[0]), ['reset', 'host']);
});

test('sessions, removals and errors flow into the snapshot', () => {
  const s = new FleetState(['box3', 'box1']);
  s.apply('box3', HELLO);
  s.apply('box3', { type: 'session', session: claudeSession('a', [step('1', 'done')]) });
  s.apply('box3', { type: 'session', session: claudeSession('b', []) });
  s.apply('box3', { type: 'removed', key: 'claude:b' });
  s.apply('box3', { type: 'errors', errors: [{ source: 'tmux', message: 'x', count: 1 }] });
  const snap = s.snapshot();
  assert.deepEqual(snap.sessions.map((x) => [x.host, x.key]), [['box3', 'claude:a']]);
  assert.equal(snap.hosts.find((h) => h.name === 'box1').status, 'connecting');
  assert.equal(snap.hosts.find((h) => h.name === 'box3').errors[0].source, 'tmux');
});

test('tick refreshes lastSyncAt', () => {
  const s = new FleetState(['box3']);
  s.apply('box3', HELLO, 1);
  const events = collect(s);
  s.apply('box3', { type: 'tick' }, 99);
  assert.equal(s.hostView('box3').lastSyncAt, 99);
  assert.deepEqual(events, [['tick', 'box3', 99]]);
});

test('unknown messages and protocols are errors, not ignored', () => {
  const s = new FleetState(['box3']);
  assert.throws(() => s.apply('box3', { type: 'bogus' }), /unknown message type "bogus"/);
  assert.throws(() => s.apply('box3', { type: 'bogus' }), ProtocolError);
  assert.throws(() => s.apply('box3', { ...HELLO, protocol: 3 }), /protocol 3/);
  assert.throws(() => s.apply('box3', { ...HELLO, protocol: 1 }), ProtocolError);
  assert.throws(() => s.apply('box3', null), ProtocolError);
  assert.throws(() => s.apply('box3', { type: 'session' }), ProtocolError);
  assert.throws(() => s.apply('box3', { type: 'removed' }), ProtocolError);
  assert.throws(() => s.apply('box3', { type: 'errors', errors: 'x' }), ProtocolError);
  assert.throws(() => s.apply('nope', HELLO), /unknown host nope/);
  assert.throws(() => s.apply('nope', HELLO), (err) => !(err instanceof ProtocolError));
});

test('board adapters expose Claude task sessions in upstream shapes', () => {
  const s = new FleetState(['box3']);
  s.apply('box3', HELLO);
  s.apply('box3', { type: 'session', session: claudeSession('a', [step('1', 'done'), step('2', 'current', { blockedBy: ['1'] }), step('3', 'pending')], 2000) });
  s.apply('box3', { type: 'session', session: claudeSession('b', [step('1', 'pending')], 1000) });
  s.apply('box3', { type: 'session', session: { ...claudeSession('c', []), key: 'codex:c', agent: 'codex', stepsSource: 'codex-update_plan', steps: [step('1', 'done')] } });
  const sessions = s.boardSessions(null);
  assert.deepEqual(sessions.map((x) => x.id), ['box3~a', 'box3~b']);
  assert.deepEqual([sessions[0].completed, sessions[0].inProgress, sessions[0].pending, sessions[0].taskCount], [1, 1, 1, 3]);
  assert.equal(sessions[0].project, 'box3:/home/u/proj');
  assert.equal(s.boardSessions(1).length, 1);
  const tasks = s.boardTasks('box3~a');
  assert.deepEqual(tasks.map((t) => [t.id, t.status]), [['1', 'completed'], ['2', 'in_progress'], ['3', 'pending']]);
  assert.deepEqual(tasks[1].blockedBy, ['1']);
  assert.equal(tasks[0].createdAt, tasks[0].updatedAt);
  assert.equal(s.boardTasks('box3~missing'), null);
  assert.equal(s.boardTasks('nohost~a'), null);
  const all = s.allBoardTasks();
  assert.equal(all.length, 4);
  assert.equal(all[0].sessionId.startsWith('box3~'), true);
});

const run = (id, extra = {}) => ({ id, label: `run ${id}`, status: 'Running', done: 1, total: 10,
  gpus: [0], pid: 4242, mtime: 1760000000.5, alive: true, dir: '/r', ...extra });

test('runs are stored per host, re-sent on change and removed', () => {
  const s = new FleetState(['box3']);
  s.apply('box3', HELLO);
  const events = [];
  for (const e of ['run', 'run-removed']) s.on(e, (...a) => events.push([e, ...a]));
  s.apply('box3', { type: 'run', run: run('a') });
  s.apply('box3', { type: 'run', run: run('a', { done: 2 }) });
  assert.deepEqual(s.snapshot().runs.map((r) => [r.host, r.id, r.done]), [['box3', 'a', 2]]);
  s.apply('box3', { type: 'run-removed', id: 'a' });
  assert.deepEqual(s.snapshot().runs, []);
  assert.deepEqual(events.map(([e, , x]) => [e, typeof x === 'string' ? x : x.id]),
    [['run', 'a'], ['run', 'a'], ['run-removed', 'a']]);
});

test('hello clears a host\'s runs', () => {
  const s = new FleetState(['box3']);
  s.apply('box3', HELLO);
  s.apply('box3', { type: 'run', run: run('a') });
  s.apply('box3', HELLO);
  assert.deepEqual(s.snapshot().runs, []);
});

test('a run with junk fields is accepted; one without a string id is not', () => {
  const s = new FleetState(['box3']);
  s.apply('box3', HELLO);
  s.apply('box3', { type: 'run', run: { id: 'a', status: { weird: true }, done: 'lots', extra: 1 } });
  assert.equal(s.snapshot().runs.length, 1); // record contents are the collector's business, not ours
  assert.throws(() => s.apply('box3', { type: 'run', run: {} }), ProtocolError);
  assert.throws(() => s.apply('box3', { type: 'run' }), ProtocolError);
  assert.throws(() => s.apply('box3', { type: 'run-removed', id: 7 }), ProtocolError);
});
