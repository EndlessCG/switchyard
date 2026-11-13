'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FleetState } = require('../state');
const { Dashboard, StateFileError, NotFoundError } = require('../dashboard');
const { tempDir, cleanupTempDirs } = require('./fixtures');

after(() => cleanupTempDirs());

function stateFileIn(dir) {
  return path.join(dir, 'sub', 'dashboard.json'); // under a missing subdir, to exercise mkdir -p
}

const step = (id, status) => ({ id, title: `step ${id}`, status, blockedBy: [], blocks: [],
  description: '', activeForm: null, updatedAt: 1000 });

function claudeSession(id, { pid = null, state = 'working', updatedAt = 1000, steps = [] } = {}) {
  return { key: `claude:${id}`, agent: 'claude', id, name: `n-${id}`, cwd: '/w', gitBranch: null,
    kind: 'interactive', pid, short: null, tmuxPane: null, state, error: null, goal: null,
    updatedAt, stepsSource: steps.length ? 'claude-tasks' : null, steps };
}

function codexSession(id, { state = 'working', updatedAt = 1000, steps = [] } = {}) {
  return { key: `codex:${id}`, agent: 'codex', id, name: `n-${id}`, cwd: '/w', gitBranch: null,
    kind: 'cli', pid: null, short: null, tmuxPane: null, state, error: null, goal: null,
    updatedAt, stepsSource: steps.length ? 'codex-update_plan' : null, steps };
}

const HELLO = { type: 'hello', protocol: 2, python: '3.10', hostname: 'box3', home: '/home/u',
  claude: null, codex: null, notes: [] };

function makeDash(dir, { now = () => 10_000 } = {}) {
  const state = new FleetState(['box3']);
  state.apply('box3', HELLO, now());
  const dash = new Dashboard(state, { stateFile: stateFileIn(dir), now });
  return { state, dash };
}

// A `now` that advances by 1 ms each call, so trackingSince (set from the first call, at
// Dashboard construction) is strictly earlier than anything observed afterwards.
function clock(start) {
  let t = start;
  return () => t++;
}

// ── 1. first start ──────────────────────────────────────────────────────────

test('first start creates the file with trackingSince = now and removed = {}', () => {
  const dir = tempDir('sy-dash-');
  const file = stateFileIn(dir);
  const { dash } = makeDash(dir, { now: () => 5000 });
  assert.equal(dash.trackingSince, 5000);
  assert.deepEqual([...dash.removed.entries()], []);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, { version: 1, trackingSince: 5000, removed: {}, added: {} });
});

// ── 2. basic visibility ─────────────────────────────────────────────────────

