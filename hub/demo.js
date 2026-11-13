'use strict';
// A made-up fleet, for trying Switchyard without any servers: `npm run demo` (the web page) or
// `switchyard --demo` (the terminal view). DemoLink stands in for HostLink: instead of running a
// collector over ssh it feeds FleetState the same protocol messages, and moves its runs along
// every poll. Nothing on this machine is read or written except a throwaway state folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeConfig } = require('./config');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function step(id, status, title, extra = {}) {
  return { id: String(id), status, title, activeForm: null, description: null, blocks: [], blockedBy: [],
    updatedAt: null, ...extra };
}

function session(over) {
  const s = { agent: 'claude', cwd: null, error: null, gitBranch: null, goal: null, kind: 'interactive', pid: null,
    short: null, tmuxPane: null, state: 'idle', waitingFor: null, steps: [], updatedAt: null, ...over };
  s.key = `${s.agent}:${s.id}`;
  s.name = s.name || s.id.slice(0, 8);
  s.stepsSource = s.steps.length ? (s.agent === 'claude' ? 'claude-tasks' : 'codex-update_plan') : null;
  return s;
}

// The fleet, relative to `now`. Ages say how long ago something last happened.
function fleet(now) {
  const ago = (ms) => now - ms;
  return {
    'lab-a100': {
      sessions: [
        session({ id: 'a3f1c2d4-grpo', name: 'GRPO reward ablation', cwd: '/home/alice/rl-lab', pid: 41022,
          tmuxPane: '2:1.0', gitBranch: 'reward-ablation', state: 'working', updatedAt: ago(20_000), steps: [
            step(1, 'done', 'Read the reward code and the last run\'s logs'),
            step(2, 'done', 'Add a length-penalty switch to the reward', { blockedBy: ['1'] }),
            step(3, 'done', 'Smoke-test on 50 prompts', { blockedBy: ['2'] }),
            step(4, 'current', 'Launch 7B runs with and without the penalty', { activeForm: 'Launching the 7B runs', blockedBy: ['3'] }),
            step(5, 'pending', 'Compare win rate and response length', { blockedBy: ['4'] }),
            step(6, 'pending', 'Write up the result', { blockedBy: ['5'] }),
          ] }),
        session({ id: 'b7e1c2d4-figs', name: 'Paper figures', cwd: '/home/alice/paper', kind: 'background',
          short: 'b7e1c2d4', pid: 41377, state: 'waiting', waitingFor: 'input needed', updatedAt: ago(4 * MIN), steps: [
            step(1, 'done', 'Collect numbers from the eval runs'),
            step(2, 'done', 'Plot win rate against length'),
            step(3, 'current', 'Pick a colour scheme (asked the user)', { activeForm: 'Waiting for a colour choice' }),
            step(4, 'pending', 'Export figures as PDF'),
          ] }),
        session({ id: '0193c0de-flaky', agent: 'codex', kind: 'cli', name: 'Fix the flaky dataloader test',
          cwd: '/home/alice/rl-lab', gitBranch: 'main', state: 'working', updatedAt: ago(40_000), steps: [
            step(1, 'done', 'Reproduce the failure with a fixed seed'),
            step(2, 'current', 'Make the shuffle deterministic per worker'),
            step(3, 'pending', 'Run the test 200 times'),
          ] }),
        session({ id: '0187aaaa-old1', agent: 'codex', kind: 'vscode', name: 'Explain the tokenizer config',
          cwd: '/home/alice/rl-lab', state: 'idle', updatedAt: ago(9 * DAY) }),
        session({ id: '0187bbbb-old2', agent: 'codex', kind: 'cli', name: 'Rename the eval scripts',
          cwd: '/home/alice/rl-lab', state: 'done', updatedAt: ago(16 * DAY), steps: [
            step(1, 'done', 'Rename'), step(2, 'done', 'Update imports')] }),
      ],
      runs: [
        { id: 'grpo-7b-penalty', label: 'GRPO 7B · length penalty', status: 'Training', done: 412, total: 1000,
          unit: 'steps', gpus: [0, 1, 2, 3], startedAt: ago(3 * HOUR), rate: 0.06, cwd: '/home/alice/rl-lab',
          session: 'claude:a3f1c2d4-grpo' },
        { id: 'grpo-7b-base', label: 'GRPO 7B · no penalty', status: 'Training', done: 455, total: 1000,
          unit: 'steps', gpus: [4, 5, 6, 7], startedAt: ago(3 * HOUR + 5 * MIN), rate: 0.06, cwd: '/home/alice/rl-lab',
          session: 'claude:a3f1c2d4-grpo' },
        { id: 'sft-warmup', label: 'SFT warm-up', status: 'Done', done: 2000, total: 2000, unit: 'steps',
          gpus: [0, 1, 2, 3], startedAt: ago(9 * HOUR), finished: true, updatedAt: ago(6 * HOUR) },
        { id: 'eval-crashed', label: 'MMLU eval (crashed)', status: 'Evaluating', done: 31, total: 57, unit: 'subjects',
          gpus: [2], startedAt: ago(5 * HOUR), alive: false, updatedAt: ago(4 * HOUR) },
      ],
    },
    'lab-h100': {
      sessions: [
        session({ id: 'c91d7e00-data', name: 'Data pipeline refactor', cwd: '/home/alice/pretrain', pid: 9120,
          tmuxPane: '0:3.1', gitBranch: 'stream-shards', state: 'working', updatedAt: ago(8_000), steps: [
            step(1, 'done', 'Map where shards are read'),
            step(2, 'current', 'Stream shards instead of loading them', { activeForm: 'Rewriting the shard reader' }),
            step(3, 'pending', 'Benchmark tokens/s before and after'),
          ] }),
        session({ id: '0192dddd-cuda', agent: 'codex', kind: 'exec', name: 'Bump CUDA to 12.6',
          cwd: '/home/alice/pretrain', state: 'done', updatedAt: ago(25 * MIN), steps: [
            step(1, 'done', 'Update the Docker base image'), step(2, 'done', 'Rebuild and run the tests')] }),
      ],
      runs: [
        { id: 'pretrain-1b3', label: 'Pretrain 1.3B', status: 'Training', done: 18_400, total: 50_000, unit: 'steps',
          gpus: [0, 1, 2, 3, 4, 5, 6, 7], startedAt: ago(30 * HOUR), rate: 0.2, cwd: '/home/alice/pretrain' },
        { id: 'tokenize-web', label: 'Tokenize web shard 7', status: 'Waiting for 1 GPU', gpus: [],
          startedAt: ago(10 * MIN), cwd: '/home/alice/pretrain' },
      ],
    },
    workstation: {
      sessions: [
        session({ id: 'e0f1a2b3-notes', name: 'Reading notes', cwd: '/home/alice/notes', pid: 777,
          state: 'idle', updatedAt: ago(50 * MIN) }),
      ],
      runs: [],
    },
  };
}

