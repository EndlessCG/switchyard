#!/usr/bin/env node
'use strict';
// Switchyard in the terminal: the same sessions, roadmaps and runs as the web page.
//
// Where the data comes from (printed in the header):
//   hub     a running hub (`npm start`): GET /api/fleet, so the sessions are exactly the page's
//   direct  no hub: this process runs the collector itself, like the hub does — on every host
//           in hosts.json over SSH, or on this machine alone when there is no hosts.json
const fs = require('fs');
const http = require('http');
const { DEFAULTS, loadConfig, defaultConfigPath, ConfigError, localOnlyConfig } = require('./hub/config');
const { FleetState } = require('./hub/state');
const { spawn } = require('child_process');
const path = require('path');
const { HostLink, removeRunCommand, removeSessionCommand, COLLECTOR_PATH } = require('./hub/host-link');
const { RunStats } = require('./hub/run-stats');
const { Notes, NotesFileError } = require('./hub/notes');
const { render } = require('./cli/render');
const { DemoLink, demoConfig } = require('./hub/demo');
const tui = require('./cli/tui');

const USAGE = `Usage: switchyard [options]

A live, top-like view of every Claude Code and Codex session, its roadmap, and
each server's runs. Press ? inside for the keys, q to quit. With a hub running
it shows what the web page shows; without one it runs the collector itself
(every host in hosts.json, or just this machine).

      --demo             made-up servers, sessions and runs: try it without any setup
      --once             print one snapshot and exit (also when output isn't a terminal)
      --all-runs         also list runs that aren't running (finished, or process gone)
      --all              without a hub: also list idle, done and stopped sessions
  with --once:
      --steps            list every step of each roadmap, not just a summary line
      --state LIST       only these session states, e.g. --state working,waiting
                         (error, waiting, working, idle, done, stopped)
      --limit N          at most N sessions listed per server, most recently updated (default 20)
  data:
      --hub URL          read this hub (default: http://127.0.0.1:<port> from the config)
      --direct           don't use a hub, even if one is running
      --local            don't use a hub, and only look at this machine
      --config FILE      hosts.json to use (default: $SWITCHYARD_CONFIG or ${defaultConfigPath()})
      --no-color         plain text (also when NO_COLOR is set or output isn't a terminal)
  -h, --help             this text`;

class UsageError extends Error {}
// A hub that answered, but not with what the CLI needs.
class HubError extends Error {}

function parseArgs(argv) {
  const o = { demo: false, once: false, steps: false, allRuns: false, states: null, limit: 20, hub: null, direct: false,
    local: false, config: null, color: true, help: false };
  const value = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('-')) throw new UsageError(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--demo': o.demo = true; break;
      case '--once': o.once = true; break;
      case '--steps': o.steps = true; break;
      case '--all-runs': o.allRuns = true; break;
      case '--state': {
        const list = value(++i, a).split(',').map((s) => s.trim()).filter(Boolean);
        const known = ['error', 'waiting', 'working', 'idle', 'done', 'stopped'];
        const bad = list.filter((s) => !known.includes(s));
        if (bad.length) throw new UsageError(`unknown state ${bad.join(', ')} (states: ${known.join(', ')})`);
        o.states = new Set(list);
        break;
      }
      case '--limit': {
        const v = value(++i, a);
        if (v !== 'all' && !/^[1-9]\d*$/.test(v)) throw new UsageError('--limit needs a positive number or "all"');
        o.limit = v === 'all' ? 'all' : Number(v);
        break;
      }
      case '--all': o.limit = 'all'; break;
      case '--hub': o.hub = value(++i, a).replace(/\/+$/, ''); break;
      case '--direct': o.direct = true; break;
      case '--local': o.local = true; break;
      case '--config': o.config = value(++i, a); break;
      case '--no-color': o.color = false; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new UsageError(`unknown option ${a}`);
    }
  }
  if (o.hub && (o.direct || o.local)) throw new UsageError('--hub and --direct/--local contradict each other');
  return o;
}

