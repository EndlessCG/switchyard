'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../layout');

const st = (id, status, blockedBy = []) => ({ id, title: `step ${id}`, status, blockedBy });
const dri = { agent: 'claude', steps: [st('1', 'done'), st('2', 'current', ['1']), st('3', 'pending', ['2']),
  st('4', 'pending', ['2']), st('5', 'pending', ['2']), st('6', 'pending', ['3', '4', '5']), st('7', 'pending', ['6'])] };

test('dependencies lay out as columns by depth and branch/merge edges', () => {
  assert.deepEqual(L.columns(dri).map((c) => c.map((t) => t.id)), [['1'], ['2'], ['3', '4', '5'], ['6'], ['7']]);
  assert.deepEqual(L.edges(dri), [['1', '2'], ['2', '3'], ['2', '4'], ['2', '5'], ['3', '6'], ['4', '6'], ['5', '6'], ['6', '7']]);
});

test('without declared dependencies, steps form a chain in order', () => {
  const codex = { agent: 'codex', steps: [st('1', 'done'), st('2', 'current'), st('3', 'pending')] };
  assert.deepEqual(L.columns(codex).map((c) => c.map((t) => t.id)), [['1'], ['2'], ['3']]);
  assert.deepEqual(L.edges(codex), [['1', '2'], ['2', '3']]);
  assert.equal(L.hasDeps(codex), false);
});

test('missing blockers are ignored and cycles do not hang', () => {
  const s = { agent: 'claude', steps: [st('1', 'pending', ['9']), st('2', 'pending', ['3']), st('3', 'pending', ['2'])] };
  assert.deepEqual(L.edges(s), [['3', '2'], ['2', '3']]);
  assert.equal(L.columns(s).flat().length, 3);
});

test('visible sessions: most recent N, then attention order', () => {
  const mk = (key, state, updatedAt) => ({ key, state, updatedAt });
  const list = [mk('a', 'done', 5), mk('b', 'error', 1), mk('c', 'working', 4), mk('d', 'waiting', 3), mk('e', 'idle', 2)];
  const top3 = L.visibleSessions(list, { filter: 'all', limit: 3 });
  assert.deepEqual(top3.shown.map((s) => s.key), ['d', 'c', 'a']);
  assert.equal(top3.total, 5);
  assert.deepEqual(L.visibleSessions(list, { filter: 'all', limit: 'all' }).shown.map((s) => s.key), ['b', 'd', 'c', 'e', 'a']);
  assert.deepEqual(L.visibleSessions(list, { filter: 'error', limit: 20 }), { shown: [list[1]], total: 1 });
  assert.deepEqual(L.stateCounts(list), { done: 1, error: 1, working: 1, waiting: 1, idle: 1 });
});

test('hostMode: online, offline (offline/error/reconnecting-with-error), connecting', () => {
  assert.equal(L.hostMode({ status: 'online', error: null }), 'online');
  assert.equal(L.hostMode({ status: 'offline', error: 'x' }), 'offline');
  assert.equal(L.hostMode({ status: 'error', error: 'x' }), 'offline');
  assert.equal(L.hostMode({ status: 'connecting', error: 'x' }), 'offline');
  assert.equal(L.hostMode({ status: 'connecting', error: null }), 'connecting');
});

test('relative times and home-relative paths', () => {
  const now = 1_000_000_000;
  assert.equal(L.relativeTime(now - 12_000, now), '12 s ago');
  assert.equal(L.relativeTime(now - 31 * 60_000, now), '31 min ago');
  assert.equal(L.relativeTime(now - 5 * 3_600_000, now), '5 h ago');
  assert.equal(L.relativeTime(now - 2 * 86_400_000, now), '2 d ago');
  assert.equal(L.relativeTime(null, now), 'unknown');
  assert.equal(L.displayPath('/home/u/proj', '/home/u'), '~/proj');
  assert.equal(L.displayPath('/home/u', '/home/u'), '~');
  assert.equal(L.displayPath('/home/user2/x', '/home/u'), '/home/user2/x');
  assert.equal(L.displayPath(null, '/home/u'), '');
});

// ── runs ────────────────────────────────────────────────────────────────────────

const aRun = (extra = {}) => ({ id: 'a', status: 'Running', done: 5, total: 10, updatedAt: 1000,
  mtime: 1, ...extra });

test('visibleRuns splits live from finished: live by start, finished newest first', () => {
  const list = [
    aRun({ id: 'old-live', startedAt: 10, updatedAt: 100 }),
    aRun({ id: 'done-new', finished: true, updatedAt: 900 }),
    aRun({ id: 'new-live', startedAt: 20, updatedAt: 800 }),
    aRun({ id: 'done-old', finished: true, updatedAt: 50 }),
  ];
  const { live, finished } = L.visibleRuns(list);
  assert.deepEqual(live.map((r) => r.id), ['old-live', 'new-live']);
  assert.deepEqual(finished.map((r) => r.id), ['done-new', 'done-old']);
});