test('old session with no pid is hidden; a Claude session with a pid is visible; updated-after-tracking is visible', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: () => 10_000 });

  state.apply('box3', { type: 'session', session: codexSession('old', { updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);

  state.apply('box3', { type: 'session', session: claudeSession('running', { pid: 123, updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key).sort(), ['claude:running']);

  state.apply('box3', { type: 'session', session: codexSession('fresh', { updatedAt: 20_000 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key).sort(), ['claude:running', 'codex:fresh']);

  const h = dash.snapshot().hosts.find((x) => x.name === 'box3');
  assert.equal(h.sessionCount, 2);
  assert.equal(h.hiddenCount, 1);
});

// ── 3. becameWorking ─────────────────────────────────────────────────────────

test('an observed transition into working after trackingSince makes an old session visible', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: clock(10_000) });

  state.apply('box3', { type: 'session', session: codexSession('t', { state: 'idle', updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);

  state.apply('box3', { type: 'session', session: codexSession('t', { state: 'working', updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['codex:t']);
});

test('a key first seen already working with an old updatedAt stays hidden (crashed Codex thread)', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: () => 10_000 });

  state.apply('box3', { type: 'session', session: codexSession('crashed', { state: 'working', updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);

  // Re-sending the same state is not a transition, so it stays hidden.
  state.apply('box3', { type: 'session', session: codexSession('crashed', { state: 'working', updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);
});

test('a becameWorking transition observed before a reset still counts once the host re-sends its sessions', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: clock(10_000) });

  state.apply('box3', { type: 'session', session: codexSession('t', { state: 'idle', updatedAt: 1 }) });
  state.apply('box3', { type: 'session', session: codexSession('t', { state: 'working', updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['codex:t']);

  // A reconnect: FleetState clears its session map and Dashboard clears its per-host visible
  // set, but must NOT clear the in-memory becameWorkingAt bookkeeping.
  state.apply('box3', HELLO, 50_000);
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), [], 'nothing is visible again until re-sent');

  // The collector re-sends its sessions after a reconnect; this one is unchanged (same
  // updatedAt, still 'working', so no new transition is observed here).
  state.apply('box3', { type: 'session', session: codexSession('t', { state: 'working', updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['codex:t'],
    'the transition observed before the reset must still count');
});

// ── 4. remove ─────────────────────────────────────────────────────────────

test('remove hides a running Claude session, persists it, and it does not come back merely by staying up', () => {
  const dir = tempDir('sy-dash-');
  const file = stateFileIn(dir);
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 1, updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['claude:a']);

  dash.remove('box3', 'claude:a');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.removed['box3|claude:a'], 10_000);

  // Re-sent unchanged (still running, same updatedAt): stays hidden.
  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 1, updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);

  // A later update with newer updatedAt brings it back and clears the removed entry.
  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 1, updatedAt: 20_000 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['claude:a']);
  const onDisk2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('box3|claude:a' in onDisk2.removed, false);
});

test('a removed session comes back on an observed working transition after removedAt, even with unchanged updatedAt', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: clock(10_000) });

  // Hidden from the start: old updatedAt, no pid, no transition observed yet.
  state.apply('box3', { type: 'session', session: codexSession('t', { state: 'idle', updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);

  dash.remove('box3', 'codex:t');
  assert.equal(dash.removed.has('box3|codex:t'), true);

  // Same updatedAt as before (1, well before removedAt): only the observed transition into
  // 'working', timestamped after removedAt, explains it coming back.
  state.apply('box3', { type: 'session', session: codexSession('t', { state: 'working', updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['codex:t']);
  assert.equal(dash.removed.has('box3|codex:t'), false);
});

test('remove on an unknown host or session throws NotFoundError', () => {
  const dir = tempDir('sy-dash-');
  const { dash } = makeDash(dir);
  assert.throws(() => dash.remove('nope', 'claude:a'), NotFoundError);
  assert.throws(() => dash.remove('box3', 'claude:zzz'), NotFoundError);
});

test('a write failure during remove() leaves the in-memory removed set unchanged and propagates', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 1, updatedAt: 1 }) });

  // The stateFile's parent directory (created by mkdir -p on the first successful write) is
  // replaced with a plain file, so any further write's mkdirSync(..., {recursive:true}) fails
  // with EEXIST — deterministic on any user, unlike a chmod-based approach (which a root
  // process would simply ignore).
  const subdir = path.dirname(stateFileIn(dir));
  fs.rmSync(subdir, { recursive: true, force: true });
  fs.writeFileSync(subdir, '');

  assert.throws(() => dash.remove('box3', 'claude:a'), (err) => err.code === 'EEXIST');
  assert.deepEqual([...dash.removed.entries()], [], 'a failed persist must not have touched memory');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['claude:a'], 'the session must still be visible');
});

test('a write failure during restore() leaves the in-memory removed set unchanged and propagates', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 1, updatedAt: 1 }) });
  dash.remove('box3', 'claude:a');
  assert.equal(dash.removed.has('box3|claude:a'), true);

  const subdir = path.dirname(stateFileIn(dir));
  fs.rmSync(subdir, { recursive: true, force: true });
  fs.writeFileSync(subdir, '');

  assert.throws(() => dash.restore('box3', 'claude:a'), (err) => err.code === 'EEXIST');
  assert.equal(dash.removed.has('box3|claude:a'), true, 'a failed persist must not have touched memory');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), [], 'the session must still be hidden');
});

// ── 5. restore ────────────────────────────────────────────────────────────

test('restore brings back a removed session that is still active', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 1, updatedAt: 1 }) });
  dash.remove('box3', 'claude:a');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);

  dash.restore('box3', 'claude:a');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['claude:a']);
});