// The hosts to collect from in direct mode, and the config settings that go with them.
function directConfig(configFile, local) {
  if (!local && fs.existsSync(configFile)) return loadConfig(configFile);
  return localOnlyConfig();
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new HubError(`${url} answered ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new HubError(`${url} did not return JSON (${err.message})`));
        }
      });
    });
    req.on('error', reject);
  });
}

// Reads a hub. A hub's notes come with it, so the CLI shows them like the page does.
function hubSource(base) {
  return {
    label: `hub ${base}`,
    measuring: true, // the hub keeps measuring between our reads
    membership: true, // the sessions are the page's own list
    async snapshot() {
      const [fleet, notes] = await Promise.all([getJson(`${base}/api/fleet`), getJson(`${base}/api/notes`)]);
      return { snapshot: fleet, notes: notes.notes };
    },
    stop() {},
  };
}

// Runs the collector on each host, the way the hub does, and keeps the state in this process.
// `ready` resolves once every host has either sent its first full poll or failed.
function directSource(config, { keepGoing, Link = HostLink }) {
  const state = new FleetState(config.hosts.map((h) => h.name));
  const stats = new RunStats();
  state.on('run', (host, r) => stats.observe(host, r));
  state.on('run-removed', (host, id) => stats.forget(host, id));
  const settled = new Set();
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const settle = (name) => {
    settled.add(name);
    if (settled.size === config.hosts.length) resolveReady();
  };
  state.on('tick', (name) => settle(name));
  state.on('host', (h) => { if (h.status === 'offline' || h.status === 'error') settle(h.name); });
  const links = config.hosts.map((host) => new Link({ host, config, state }));
  links.forEach((l) => l.start());
  // Notes live in the hub's notes file on this machine; read it if it's there, never write it.
  let notes = null;
  if (fs.existsSync(config.notesFile)) notes = new Notes({ file: config.notesFile }).all();
  const where = config.demo ? 'made-up servers'
    : (config.hosts.length === 1 && config.hosts[0].ssh === null ? 'this machine' : `${config.hosts.length} hosts`);
  return {
    label: `direct · ${where}${keepGoing ? '' : ' · one poll'}`,
    measuring: keepGoing,
    membership: false,
    ready,
    async snapshot() {
      await ready;
      const s = state.snapshot();
      s.runs = s.runs.map((r) => stats.decorate(r.host, r));
      return { snapshot: s, notes };
    },
    stop() { links.forEach((l) => l.stop()); },
  };
}

function isRefused(err) {
  return err && (err.code === 'ECONNREFUSED' || (err.errors || []).some((e) => e.code === 'ECONNREFUSED'));
}

async function pickSource(o, keepGoing) {
  const configFile = o.config || process.env.SWITCHYARD_CONFIG || defaultConfigPath();
  if (o.config && !fs.existsSync(o.config)) throw new ConfigError(`No config at ${o.config}.`);
  if (o.demo) {
    const config = demoConfig();
    const source = directSource(config, { keepGoing, Link: DemoLink });
    source.label = 'demo · made-up servers';
    const stop = source.stop;
    source.stop = () => { stop(); fs.rmSync(config.demoDir, { recursive: true, force: true }); };
    return { source, pollSeconds: config.pollSeconds, config };
  }
  if (o.direct || o.local) {
    const config = directConfig(configFile, o.local);
    return { source: directSource(config, { keepGoing }), pollSeconds: config.pollSeconds, config };
  }
  const config = fs.existsSync(configFile) ? loadConfig(configFile) : null;
  const pollSeconds = config ? config.pollSeconds : DEFAULTS.pollSeconds;
  const base = o.hub || `http://127.0.0.1:${config ? config.port : DEFAULTS.port}`;
  const hub = hubSource(base);
  try {
    await hub.snapshot();
    return { source: hub, pollSeconds, config };
  } catch (err) {
    // Only "nothing is listening" means there is no hub; any other failure is a real problem.
    if (o.hub || !isRefused(err)) throw err;
  }
  const directCfg = directConfig(configFile, false);
  const direct = directSource(directCfg, { keepGoing });
  direct.label += ` (no hub at ${base})`;
  return { source: direct, pollSeconds, config: directCfg };
}

function frameOpts(o, source, out) {
  const tty = Boolean(out.isTTY);
  return {
    now: Date.now(), color: o.color && tty && !('NO_COLOR' in process.env), width: tty ? out.columns : null,
    source: source.label, limit: o.limit, states: o.states, steps: o.steps, allRuns: o.allRuns,
    measuring: source.measuring, collapseInactive: !source.membership,
  };
}

async function once(o) {
  const { source } = await pickSource(o, false);
  try {
    const { snapshot, notes } = await source.snapshot();
    process.stdout.write(`${render(snapshot, { ...frameOpts(o, source, process.stdout), notes })}\n`);
  } finally {
    source.stop();
  }
}

const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/; // docs/runs-api.md; the collector reports no other ids

// Deletes a run's record on the host that reported it: `<dir>/<id>.json`, the file the collector
// read it from (it reports a run only when the file is named after the id). The host is reached
// as configured in hosts.json, the way the collector is.
function deleteRun(config, run) {
  if (config && config.demo) return Promise.reject(new Error('this is the demo: nothing is deleted'));
  const host = config && config.hosts.find((h) => h.name === run.host);
  if (!host) {
    return Promise.reject(new Error(`no hosts.json entry for ${run.host} here, so it can't be reached to delete the record`));
  }
  if (!RUN_ID.test(run.id) || typeof run.dir !== 'string' || !path.isAbsolute(run.dir)) {
    return Promise.reject(new Error(`run ${JSON.stringify(run.id)} has no usable record path`));
  }
  const file = `${run.dir}/${run.id}.json`;
  const { cmd, args } = removeRunCommand(host, config, file);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(`${run.host}:${file}`);
      const lines = stderr.trim().split('\n');
      return reject(new Error(lines[lines.length - 1] || `exited with code ${code}`));
    });
  });
}

