'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const { FleetState } = require('../state');
const { DemoLink, demoConfig } = require('../demo');

test('the demo config lives in a throwaway folder, never the real state or home', () => {
  const config = demoConfig();
  assert.equal(config.demo, true);
  assert.equal(config.port, 3457);
  assert.ok(config.stateFile.startsWith(os.tmpdir()));
  for (const h of config.hosts) {
    assert.equal(h.ssh, null);
    assert.ok(h.home.startsWith(os.tmpdir()), h.home);
  }
  fs.rmSync(config.demoDir, { recursive: true, force: true });
});

test('a DemoLink reports sessions and runs, and moves running runs along every poll', () => {
  const config = demoConfig();
  const state = new FleetState(config.hosts.map((h) => h.name));
  let tick = null;
  let now = 1_800_000_000_000;
  const links = config.hosts.map((host) => new DemoLink({ host, config, state, now: () => now,
    setTimer: (fn) => { tick = fn; return 1; }, clearTimer: () => {} }));
  // Each link keeps its own timer; drive them all.
  const ticks = [];
  for (const l of links) { l.start(); ticks.push(tick); }
  const snap = state.snapshot();
  assert.ok(snap.hosts.every((h) => h.status === 'online'));
  assert.ok(snap.sessions.some((s) => s.state === 'waiting' && s.waitingFor));
  assert.ok(snap.sessions.some((s) => s.agent === 'codex'));
  const before = snap.runs.find((r) => r.id === 'grpo-7b-penalty').done;
  now += 2000;
  ticks.forEach((fn) => fn());
  const after = state.snapshot().runs.find((r) => r.id === 'grpo-7b-penalty');
  assert.ok(after.done > before);
  assert.equal(after.rate, undefined, 'demo-only fields are not reported');
  links.forEach((l) => l.stop());
  fs.rmSync(config.demoDir, { recursive: true, force: true });
});
