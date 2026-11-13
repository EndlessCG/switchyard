'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tui = require('../tui');
const { visibleWidth } = require('../render');

const NOW = 1_800_000_000_000;
const host = (name, over = {}) => ({ name, status: 'online', error: null, errors: [], notes: [],
  info: { hostname: name, python: '3.11', home: '/home/u' }, lastSyncAt: NOW - 2000, ...over });
const step = (id, status, title) => ({ id, status, title, activeForm: null, blockedBy: [], blocks: [], updatedAt: NOW });
const session = (key, over = {}) => ({ host: 'box3', key, agent: 'claude', id: key, name: key, cwd: '/home/u/proj',
  kind: 'interactive', tmuxPane: '1:1.1', state: 'idle', waitingFor: null, error: null, updatedAt: NOW - 60_000,
  steps: [], ...over });
const run = (id, over = {}) => ({ host: 'box3', id, label: id, status: 'Running', done: 5, total: 10, unit: 'steps',
  gpus: [0], alive: true, finished: false, updatedAt: NOW - 1000, ...over });
// Most tests drive the sessions table; the view opens on runs.
const S = (opts) => ({ ...tui.initialState(opts), view: 'sessions' });
const screenOpts = (over = {}) => ({ width: 100, height: 20, now: NOW, color: false, source: 'test', measuring: true,
  notes: null, error: null, ...over });

const snap = {
  hosts: [host('box3'), host('box1', { status: 'offline', error: 'ssh: no route to host' })],
  sessions: [
    session('a', { name: 'old idle', updatedAt: NOW - 9e6 }),
    session('b', { name: 'busy one', state: 'working', steps: [step('1', 'done', 'Plan'), step('2', 'current', 'Train'), step('3', 'pending', 'Eval')] }),
    session('c', { name: 'needs me', state: 'waiting', waitingFor: 'input needed' }),
  ],
  runs: [run('r1'), run('r2', { finished: true, alive: false }), run('r3', { alive: false })],
};

test('parseKeys splits a chunk into named keys', () => {
  assert.deepStrictEqual(tui.parseKeys('\x1b[A\x1b[Bjk\r\t\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b\x7f\x03q'),
    ['up', 'down', 'j', 'k', 'enter', 'tab', 'pgup', 'pgdn', 'home', 'end', 'esc', 'backspace', 'ctrl-c', 'q']);
  assert.deepStrictEqual(tui.parseKeys('\x1bOA'), ['up']);
});

test('sessions: the ones that want a look first, the rest collapsed behind one row', () => {
  const st = S();
  assert.deepStrictEqual(tui.sessionRows(snap, st).map((r) => r.id), ['box3|c', 'box3|b', 'group|sessions']);
  const group = tui.sessionRows(snap, st)[2].group;
  assert.deepStrictEqual([group.count, group.parts, group.open], [1, ['1 idle', 'no hub, so not active'], false]);
  const open = { ...st, expanded: { sessions: true, runs: false } };
  assert.deepStrictEqual(tui.sessionRows(snap, open).map((r) => r.id), ['box3|c', 'box3|b', 'group|sessions', 'box3|a']);
  assert.deepStrictEqual(tui.sessionRows(snap, { ...st, filter: 'idle' }).map((r) => r.id), ['box3|a'], 'a chosen state shows them all');
  assert.deepStrictEqual(tui.sessionRows(snap, { ...st, sort: 'updated' }).map((r) => r.id), ['box3|b', 'box3|c', 'group|sessions']);
  assert.deepStrictEqual(tui.sessionRows(snap, { ...st, query: 'TRAIN' }).map((r) => r.id), ['box3|b'], 'search covers step titles');
  assert.deepStrictEqual(tui.sessionRows(snap, { ...st, query: 'old' }).map((r) => r.id), ['group|sessions', 'box3|a'],
    'a search opens the collapsed rows');
});

test('with a hub, the sessions are the hub\'s own list: nothing more is collapsed', () => {
  const st = S({ collapseInactive: false });
  assert.deepStrictEqual(tui.sessionRows(snap, st).map((r) => r.id), ['box3|c', 'box3|b', 'box3|a']);
});

test('runs as on the page: running ones in start order; finished and gone ones collapsed as "not running"', () => {
  const st = S();
  const runs = { ...snap, runs: [run('late', { startedAt: 20, updatedAt: NOW - 1 }), run('early', { startedAt: 10, updatedAt: NOW - 9000 }),
    run('fin', { finished: true, alive: false, updatedAt: NOW - 500 }), run('gone', { alive: false, updatedAt: NOW - 100 })] };
  assert.deepStrictEqual(tui.runRows(runs, st).map((r) => r.id), ['box3|early', 'box3|late', 'group|runs']);
  assert.deepStrictEqual(tui.runRows(runs, st)[2].group.count, 2);
  assert.deepStrictEqual(tui.runRows(runs, S({ allRuns: true })).map((r) => r.id),
    ['box3|early', 'box3|late', 'group|runs', 'box3|gone', 'box3|fin']);
});

test('Enter on the collapsed row opens it, and closes it again; a does it from anywhere', () => {
  let st = S();
  let rows = tui.rowsFor(snap, st);
  st = tui.handleKey(st, 'G', rows, 10);
  st = tui.handleKey(st, 'enter', rows, 10);
  assert.strictEqual(st.expanded.sessions, true);
  assert.strictEqual(st.detail, false, 'Enter on the group does not open details');
  rows = tui.rowsFor(snap, st);
  assert.strictEqual(rows.length, 4);
  st = tui.handleKey(st, 'enter', rows, 10);
  assert.strictEqual(st.expanded.sessions, false);
  st = tui.handleKey(tui.handleKey(st, 'tab', rows, 10), 'a', rows, 10);
  assert.deepStrictEqual(st.expanded, { sessions: false, runs: true });
});

