'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeConfig, loadConfig, DEFAULTS, ConfigError } = require('../config');

test('ConfigError is exported and named correctly', () => {
  assert.equal(typeof ConfigError, 'function');
  assert.ok(new ConfigError('x') instanceof Error);
  assert.equal(new ConfigError('x').name, 'ConfigError');
});
const { tempDir, cleanupTempDirs } = require('./fixtures');

after(() => cleanupTempDirs());

const ok = { hosts: [{ name: 'box3', ssh: 'box3' }] };

test('fills in defaults', () => {
  const c = normalizeConfig(ok);
  assert.equal(c.port, DEFAULTS.port);
  assert.equal(c.pollSeconds, 2);
  assert.deepEqual(c.reconnect, { initialSeconds: 2, maxSeconds: 60 });
  assert.deepEqual(c.ssh, { serverAliveInterval: 15, serverAliveCountMax: 3, controlPersistSeconds: 60, connectTimeoutSeconds: 45 });
  assert.deepEqual(c.hosts, [{ name: 'box3', ssh: 'box3', claude: null, codex: null, home: null, python: 'python3', runsDirs: [] }]);
});

test('null claude/codex means detect, same as leaving them out', () => {
  const c = normalizeConfig({ hosts: [{ name: 'box1', ssh: 'box1', claude: null, codex: null }] });
  assert.equal(c.hosts[0].claude, null);
});

test('ssh: null runs on this machine; partial overrides keep other defaults', () => {
  const c = normalizeConfig({ reconnect: { maxSeconds: 10 }, hosts: [{ name: 'local', ssh: null }] });
  assert.equal(c.hosts[0].ssh, null);
  assert.deepEqual(c.reconnect, { initialSeconds: 2, maxSeconds: 10 });
});

// XDG_STATE_HOME may or may not be set in the environment running these tests; save/restore it
// around each test that depends on it so neither the environment nor test order leaks through.
function withXdgStateHome(value, fn) {
  const saved = process.env.XDG_STATE_HOME;
  if (value === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
  }
}

test('stateFile defaults to the XDG state location', () => withXdgStateHome(undefined, () => {
  const c = normalizeConfig(ok);
  assert.equal(c.stateFile, path.join(os.homedir(), '.local', 'state', 'switchyard', 'dashboard.json'));
}));

test('stateFile default honors XDG_STATE_HOME when set', () => withXdgStateHome('/custom/xdg-state', () => {
  const c = normalizeConfig(ok);
  assert.equal(c.stateFile, path.join('/custom/xdg-state', 'switchyard', 'dashboard.json'));
}));

test('stateFile can be overridden', () => {
  const c = normalizeConfig({ ...ok, stateFile: '/srv/switchyard/dashboard.json' });
  assert.equal(c.stateFile, '/srv/switchyard/dashboard.json');
});

test('rejects a non-string stateFile', () => {
  assert.throws(() => normalizeConfig({ ...ok, stateFile: 42 }), /stateFile must be a non-empty string/);
  assert.throws(() => normalizeConfig({ ...ok, stateFile: 42 }), ConfigError);
});

for (const [label, raw, msg] of [
  ['no hosts', { hosts: [] }, /hosts must be a non-empty array/],
  ['bad name', { hosts: [{ name: 'a~b', ssh: 'x' }] }, /name must match/],
  ['duplicate', { hosts: [{ name: 'a', ssh: 'x' }, { name: 'a', ssh: 'y' }] }, /used twice/],
  ['missing ssh', { hosts: [{ name: 'a' }] }, /ssh is required/],
  ['bad port', { port: 70000, hosts: [{ name: 'a', ssh: 'x' }] }, /port must be/],
  ['bad poll', { pollSeconds: 0, hosts: [{ name: 'a', ssh: 'x' }] }, /pollSeconds must be a positive number/],
  ['non-object reconnect', { reconnect: 'oops', hosts: [{ name: 'a', ssh: 'x' }] }, /reconnect must be an object/],
  ['non-object ssh', { ssh: [1], hosts: [{ name: 'a', ssh: 'x' }] }, /ssh must be an object/],
  ['zero connectTimeoutSeconds', { ssh: { connectTimeoutSeconds: 0 }, hosts: [{ name: 'a', ssh: 'x' }] }, /ssh\.connectTimeoutSeconds must be a positive number/],
]) {
  test(`rejects ${label}`, () => assert.throws(() => normalizeConfig(raw), msg));
  test(`rejects ${label} with a ConfigError`, () => assert.throws(() => normalizeConfig(raw), ConfigError));
}

test('loadConfig explains a missing file and bad JSON', () => {
  const dir = tempDir('sy-cfg-');
  assert.throws(() => loadConfig(path.join(dir, 'nope.json')), /No config at .*nope\.json/);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.throws(() => loadConfig(path.join(dir, 'bad.json')), /not valid JSON/);
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(ok));
  assert.equal(loadConfig(path.join(dir, 'good.json')).hosts[0].name, 'box3');
});

test('loadConfig errors are ConfigError, so the entry point can print just the message', () => {
  const dir = tempDir('sy-cfg-');
  assert.throws(() => loadConfig(path.join(dir, 'nope.json')), ConfigError);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.throws(() => loadConfig(path.join(dir, 'bad.json')), ConfigError);
});

test('runsDir accepts a string, a list, or nothing', () => {
  assert.deepEqual(normalizeConfig(ok).hosts[0].runsDirs, []);
  assert.deepEqual(normalizeConfig({ hosts: [{ name: 'box3', ssh: 'box3', runsDir: '/r1' }] }).hosts[0].runsDirs, ['/r1']);
  assert.deepEqual(normalizeConfig({ hosts: [{ name: 'box3', ssh: 'box3', runsDir: ['/r1', '/r2'] }] }).hosts[0].runsDirs,
    ['/r1', '/r2']);
});

test('runsDir rejects anything that is not a non-empty path', () => {
  for (const bad of [3, '', ['/r1', 7], ['/r1', ''], {}]) {
    assert.throws(() => normalizeConfig({ hosts: [{ name: 'box3', ssh: 'box3', runsDir: bad }] }),
      (err) => err instanceof ConfigError && /hosts\[0\]\.runsDir/.test(err.message),
      `runsDir ${JSON.stringify(bad)} should be rejected`);
  }
});