test('restore on an unknown session throws NotFoundError', () => {
  const dir = tempDir('sy-dash-');
  const { dash } = makeDash(dir);
  assert.throws(() => dash.restore('box3', 'claude:zzz'), NotFoundError);
});

// ── 6. restart ────────────────────────────────────────────────────────────

test('a new Dashboard on the same file keeps trackingSince and removed', () => {
  const dir = tempDir('sy-dash-');
  const file = stateFileIn(dir);
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 1, updatedAt: 1 }) });
  dash.remove('box3', 'claude:a');

  const state2 = new FleetState(['box3']);
  state2.apply('box3', HELLO, 99_999);
  const dash2 = new Dashboard(state2, { stateFile: file, now: () => 99_999 });
  assert.equal(dash2.trackingSince, 10_000);
  assert.equal(dash2.removed.get('box3|claude:a'), 10_000);
});

// ── 7. corrupt file ───────────────────────────────────────────────────────

test('a corrupt (non-JSON) file throws StateFileError naming the file', () => {
  const dir = tempDir('sy-dash-');
  const file = path.join(dir, 'dashboard.json'); // parent exists this time
  fs.writeFileSync(file, '{not json');
  const state = new FleetState(['box3']);
  assert.throws(() => new Dashboard(state, { stateFile: file, now: () => 1 }),
    (err) => err instanceof StateFileError && err.message.includes(file));
});

test('a file with the wrong shape throws StateFileError naming the file', () => {
  const dir = tempDir('sy-dash-');
  const file = path.join(dir, 'dashboard.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, trackingSince: 'nope' }));
  const state = new FleetState(['box3']);
  assert.throws(() => new Dashboard(state, { stateFile: file, now: () => 1 }),
    (err) => err instanceof StateFileError && err.message.includes(file));
});

test('a file with a non-numeric removed value throws StateFileError naming the file', () => {
  const dir = tempDir('sy-dash-');
  const file = path.join(dir, 'dashboard.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, trackingSince: 1, removed: { x: 'x' } }));
  const state = new FleetState(['box3']);
  assert.throws(() => new Dashboard(state, { stateFile: file, now: () => 1 }),
    (err) => err instanceof StateFileError && err.message.includes(file));
});

test('a file with a null removed value throws StateFileError naming the file', () => {
  const dir = tempDir('sy-dash-');
  const file = path.join(dir, 'dashboard.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, trackingSince: 1, removed: { x: null } }));
  const state = new FleetState(['box3']);
  assert.throws(() => new Dashboard(state, { stateFile: file, now: () => 1 }),
    (err) => err instanceof StateFileError && err.message.includes(file));
});

// ── 8. events ─────────────────────────────────────────────────────────────

function collect(dash) {
  const events = [];
  for (const e of ['host', 'session', 'removed', 'reset', 'tick']) dash.on(e, (...a) => events.push([e, ...a]));
  return events;
}

test('events: session/removed/reset flow through, with host views carrying correct sessionCount/hiddenCount', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  const events = collect(dash);

  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 1, updatedAt: 1 }) });
  state.apply('box3', { type: 'session', session: codexSession('old', { updatedAt: 1 }) }); // hidden

  const kinds = events.map((e) => e[0]);
  assert.deepEqual(kinds, ['session', 'host', 'host']);
  // First host view: 1 visible, 0 hidden. Second: 1 visible, 1 hidden (a new hidden session
  // still moves the total, so hiddenCount changes even though sessionCount doesn't).
  const hostViews = events.filter((e) => e[0] === 'host').map((e) => e[1]);
  assert.deepEqual(hostViews.map((h) => [h.sessionCount, h.hiddenCount]), [[1, 0], [1, 1]]);

  events.length = 0;
  state.apply('box3', { type: 'removed', key: 'claude:a' }); // the collector itself dropped it
  assert.deepEqual(events.map((e) => e[0]), ['removed', 'host']);
  assert.equal(events[0][1], 'box3');
  assert.equal(events[0][2], 'claude:a');
  const h2 = events[1][1];
  assert.deepEqual([h2.sessionCount, h2.hiddenCount], [0, 1]);

  events.length = 0;
  state.apply('box3', HELLO, 20_000); // reconnect: reset (visible count drops to 0, so a host
  // view follows it), then FleetState's own 'host' from going back online (another host view).
  assert.deepEqual(events.map((e) => e[0]), ['reset', 'host', 'host']);
});