test('visibleRuns moves runs that are no longer running in with the finished ones', () => {
  const { live, finished } = L.visibleRuns([aRun({ id: 'live', alive: true }),
    aRun({ id: 'unknown', alive: null }), aRun({ id: 'dead', alive: false, updatedAt: 500 }),
    aRun({ id: 'done', finished: true, alive: false, updatedAt: 900 })]);
  assert.deepEqual(live.map((r) => r.id), ['live', 'unknown']);
  assert.deepEqual(finished.map((r) => r.id), ['done', 'dead']);
});

test('visibleRuns keeps live runs in place when one reports progress', () => {
  const a = aRun({ id: 'a', startedAt: 10, updatedAt: 100 });
  const b = aRun({ id: 'b', startedAt: 20, updatedAt: 200 });
  assert.deepEqual(L.visibleRuns([a, b]).live.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(L.visibleRuns([{ ...a, updatedAt: 999 }, b]).live.map((r) => r.id), ['a', 'b']);
});

test('visibleRuns orders live runs without startedAt by id, after those with one', () => {
  const { live } = L.visibleRuns([aRun({ id: 'y', startedAt: undefined }),
    aRun({ id: 'x', startedAt: undefined }), aRun({ id: 'z', startedAt: 5 })]);
  assert.deepEqual(live.map((r) => r.id), ['z', 'x', 'y']);
});

test('visibleRuns falls back to mtime when a finished record has no updatedAt', () => {
  const { finished } = L.visibleRuns([aRun({ id: 'x', finished: true, updatedAt: undefined, mtime: 2 }),
    aRun({ id: 'y', finished: true, updatedAt: undefined, mtime: 5 })]);
  assert.deepEqual(finished.map((r) => r.id), ['y', 'x']);
});

test('gpuLabel groups by host, keeping the order given', () => {
  assert.equal(L.gpuLabel([0, 1, 4, 7], 'box3'), 'box3 GPU 0,1,4,7');
  assert.equal(L.gpuLabel([0, 1, 'box2:7'], 'box3'), 'box3 GPU 0,1 · box2 GPU 7');
  assert.equal(L.gpuLabel(['box2:7', 'box2:0', 3], 'box3'), 'box2 GPU 7,0 · box3 GPU 3');
  assert.equal(L.gpuLabel([], 'box3'), '');
  assert.equal(L.gpuLabel(undefined, 'box3'), '');
});

test('gpuLabel survives junk entries without losing the rest', () => {
  assert.equal(L.gpuLabel([0, {}, 'box2:', -1, '', null, 2], 'box3'), 'box3 GPU 0,box2:,-1,2');
  assert.equal(L.gpuLabel('not-a-list', 'box3'), '');
  assert.equal(L.gpuLabel([{ a: 1 }], 'box3'), '');
});

test('runProgress reports a clamped percent and the raw numbers', () => {
  assert.deepEqual(L.runProgress(aRun({ done: 7, total: 10, unit: 'steps' })),
    { percent: 70, text: '7/10 steps' });
  assert.equal(L.runProgress(aRun({ done: 11, total: 10 })).percent, 100);
  assert.equal(L.runProgress(aRun({ done: -3, total: 10 })).percent, 0);
});

test('runProgress has no percent without a usable total', () => {
  assert.deepEqual(L.runProgress(aRun({ done: 5, total: 0 })), { percent: null, text: '5' });
  assert.deepEqual(L.runProgress({ id: 'a', status: 'Waiting for 4 GPUs' }),
    { percent: null, text: '' });
  assert.equal(L.runProgress(aRun({ done: 5, total: 'ten' })).percent, null);
});

test('etaText distinguishes measured, reported, measuring and over', () => {
  assert.equal(L.etaText(aRun({ etaSeconds: 4320, etaSource: 'measured' })), 'eta 1h 12m');
  assert.equal(L.etaText(aRun({ etaSeconds: 1440, etaSource: 'reported' })), 'eta 24m (reported)');
  assert.equal(L.etaText(aRun()), 'measuring…');
  assert.equal(L.etaText(aRun({ finished: true, etaSeconds: 60, etaSource: 'measured' })), '');
  assert.equal(L.etaText({ id: 'a', status: 'Waiting for 4 GPUs' }), '');
});

test('durationText formats hours, minutes and seconds', () => {
  assert.equal(L.durationText(45), '45s');
  assert.equal(L.durationText(1440), '24m');
  assert.equal(L.durationText(4320), '1h 12m');
  assert.equal(L.durationText(0), '0s');
});

test('lastChange prefers advancedAt, then updatedAt, then mtime', () => {
  assert.deepEqual(L.lastChange(aRun({ advancedAt: 700 })), { at: 700, source: 'advanced' });
  // mtime beats the record's own updatedAt: a stale writer cannot forge the file's mtime.
  assert.deepEqual(L.lastChange(aRun({ advancedAt: null, updatedAt: 500, mtime: 2 })),
    { at: 2000, source: 'written' });
  assert.deepEqual(L.lastChange({ id: 'a', updatedAt: 500 }), { at: 500, source: 'written' });
  assert.deepEqual(L.lastChange({ id: 'a', mtime: 1760000000.5 }),
    { at: 1760000000500, source: 'written' });
  assert.deepEqual(L.lastChange({ id: 'a' }), { at: null, source: 'written' });
});
