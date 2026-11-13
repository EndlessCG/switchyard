'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { normalizeConfig } = require('../config');
const { FleetState, ProtocolError } = require('../state');
const { HostLink, commandFor, conversationCommand, shq, parseAndApply } = require('../host-link');
const { makeHome, script, waitFor, cleanupTempDirs } = require('./fixtures');

after(() => cleanupTempDirs());

function setup(hostOverrides, cfgOverrides = {}) {
  const f = makeHome();
  const config = normalizeConfig({ pollSeconds: 0.2, ...cfgOverrides,
    hosts: [{ name: 'box', ssh: null, claude: f.claude, codex: f.codex, home: f.home, ...hostOverrides(f) }] });
  const state = new FleetState(['box']);
  const timers = [];
  const link = new HostLink({ host: config.hosts[0], config, state,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  return { f, config, state, link, timers };
}

test('a local collector goes online and reports its sessions', async () => {
  const { state, link } = setup(() => ({}));
  link.start();
  try {
    await waitFor(() => state.snapshot().sessions.some((s) => s.key === 'claude:s-1'));
    const h = state.hostView('box');
    assert.equal(h.status, 'online');
    assert.equal(h.info.claude.version, '2.1.271 (Claude Code)');
    const s = state.snapshot().sessions.find((x) => x.key === 'claude:s-1');
    assert.deepEqual(s.steps.map((t) => t.status), ['done', 'current']);
    assert.equal(s.state, 'working');
  } finally {
    link.stop();
  }
});

test('a crashing collector shows its stderr and retries with backoff', async () => {
  const { state, link, timers } = setup((f) => ({ python: script(f.bin, 'crash', 'echo "boom: no module" >&2\nexit 3\n') }),
    { reconnect: { initialSeconds: 2, maxSeconds: 5 } });
  link.start();
  await waitFor(() => timers.length === 1);
  const h = state.hostView('box');
  assert.equal(h.status, 'error');
  assert.match(h.error, /boom: no module/);
  timers[0].fn();
  await waitFor(() => timers.length === 2);
  timers[1].fn();
  await waitFor(() => timers.length === 3);
  assert.deepEqual(timers.map((t) => t.ms), [2000, 4000, 5000]);
  link.stop();
});

test('ssh exit 255 means offline, with the ssh error text', async () => {
  const config = normalizeConfig({ hosts: [{ name: 'box1', ssh: 'box1' }] });
  const state = new FleetState(['box1']);
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push([cmd, args]);
    return spawn('sh', ['-c', 'echo "ssh: connect to host 10.136.20.192 port 2022: No route to host" >&2; exit 255'], opts);
  };
  const link = new HostLink({ host: config.hosts[0], config, state, spawnFn: fakeSpawn,
    setTimer: () => 1, clearTimer: () => {} });
  link.start();
  await waitFor(() => state.hostView('box1').status === 'offline');
  assert.match(state.hostView('box1').error, /No route to host/);
  const [cmd, args] = calls[0];
  assert.equal(cmd, 'ssh');
  assert.ok(args.includes('BatchMode=yes') && args.includes('ServerAliveInterval=15') && args.includes('ControlPersist=60'));
  assert.ok(args.includes('ConnectTimeout=45'));
  assert.equal(args.at(-2), 'box1');
  assert.equal(args.at(-1), "'python3' '-' '--stream' '--poll' '2'");
  link.stop();
});

test('an unreadable line stops the collector and is shown', async () => {
  const { state, link, timers } = setup((f) => ({ python: script(f.bin, 'garbage', 'cat >/dev/null\necho "Welcome to the cluster"\nsleep 30\n') }));
  link.start();
  await waitFor(() => timers.length === 1);
  assert.equal(state.hostView('box').status, 'error');
  assert.match(state.hostView('box').error, /can't use.*Welcome to the cluster/);
  link.stop();
});

test('stop() prevents any further restart', async () => {
  const { link, timers } = setup((f) => ({ python: script(f.bin, 'crash2', 'exit 1\n') }));
  link.start();
  link.stop();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(timers.length, 0);
});

test('shq quotes arguments with spaces and single quotes', () => {
  assert.equal(shq("/opt/my tools/it's"), `'/opt/my tools/it'\\''s'`);
  const { args } = commandFor({ name: 'a', ssh: 'a', python: 'python3', claude: '/x y/claude', codex: null, home: null },
    normalizeConfig({ hosts: [{ name: 'a', ssh: 'a' }] }));
  assert.equal(args.at(-1), "'python3' '-' '--stream' '--poll' '2' '--claude-bin' '/x y/claude'");
});

test('parseAndApply treats non-JSON as a protocol error', () => {
  const state = new FleetState(['box']);
  assert.throws(() => parseAndApply(state, 'box', 'Welcome to the cluster', Date.now()),
    (err) => err instanceof ProtocolError && err.message.startsWith('not JSON'));
});

test('parseAndApply lets a hub bug (not a protocol error) propagate', () => {
  const state = new FleetState(['box']);
  state.on('host', () => { throw new TypeError('listener bug'); });
  const hello = { type: 'hello', protocol: 2, python: '3', hostname: 'h', home: '/h', claude: null, codex: null, notes: [] };
  assert.throws(() => parseAndApply(state, 'box', JSON.stringify(hello), Date.now()),
    (err) => err instanceof TypeError && !(err instanceof ProtocolError));
});

test('commandFor passes one --runs-dir per configured directory', () => {
  const config = normalizeConfig({ hosts: [{ name: 'a', ssh: null, runsDir: ['/r1', '/r 2'] }] });
  const { args } = commandFor(config.hosts[0], config);
  assert.deepEqual(args, ['-', '--stream', '--poll', '2', '--runs-dir', '/r1', '--runs-dir', '/r 2']);
});

test('commandFor passes no --runs-dir when none are configured', () => {
  const config = normalizeConfig({ hosts: [{ name: 'a', ssh: null }] });
  assert.ok(!commandFor(config.hosts[0], config).args.includes('--runs-dir'));
});

test('conversationCommand passes no --runs-dir: a conversation stream reads no runs', () => {
  const config = normalizeConfig({ hosts: [{ name: 'a', ssh: null, runsDir: ['/r1'] }] });
  assert.ok(!conversationCommand(config.hosts[0], config, 'claude:x').args.includes('--runs-dir'));
});
