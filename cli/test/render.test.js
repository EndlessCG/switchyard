'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { render, fit, visibleWidth, oneLine } = require('../render');
const { parseArgs, UsageError } = require('../../cli');

const NOW = 1_800_000_000_000;
const host = (over = {}) => ({ name: 'box3', status: 'online', error: null, errors: [], notes: [],
  info: { hostname: 'box3.example', python: '3.11', home: '/home/u' }, lastSyncAt: NOW - 2000, retryAt: null,
  sessionCount: 2, ...over });
const step = (id, status, title, over = {}) => ({ id, status, title, activeForm: null, blockedBy: [], blocks: [],
  updatedAt: NOW, ...over });
const session = (over = {}) => ({ host: 'box3', key: 'claude:a', agent: 'claude', id: 'a', name: 'grpo sweep',
  cwd: '/home/u/proj', gitBranch: null, kind: 'interactive', pid: 1, short: null, tmuxPane: '4:1.2',
  state: 'working', waitingFor: null, error: null, updatedAt: NOW - 60_000,
  steps: [step('1', 'done', 'Write config'), step('2', 'current', 'Train', { activeForm: 'Training round 3' }),
    step('3', 'pending', 'Evaluate', { blockedBy: ['2'] })], ...over });
const run = (over = {}) => ({ host: 'box3', id: 'r1', label: 'GRPO r3', status: 'Running', done: 50, total: 200,
  unit: 'steps', gpus: [0, 1], alive: true, finished: false, updatedAt: NOW - 5000, cwd: '/home/u/proj', ...over });
const opts = (over = {}) => ({ now: NOW, color: false, width: null, source: 'test', limit: 20, states: null,
  steps: false, allRuns: false, measuring: true, notes: null, ...over });