// A throwaway folder for the demo's dashboard state and its pretend home directories, so the
// demo never reads or changes the real ones.
function demoDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchyard-demo-'));
}

function demoConfig(dir = demoDir()) {
  const hosts = Object.keys(fleet(Date.now())).map((name) => ({ name, ssh: null, home: path.join(dir, 'home', name) }));
  // Port 3457, so the demo can run beside a real hub on 3456.
  const config = normalizeConfig({ hosts, port: 3457, stateFile: path.join(dir, 'dashboard.json') }, 'demo');
  config.demo = true;
  config.demoDir = dir; // removed again when the demo stops
  return config;
}

class DemoLink {
  constructor({ host, config, state, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
    Object.assign(this, { host, config, state, now, setTimer, clearTimer });
    this.timer = null;
  }

  start() {
    const name = this.host.name;
    const at = this.now();
    const data = fleet(at)[name];
    this.sessions = data.sessions;
    this.runs = data.runs.map((r) => ({ alive: true, finished: false, updatedAt: at, pid: 50_000 + Math.floor(Math.random() * 9999),
      dir: path.join(this.host.home, '.local/state/switchyard/runs'), mtime: at / 1000, ...r }));
    this.state.apply(name, { type: 'hello', protocol: 2, python: '3.11.9', hostname: `${name}.example.org`,
      home: '/home/alice', notes: [], claude: { path: '/usr/local/bin/claude', version: '2.1 (Claude Code)' },
      codex: { path: '/usr/local/bin/codex', version: 'codex-cli 0.150.0' } }, at);
    for (const s of data.sessions) this.state.apply(name, { type: 'session', session: s }, at);
    for (const r of this.runs) this.state.apply(name, { type: 'run', run: this._record(r) }, at);
    this.state.apply(name, { type: 'tick' }, at);
    this.timer = this.setTimer(() => this._advance(), this.config.pollSeconds * 1000);
  }

  // A run record as the collector would report it: no demo-only fields.
  _record(r) {
    const { rate, ...rec } = r;
    return rec;
  }

  // Working sessions keep producing activity and running runs move on by their rate; nothing
  // else changes, as on a quiet afternoon.
  _advance() {
    const name = this.host.name;
    const at = this.now();
    for (const s of this.sessions) {
      if (s.state !== 'working') continue;
      s.updatedAt = at;
      this.state.apply(name, { type: 'session', session: { ...s } }, at);
    }
    for (const r of this.runs) {
      if (r.finished || r.alive === false || typeof r.done !== 'number' || !r.rate) continue;
      r.done = Math.min(r.total, r.done + Math.max(1, Math.round(r.rate * this.config.pollSeconds)));
      r.updatedAt = at;
      r.mtime = at / 1000;
      if (r.done >= r.total) { r.finished = true; r.status = 'Done'; }
      this.state.apply(name, { type: 'run', run: this._record(r) }, at);
    }
    this.state.apply(name, { type: 'tick' }, at);
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

module.exports = { DemoLink, demoConfig, fleet };