// Removes a session on the host that reported it, the agent's own way (see the collector's
// remove_session): the collector is sent there and prints one JSON line saying what it did.
function deleteSession(config, session) {
  if (config && config.demo) return Promise.reject(new Error('this is the demo: nothing is deleted'));
  const host = config && config.hosts.find((h) => h.name === session.host);
  if (!host) {
    return Promise.reject(new Error(`no hosts.json entry for ${session.host} here, so it can't be reached`));
  }
  const { cmd, args } = removeSessionCommand(host, config, session.key);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').pop();
      let answer = null;
      if (line && line.startsWith('{')) {
        try { answer = JSON.parse(line); } catch (err) { if (!(err instanceof SyntaxError)) throw err; }
      }
      if (answer && answer.ok) return resolve(answer.message);
      if (answer) return reject(new Error(answer.error));
      const lines = stderr.trim().split('\n');
      return reject(new Error(lines[lines.length - 1] || `exited with code ${code}`));
    });
    child.stdin.end(fs.readFileSync(COLLECTOR_PATH, 'utf8'));
  });
}

// The interactive view: alternate screen, raw keyboard, redrawn on every key, every poll and
// every resize. The terminal is always given back, however the process ends.
async function interactive(o) {
  const { source, pollSeconds, config } = await pickSource(o, true);
  const out = process.stdout;
  const input = process.stdin;
  let st = tui.initialState({ allRuns: o.allRuns, allSessions: o.limit === 'all', collapseInactive: !source.membership });
  let last = null;
  let lastError = null;
  let pageSize = 10;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (input.isTTY) input.setRawMode(false);
    out.write('\x1b[?25h\x1b[?1049l'); // cursor back, leave the alternate screen
  };
  const draw = () => {
    const opts = { width: out.columns || 80, height: out.rows || 24, now: Date.now(),
      color: o.color && !('NO_COLOR' in process.env), source: source.label, measuring: source.measuring,
      notes: last ? last.notes : null, error: lastError };
    if (!last) {
      out.write(`\x1b[H\x1b[2J${source.label}\nCollecting… (q quits)`);
      return;
    }
    const frame = tui.screen(last.snapshot, st, opts);
    pageSize = frame.pageSize;
    st = { ...st, top: { ...st.top, [st.view]: frame.scrollTop } };
    out.write(`\x1b[H${frame.lines.map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`);
  };
  let timer = null;
  const quit = (code = 0) => { clearInterval(timer); source.stop(); restore(); process.exit(code); };
  process.on('exit', restore);
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0)); // the terminal went away

  out.write('\x1b[?1049h\x1b[?25l'); // alternate screen, hidden cursor
  input.setRawMode(true);              // keys arrive one by one; Ctrl-C arrives as a key
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    for (const key of tui.parseKeys(chunk)) {
      const rows = last ? tui.rowsFor(last.snapshot, st) : [];
      const next = tui.handleKey(st, key, rows, pageSize);
      if (next === null) { quit(0); return; }
      st = next;
      if (st.pending) {
        const { run, session } = st.pending;
        const name = run ? (run.label || run.id) : session.name;
        st = { ...st, pending: null, message: `Deleting ${name}…` };
        const done = run
          ? deleteRun(config, run).then((where) => `Deleted ${where}.`)
          : deleteSession(config, session).then((what) => `${session.name}: ${what}.`);
        done.then(
          (text) => { st = { ...st, message: `${text} It leaves the table at the next poll.` }; draw(); },
          (err) => { st = { ...st, message: `Couldn't delete ${name}: ${err.message}` }; draw(); },
        );
      }
    }
    draw();
  });
  input.resume();
  out.on('resize', draw);

  const refresh = async () => {
    try {
      last = await source.snapshot();
      lastError = null;
    } catch (err) {
      if (!last) { restore(); source.stop(); throw err; }
      lastError = err.message; // keep showing the last good data, and say it is stale
    }
    draw();
  };
  draw();
  await refresh();
  timer = setInterval(() => { refresh().catch((err) => { lastError = err.message; draw(); }); }, pollSeconds * 1000);
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log(USAGE); return; }
  if (o.once || !process.stdout.isTTY || !process.stdin.isTTY) await once(o);
  else await interactive(o);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof UsageError) {
      console.error(`switchyard: ${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    // Expected trouble (bad config, no hub at --hub, a hub's bad answer) gets its message;
    // anything else is a bug here and keeps its stack.
    const expected = err instanceof ConfigError || err instanceof NotesFileError || err instanceof HubError || err.code;
    console.error(`switchyard: ${expected ? err.message : err.stack}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, directConfig, deleteRun, deleteSession, UsageError };