test('tick is re-emitted unchanged', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir);
  const events = collect(dash);
  state.apply('box3', { type: 'tick' }, 555);
  assert.deepEqual(events, [['tick', 'box3', 555]]);
});

test('setMaxListeners works (inherited from EventEmitter)', () => {
  const dir = tempDir('sy-dash-');
  const { dash } = makeDash(dir);
  assert.equal(typeof dash.setMaxListeners, 'function');
  dash.setMaxListeners(0);
  assert.equal(dash.getMaxListeners(), 0);
});

// ── 10. add / hiddenSessions ─────────────────────────────────────────────

test('add makes a hidden, inactive session visible and it stays visible when re-sent unchanged; added is persisted and removed cleared', () => {
  const dir = tempDir('sy-dash-');
  const file = stateFileIn(dir);
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: codexSession('old', { updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);

  dash.add('box3', 'codex:old');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['codex:old']);
  assert.equal(dash.added.get('box3|codex:old'), 10_000);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.added['box3|codex:old'], 10_000);
  assert.equal('box3|codex:old' in onDisk.removed, false);

  // Re-sent unchanged: still no pid, no new updatedAt, no transition — stays visible because added.
  state.apply('box3', { type: 'session', session: codexSession('old', { updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['codex:old']);
});

test('remove on an added session hides it and moves it from added to removed in one save; undo restores it as added', () => {
  const dir = tempDir('sy-dash-');
  const file = stateFileIn(dir);
  const { state, dash } = makeDash(dir, { now: clock(10_000) });
  state.apply('box3', { type: 'session', session: codexSession('old', { updatedAt: 1 }) });
  dash.add('box3', 'codex:old');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['codex:old']);

  dash.remove('box3', 'codex:old');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), []);
  assert.equal(dash.added.has('box3|codex:old'), false);
  assert.equal(dash.removed.has('box3|codex:old'), true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('box3|codex:old' in onDisk.added, false);
  assert.equal(typeof onDisk.removed['box3|codex:old'], 'number');

  dash.restore('box3', 'codex:old');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['codex:old']);
  assert.equal(dash.removed.has('box3|codex:old'), false);
  assert.equal(typeof dash.added.get('box3|codex:old'), 'number');

  // Stays visible when re-sent unchanged (still inactive), because it's added again.
  state.apply('box3', { type: 'session', session: codexSession('old', { updatedAt: 1 }) });
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), ['codex:old']);
  const onDisk2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof onDisk2.added['box3|codex:old'], 'number');
});

test('a new Dashboard on the same file keeps added, and an added session is visible with no activity', () => {
  const dir = tempDir('sy-dash-');
  const file = stateFileIn(dir);
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: codexSession('old', { updatedAt: 1 }) });
  dash.add('box3', 'codex:old');

  const state2 = new FleetState(['box3']);
  state2.apply('box3', HELLO, 99_999);
  const dash2 = new Dashboard(state2, { stateFile: file, now: () => 99_999 });
  assert.equal(dash2.added.get('box3|codex:old'), 10_000);
  state2.apply('box3', { type: 'session', session: codexSession('old', { updatedAt: 1 }) });
  assert.deepEqual(dash2.snapshot().sessions.map((s) => s.key), ['codex:old']);
});