test('a session line says state, agent, name, where, and the current step', () => {
  const out = render({ hosts: [host()], sessions: [session()], runs: [] }, opts());
  assert.match(out, /● Working +claude grpo sweep {2}~\/proj · tmux 4:1\.2 · updated 1 min ago/);
  assert.match(out, /✓◉○ 1\/3 {2}now: Training round 3/);
  assert.match(out, /SESSIONS {2}1 working/);
  assert.doesNotMatch(out, /\x1b\[/, 'no color codes when color is off');
});

test('--steps lists every step with its dependencies', () => {
  const out = render({ hosts: [host()], sessions: [session()], runs: [] }, opts({ steps: true }));
  assert.match(out, /✓ #1 Write config/);
  assert.match(out, /◉ #2 Train/);
  assert.match(out, /○ #3 Evaluate {2}after #2/);
});

test('waiting reason, error and a note each get their own line', () => {
  const s = session({ state: 'waiting', waitingFor: 'input needed', error: 'boom' });
  const out = render({ hosts: [host()], sessions: [s], runs: [] },
    opts({ notes: { 'box3|claude:a': { text: 'check seed 2\nmore', updatedAt: NOW } } }));
  assert.match(out, /Claude is waiting: input needed/);
  assert.match(out, /\n {6}boom/);
  assert.match(out, /✎ check seed 2$/m);
});

test('runs as on the page: running ones listed; finished and gone ones counted as not running', () => {
  const runs = [run(), run({ id: 'r2', label: 'old', finished: true, alive: false }),
    run({ id: 'r3', label: 'crashed', alive: false })];
  const out = render({ hosts: [host()], sessions: [], runs }, opts({ measuring: false }));
  assert.match(out, /GRPO r3 {2}█████░+ {2}25% {2}Running/);
  assert.match(out, /50\/200 steps · box3 GPU 0,1 · written 5 s ago · ~\/proj/);
  assert.doesNotMatch(out, /crashed|old {2}/);
  assert.match(out, /▸ 2 not running \(--all-runs to show\)/);
  const all = render({ hosts: [host()], sessions: [], runs }, opts({ allRuns: true }));
  assert.match(all, /crashed/);
  assert.match(all, /no longer running/);
  assert.match(all, /old .*finished/);
});

test('"measuring…" only where the ETA will actually be measured', () => {
  const snap = { hosts: [host()], sessions: [], runs: [run()] };
  assert.match(render(snap, opts({ measuring: true })), /measuring…/);
  assert.doesNotMatch(render(snap, opts({ measuring: false })), /measuring/);
  const measured = { ...snap, runs: [run({ rate: 0.5, etaSeconds: 300, etaSource: 'measured' })] };
  assert.match(render(measured, opts({ measuring: false })), /0\.5 steps\/s · eta 5m/);
});

test('without a hub, idle, done and stopped sessions are counted, not listed, unless --all or --state', () => {
  const sessions = [session({ key: 'claude:a', name: 'old', state: 'idle', updatedAt: NOW - 9e6 }),
    session({ key: 'claude:b', name: 'new', state: 'done', updatedAt: NOW - 1000 }),
    session({ key: 'claude:c', name: 'busy', updatedAt: NOW - 5000 })];
  const out = render({ hosts: [host()], sessions, runs: [] }, opts({ collapseInactive: true }));
  assert.match(out, /busy/);
  assert.doesNotMatch(out, / new | old /);
  assert.match(out, /▸ 2 more: 1 idle · 1 done · no hub, so not active \(--all or --state to list\)/);
  const hub = render({ hosts: [host()], sessions, runs: [] }, opts({ collapseInactive: false }));
  assert.match(hub, / new /);
  assert.doesNotMatch(hub, /more:/);
  const all = render({ hosts: [host()], sessions, runs: [] }, opts({ limit: 'all' }));
  assert.match(all, /new/);
  assert.match(all, / old /);
  assert.doesNotMatch(all, /more:/);
  const two = render({ hosts: [host()], sessions, runs: [] }, opts({ limit: 'all', states: new Set(['idle', 'done', 'working']) }));
  assert.match(two, /old/);
  const working = render({ hosts: [host()], sessions, runs: [] }, opts({ states: new Set(['working']) }));
  assert.match(working, /busy/);
  assert.doesNotMatch(working, /new|old/);
});

test('an offline host shows why, and the hub\'s hidden count is mentioned', () => {
  const out = render({ hosts: [host({ status: 'offline', error: 'ssh: connect timed out' }),
    host({ name: 'box1', hiddenCount: 7, sessionCount: 0 })], sessions: [], runs: [] }, opts());
  assert.match(out, /Can't reach box3\./);
  assert.match(out, /ssh: connect timed out/);
  assert.match(out, /7 older hidden by the hub/);
  assert.match(out, /Nothing open here yet\./);
});

test('collector text cannot break a row onto several lines', () => {
  assert.strictEqual(oneLine('a\nb\tc\x1b[2J'), 'a b c [2J');
});

test('fit cuts to the screen width, counting wide characters and skipping color codes', () => {
  assert.strictEqual(fit('short', 10), 'short');
  assert.strictEqual(fit('abcdefghij', 6), 'abcde…');
  assert.strictEqual(fit('中文标题测试', 7), '中文标…');
  const colored = fit('ab\x1b[31mcdefgh\x1b[0m', 5);
  assert.strictEqual(visibleWidth(colored), 5);
  assert.ok(colored.endsWith('\x1b[0m'), 'a cut inside a color resets it');
  assert.strictEqual(fit('abcdefghij', null), 'abcdefghij');
});

test('parseArgs reads the flags and rejects bad ones', () => {
  const o = parseArgs(['--once', '--steps', '--state', 'working,waiting', '--limit', '3', '--all-runs']);
  assert.ok(o.once && o.steps && o.allRuns);
  assert.deepStrictEqual([...o.states], ['working', 'waiting']);
  assert.strictEqual(o.limit, 3);
  assert.strictEqual(parseArgs(['--all']).limit, 'all');
  assert.throws(() => parseArgs(['--state', 'sleepy']), UsageError);
  assert.throws(() => parseArgs(['--limit', '0']), UsageError);
  assert.throws(() => parseArgs(['--hub', 'http://x', '--local']), UsageError);
  assert.throws(() => parseArgs(['-w']), UsageError);
  assert.throws(() => parseArgs(['--bogus']), UsageError);
});
