'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tui = require('../tui');
const { deleteRun } = require('../../cli');
const { normalizeConfig } = require('../../hub/config');

const NOW = 1_800_000_000_000;
const run = (id, over = {}) => ({ host: 'box3', id, label: id, status: 'Running', done: 5, total: 10, unit: 'steps',
  gpus: [0], alive: true, finished: false, updatedAt: NOW - 1000, dir: '/home/u/.local/state/switchyard/runs', ...over });
const snap = { hosts: [{ name: 'box3', status: 'online', errors: [], notes: [], info: { home: '/home/u' }, lastSyncAt: NOW }],
  sessions: [], runs: [run('a', { startedAt: 1 }), run('b', { startedAt: 2 }), run('c', { startedAt: 3 })] };

test('d asks about the selected run; y hands back a delete and selects the next row; anything else keeps it', () => {
  let st = { ...tui.initialState(), view: 'runs' };
  const rows = tui.rowsFor(snap, st);
  st = tui.handleKey(st, 'down', rows, 10);
  st = tui.handleKey(st, 'd', rows, 10);
  assert.deepStrictEqual([st.confirm.type, st.confirm.run.id], ['delete-run', 'b']);
  const footer = tui.screen(snap, st, { width: 160, height: 20, now: NOW, color: false, source: 't', measuring: true }).lines.at(-1);
  assert.match(footer, /Delete b's record box3:\/home\/u\/\.local\/state\/switchyard\/runs\/b\.json\? It is still running/);
  const kept = tui.handleKey(st, 'n', rows, 10);
  assert.deepStrictEqual([kept.confirm, kept.pending, kept.message], [null, null, 'Kept it.']);
  assert.match(tui.screen(snap, kept, { width: 160, height: 20, now: NOW, color: false, source: 't', measuring: true }).lines.at(-1), /^Kept it\.$/);
  const yes = tui.handleKey(st, 'y', rows, 10);
  assert.deepStrictEqual([yes.pending.type, yes.pending.run.id], ['delete-run', 'b']);
  assert.strictEqual(yes.selKey.runs, 'box3|c', 'the next row is selected, so the table does not jump');
  const nothing = tui.handleKey({ ...tui.initialState(), view: 'sessions' }, 'd', [], 10);
  assert.strictEqual(nothing.confirm, null);
  assert.match(nothing.message, /select one first/);
});

test("deleteRun removes <dir>/<id>.json on the run's host, and says why when it cannot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-runs-'));
  try {
    const config = normalizeConfig({ hosts: [{ name: 'here', ssh: null }] });
    fs.writeFileSync(path.join(dir, 'grpo-r3.json'), '{}');
    fs.writeFileSync(path.join(dir, 'keep.json'), '{}');
    assert.strictEqual(await deleteRun(config, { host: 'here', id: 'grpo-r3', dir }), `here:${dir}/grpo-r3.json`);
    assert.deepStrictEqual(fs.readdirSync(dir), ['keep.json']);
    await assert.rejects(deleteRun(config, { host: 'here', id: 'grpo-r3', dir }), /FileNotFoundError/);
    await assert.rejects(deleteRun(config, { host: 'elsewhere', id: 'keep', dir }), /no hosts\.json entry for elsewhere/);
    await assert.rejects(deleteRun(config, { host: 'here', id: '../keep', dir }), /no usable record path/);
    await assert.rejects(deleteRun(config, { host: 'here', id: 'keep', dir: 'relative' }), /no usable record path/);
    await assert.rejects(deleteRun(null, { host: 'here', id: 'keep', dir }), /no hosts\.json entry/);
    assert.deepStrictEqual(fs.readdirSync(dir), ['keep.json'], 'nothing else was touched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const session = (key, over = {}) => ({ host: 'box3', key, agent: 'claude', id: key.split(':')[1], name: key, cwd: '/w',
  kind: null, short: null, pid: null, state: 'stopped', updatedAt: NOW, steps: [], ...over });

test('d on a session asks in words what will happen for its kind; a session in a terminal is refused', () => {
  const sessions = [
    session('codex:t-1', { agent: 'codex', kind: 'cli', name: 'old codex', state: 'waiting' }),
    session('claude:bg-1', { kind: 'background', short: 'c8a6c41b', name: 'bg', state: 'working' }),
    session('claude:ended-1', { name: 'ended', state: 'stopped' }),
    session('claude:tty-1', { kind: 'interactive', pid: 4242, name: 'in tmux', state: 'working' }),
  ];
  const data = { ...snap, sessions, runs: [] };
  const footer = (st) => tui.screen(data, st, { width: 200, height: 20, now: NOW, color: false, source: 't', measuring: true }).lines.at(-1);
  const ask = (key) => {
    const st = { ...tui.initialState({ allSessions: true }), view: 'sessions', selKey: { sessions: `box3|${key}`, runs: null } };
    return tui.handleKey(st, 'd', tui.rowsFor(data, st), 10);
  };
  assert.match(footer(ask('codex:t-1')), /^\[y\/n\] Archive Codex session "old codex" on box3 \(codex archive t-1; codex unarchive brings it back\)\?/);
  assert.match(footer(ask('claude:bg-1')), /Remove background session "bg" on box3 \(claude rm c8a6c41b; the conversation is kept\)/);
  assert.match(footer(ask('claude:ended-1')), /Delete the task list of "ended" on box3 \(~\/\.claude\/tasks\/ended-1; the conversation is kept\)/);
  const tty = ask('claude:tty-1');
  assert.strictEqual(tty.confirm, null);
  assert.match(tty.message, /in tmux is running in a terminal \(pid 4242\); quit it there/);
  assert.match(footer(tty), /in tmux is running in a terminal \(pid 4242\); quit it there/, 'the message reaches the screen');
  const st = ask('claude:bg-1');
  const yes = tui.handleKey(st, 'y', tui.rowsFor(data, st), 10);
  assert.deepStrictEqual([yes.pending.type, yes.pending.session.key], ['delete-session', 'claude:bg-1']);
  assert.notStrictEqual(yes.selKey.sessions, 'box3|claude:bg-1', 'the selection moves off the removed session');
});

test('deleteSession runs the collector on the host and reports what it did, or why not', async () => {
  const { deleteSession } = require('../../cli');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-home-'));
  try {
    const tasks = path.join(home, '.claude', 'tasks', 'ended-1');
    fs.mkdirSync(tasks, { recursive: true });
    fs.writeFileSync(path.join(tasks, '1.json'), '{}');
    // A claude that reports no live sessions, so ended-1 is an ended session.
    const fake = path.join(home, 'claude');
    fs.writeFileSync(fake, '#!/bin/sh\n[ "$1" = agents ] && echo "[]"\nexit 0\n', { mode: 0o755 });
    const config = normalizeConfig({ hosts: [{ name: 'here', ssh: null, home, claude: fake, codex: fake }] });
    const what = await deleteSession(config, { host: 'here', key: 'claude:ended-1' });
    assert.match(what, /deleted its task list/);
    assert.ok(!fs.existsSync(tasks));
    await assert.rejects(deleteSession(config, { host: 'here', key: 'claude:ended-1' }), /no task list here to delete/);
    await assert.rejects(deleteSession(config, { host: 'nowhere', key: 'claude:x' }), /no hosts\.json entry for nowhere/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