test('a file without "added" (old format) loads fine with added = {}', () => {
  const dir = tempDir('sy-dash-');
  const file = path.join(dir, 'dashboard.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, trackingSince: 5000, removed: {} }));
  const state = new FleetState(['box3']);
  const dash = new Dashboard(state, { stateFile: file, now: () => 1 });
  assert.deepEqual([...dash.added.entries()], []);
});

test('a file with a non-object "added" throws StateFileError naming the file', () => {
  const dir = tempDir('sy-dash-');
  const file = path.join(dir, 'dashboard.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, trackingSince: 1, removed: {}, added: 'nope' }));
  const state = new FleetState(['box3']);
  assert.throws(() => new Dashboard(state, { stateFile: file, now: () => 1 }),
    (err) => err instanceof StateFileError && err.message.includes(file));
});

test('a file with a non-finite value in "added" throws StateFileError naming the file', () => {
  const dir = tempDir('sy-dash-');
  const file = path.join(dir, 'dashboard.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, trackingSince: 1, removed: {}, added: { x: 'x' } }));
  const state = new FleetState(['box3']);
  assert.throws(() => new Dashboard(state, { stateFile: file, now: () => 1 }),
    (err) => err instanceof StateFileError && err.message.includes(file));
});

test('hiddenSessions lists exactly the non-visible sessions, newest first, with the removed flag', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: claudeSession('vis', { pid: 1, updatedAt: 5 }) }); // visible
  state.apply('box3', { type: 'session', session: codexSession('h1', { updatedAt: 3 }) }); // hidden
  state.apply('box3', { type: 'session', session: codexSession('h2', { updatedAt: 7, steps: [step('1', 'done'), step('2', 'pending')] }) }); // hidden, newer
  dash.remove('box3', 'claude:vis'); // now removed and hidden too

  const hidden = dash.hiddenSessions();
  assert.deepEqual(hidden.map((h) => h.key), ['codex:h2', 'claude:vis', 'codex:h1']);
  assert.equal(hidden.find((h) => h.key === 'claude:vis').removed, true);
  assert.equal(hidden.find((h) => h.key === 'codex:h1').removed, undefined);
  assert.deepEqual(hidden.find((h) => h.key === 'codex:h2'), {
    host: 'box3', key: 'codex:h2', id: 'h2', agent: 'codex', name: 'n-h2', cwd: '/w', kind: 'cli',
    state: 'working', updatedAt: 7, stepsTotal: 2, stepsDone: 1,
  });
});

test('add on an unknown host or session throws NotFoundError', () => {
  const dir = tempDir('sy-dash-');
  const { dash } = makeDash(dir);
  assert.throws(() => dash.add('nope', 'claude:a'), NotFoundError);
  assert.throws(() => dash.add('box3', 'claude:zzz'), NotFoundError);
});

test('a write failure during add() leaves the in-memory added/removed maps unchanged and propagates', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: codexSession('old', { updatedAt: 1 }) });

  const subdir = path.dirname(stateFileIn(dir));
  fs.rmSync(subdir, { recursive: true, force: true });
  fs.writeFileSync(subdir, '');

  assert.throws(() => dash.add('box3', 'codex:old'), (err) => err.code === 'EEXIST');
  assert.deepEqual([...dash.added.entries()], [], 'a failed persist must not have touched memory');
  assert.deepEqual(dash.snapshot().sessions.map((s) => s.key), [], 'the session must still be hidden');
});

// ── 9. board adapters ────────────────────────────────────────────────────

test('board adapters only include visible sessions', () => {
  const dir = tempDir('sy-dash-');
  const { state, dash } = makeDash(dir, { now: () => 10_000 });
  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 1, updatedAt: 1, steps: [step('1', 'done')] }) });
  state.apply('box3', { type: 'session', session: claudeSession('old', { pid: null, state: 'idle', updatedAt: 1, steps: [step('1', 'pending')] }) });

  const sessions = dash.boardSessions(null);
  assert.deepEqual(sessions.map((x) => x.id), ['box3~a']);
  assert.ok(dash.boardTasks('box3~a'));
  assert.equal(dash.boardTasks('box3~old'), null);
  const all = dash.allBoardTasks();
  assert.deepEqual(all.map((t) => t.sessionId), ['box3~a']);
});

const run = (id, extra = {}) => ({ id, label: `run ${id}`, status: 'Running', done: 1, total: 10,
  gpus: [0], pid: 4242, mtime: 1760000000.5, alive: true, dir: '/r', ...extra });

test('runs reach the snapshot without the opened-session filter, and change no counts', () => {
  const { state, dash } = makeDash(tempDir('sy-runs-'));
  state.apply('box3', { type: 'run', run: run('a') });
  const snap = dash.snapshot();
  assert.deepEqual(snap.runs.map((r) => [r.host, r.id]), [['box3', 'a']]);
  assert.equal(snap.hosts[0].sessionCount, 0);
  assert.equal(snap.hosts[0].hiddenCount, 0);
});