test('moving keeps the selection by id, so a refresh that reorders rows keeps the same row selected', () => {
  let st = S({ allSessions: true });
  let rows = tui.rowsFor(snap, st);
  st = tui.handleKey(st, 'down', rows, 10);
  assert.strictEqual(st.selKey.sessions, 'box3|b');
  // b becomes idle and older: it moves to the end, and is still the one selected
  const later = { ...snap, sessions: snap.sessions.map((s) => (s.key === 'b' ? { ...s, state: 'idle', updatedAt: NOW - 1e7 } : s)) };
  rows = tui.rowsFor(later, st);
  assert.strictEqual(rows[tui.selectedIndex(rows, st)].s.key, 'b');
  st = tui.handleKey(st, 'G', rows, 10);
  assert.strictEqual(st.selKey.sessions, rows[rows.length - 1].id);
  st = tui.handleKey(st, 'down', rows, 10);
  assert.strictEqual(st.selKey.sessions, rows[rows.length - 1].id, 'clamped at the end');
});

test('keys switch views, cycle filter and sort, toggle details and all runs, and quit', () => {
  assert.strictEqual(tui.initialState().view, 'runs', 'opens on runs');
  let st = S();
  st = tui.handleKey(st, 'tab', [], 10);
  assert.strictEqual(st.view, 'runs');
  st = tui.handleKey(st, 'f', [], 10);
  assert.strictEqual(st.filter, 'working');
  assert.strictEqual(st.view, 'sessions', 'filtering shows the sessions');
  assert.strictEqual(tui.handleKey(st, 'F', [], 10).filter, 'all');
  assert.strictEqual(tui.handleKey(st, 's', [], 10).sort, 'updated');
  assert.strictEqual(tui.handleKey(st, 'enter', [], 10).detail, true);
  assert.strictEqual(tui.handleKey(st, 'q', [], 10), null);
  assert.strictEqual(tui.handleKey(st, 'ctrl-c', [], 10), null);
});

test('search mode takes typed text until Enter; Esc clears it', () => {
  let st = tui.handleKey(S(), '/', [], 10);
  for (const k of ['g', 'r', 'p', 'x', 'backspace', 'o']) st = tui.handleKey(st, k, [], 10);
  assert.strictEqual(st.query, 'grpo');
  assert.strictEqual(tui.handleKey(st, 'q', [], 10).query, 'grpoq', 'q is text while searching, not quit');
  st = tui.handleKey(st, 'enter', [], 10);
  assert.strictEqual(st.searching, false);
  assert.strictEqual(st.query, 'grpo');
  st = tui.handleKey(tui.handleKey(st, '/', [], 10), 'esc', [], 10);
  assert.strictEqual(st.query, '');
});

test('a frame is exactly the screen: height lines, none wider than the width', () => {
  for (const [width, height] of [[100, 20], [60, 12], [200, 50]]) {
    for (const over of [{}, { detail: true }, { view: 'runs', detail: true }, { help: true },
      { detail: true, expanded: { sessions: true, runs: true } }]) {
      const { lines } = tui.screen(snap, { ...S(), ...over }, screenOpts({ width, height }));
      assert.strictEqual(lines.length, height, `${width}x${height} ${JSON.stringify(over)}`);
      for (const l of lines) assert.ok(visibleWidth(l) <= width, `too wide: ${l}`);
    }
  }
});

test('the frame shows hosts, the selected row, and its details', () => {
  const st = { ...S(), detail: true };
  const text = tui.screen(snap, st, screenOpts()).lines.join('\n');
  assert.match(text, /● box3 +synced 2s {2}│ 1 waiting 1 working 1 idle {2}│ 1 run running on GPU 0/);
  assert.match(text, /● box1 +offline {2}ssh: no route to host/);
  assert.match(text, /▶ box3 +claude ◐ Waiting on you/);
  assert.match(text, /Claude is waiting: input needed/);
  assert.match(text, /1 Sessions 2 active · \+1 more/);
  assert.match(text, /2 Runs 1 running · \+2 not running/);
  assert.match(text, /▸ 1 more: 1 idle · no hub, so not active {2}\(Enter or a to show\)/);
});

test('the table scrolls to keep the selection on screen', () => {
  const many = { hosts: [host('box3')], runs: [], sessions: Array.from({ length: 50 }, (_, i) => session(`s${i}`, { state: 'working', updatedAt: NOW - i * 1000 })) };
  let st = S();
  const rows = tui.rowsFor(many, st);
  st = tui.handleKey(st, 'G', rows, 10);
  const frame = tui.screen(many, st, screenOpts({ height: 15 }));
  assert.ok(frame.scrollTop > 0);
  assert.ok(frame.lines.some((l) => l.startsWith('▶ ') && l.includes('s49')));
  assert.ok(frame.lines.some((l) => /\d+-50\/50/.test(l)), 'position shown');
});

test('nothing is shown in inverse video: the selected row and the current tab are marked with an arrow', () => {
  for (const over of [{}, { view: 'runs' }, { detail: true }, { confirm: { type: 'delete-run', run: run('r1', { dir: '/x' }) } }]) {
    const { lines } = tui.screen(snap, { ...S(), ...over }, screenOpts({ color: true }));
    assert.ok(lines.every((l) => !l.includes('\x1b[7m')), JSON.stringify(over));
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(plain.some((l) => l.startsWith('▶ ')), 'selected row has the arrow');
    assert.ok(plain.some((l) => /▶ [12] (Sessions|Runs)/.test(l)), 'current tab has the arrow');
  }
});