test('run and run-removed are re-emitted to the page', () => {
  const { state, dash } = makeDash(tempDir('sy-runs-'));
  const seen = [];
  dash.on('run', (host, r) => seen.push(['run', host, r.id]));
  dash.on('run-removed', (host, id) => seen.push(['run-removed', host, id]));
  state.apply('box3', { type: 'run', run: run('a') });
  state.apply('box3', { type: 'run-removed', id: 'a' });
  assert.deepEqual(seen, [['run', 'box3', 'a'], ['run-removed', 'box3', 'a']]);
});

test('a run stays on the page after its session is removed', () => {
  const { state, dash } = makeDash(tempDir('sy-runs-'));
  state.apply('box3', { type: 'session', session: claudeSession('a', { pid: 4242 }) });
  dash.remove('box3', 'claude:a');
  state.apply('box3', { type: 'run', run: run('r1', { session: 'claude:a' }) });
  assert.deepEqual(dash.snapshot().sessions, []);
  assert.deepEqual(dash.snapshot().runs.map((r) => r.id), ['r1']);
});

test('runs carry measured stats into the snapshot and into the event', () => {
  const { state, dash } = makeDash(tempDir('sy-runs-'), { now: clock(1000) });
  const seen = [];
  dash.on('run', (host, r) => seen.push(r));
  state.apply('box3', { type: 'run', run: run('a', { done: 0, total: 10 }) });
  state.apply('box3', { type: 'run', run: run('a', { done: 5, total: 10 }) });
  const snap = dash.snapshot().runs[0];
  assert.ok(snap.rate > 0, 'a rate was measured');
  assert.ok(snap.etaSeconds > 0, 'an ETA follows from it');
  assert.equal(snap.etaSource, 'measured');
  assert.ok(snap.advancedAt > 0, 'advancedAt was set when done moved');
  assert.equal(seen.at(-1).etaSource, 'measured', 'the page event is decorated too');
});

test('taking a snapshot records no samples', () => {
  const { state, dash } = makeDash(tempDir('sy-runs-'), { now: clock(1000) });
  state.apply('box3', { type: 'run', run: run('a', { done: 0, total: 10 }) });
  state.apply('box3', { type: 'run', run: run('a', { done: 5, total: 10 }) });
  const first = dash.snapshot().runs[0];
  dash.snapshot();
  dash.snapshot();
  const later = dash.snapshot().runs[0];
  assert.equal(later.rate, first.rate);
  assert.equal(later.advancedAt, first.advancedAt);
});

test('a reconnect does not lose a run\'s measured rate', () => {
  const { state, dash } = makeDash(tempDir('sy-runs-'), { now: clock(1000) });
  state.apply('box3', { type: 'run', run: run('a', { done: 0, total: 10 }) });
  state.apply('box3', { type: 'run', run: run('a', { done: 5, total: 10 }) });
  state.apply('box3', HELLO);                    // the collector restarted; runs were cleared
  assert.deepEqual(dash.snapshot().runs, []);
  state.apply('box3', { type: 'run', run: run('a', { done: 7, total: 10 }) });
  assert.ok(dash.snapshot().runs[0].rate > 0, 'the basis from before the gap still describes real work');
});

test('a removed run that comes back is measured afresh, not across the gap', () => {
  const { state, dash } = makeDash(tempDir('sy-runs-'), { now: clock(1000) });
  state.apply('box3', { type: 'run', run: run('a', { done: 0, total: 1000 }) });
  state.apply('box3', { type: 'run', run: run('a', { done: 500, total: 1000 }) });
  assert.ok(dash.snapshot().runs[0].rate > 0);
  state.apply('box3', { type: 'run-removed', id: 'a' });
  state.apply('box3', { type: 'run', run: run('a', { done: 600, total: 1000 }) });
  assert.equal(dash.snapshot().runs[0].rate, null,
    'a new run reusing the id must not inherit the old rate across a six-hour gap');
});
