'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Defaults for a dashboard, not derived from data; all are configurable.
const DEFAULTS = {
  port: 3456,
  pollSeconds: 2,
  reconnect: { initialSeconds: 2, maxSeconds: 60 },
  ssh: { serverAliveInterval: 15, serverAliveCountMax: 3, controlPersistSeconds: 60,
    connectTimeoutSeconds: 45 }, // = serverAliveInterval × serverAliveCountMax: a 45 s dead-connection budget
};

// The standard XDG state location: not shown, per-invocation output, but state the hub itself
// owns and expects to persist (here: which sessions are opened / removed).
function defaultStateFile() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'switchyard', 'dashboard.json');
}
// Host names appear in URLs and in board ids (`<host>~<sessionId>`).
const HOST_NAME = /^[A-Za-z0-9._-]+$/;

// A problem with the config file or its content, as opposed to a coding mistake: the entry
// point prints just the message for this, and the full stack for anything else.
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function defaultConfigPath() {
  return path.join(os.homedir(), '.config', 'switchyard', 'hosts.json');
}

function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new ConfigError(`No config at ${file}. Create it: see "Set it up for your servers" in the README.`);
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`);
  }
  return normalizeConfig(raw, file);
}

function normalizeConfig(raw, source = 'config') {
  const fail = (msg) => { throw new ConfigError(`${source}: ${msg}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('must be a JSON object');
  for (const key of ['reconnect', 'ssh']) {
    const v = raw[key];
    if (v != null && (typeof v !== 'object' || Array.isArray(v))) fail(`${key} must be an object`);
  }
  const cfg = {
    port: raw.port ?? DEFAULTS.port,
    pollSeconds: raw.pollSeconds ?? DEFAULTS.pollSeconds,
    reconnect: { ...DEFAULTS.reconnect, ...(raw.reconnect || {}) },
    ssh: { ...DEFAULTS.ssh, ...(raw.ssh || {}) },
    stateFile: raw.stateFile ?? defaultStateFile(),
    hosts: [],
  };
  if (typeof cfg.stateFile !== 'string' || !cfg.stateFile) fail('stateFile must be a non-empty string');
  // Next to the dashboard state file unless set: both are state the hub itself owns.
  cfg.statusLogFile = raw.statusLogFile ?? path.join(path.dirname(cfg.stateFile), 'status-changes.jsonl');
  if (typeof cfg.statusLogFile !== 'string' || !cfg.statusLogFile) fail('statusLogFile must be a non-empty string');
  cfg.stepLogFile = raw.stepLogFile ?? path.join(path.dirname(cfg.stateFile), 'task-history.jsonl');
  if (typeof cfg.stepLogFile !== 'string' || !cfg.stepLogFile) fail('stepLogFile must be a non-empty string');
  // The user's own notes about sessions: they stay on this machine, like the rest of this state.
  cfg.notesFile = raw.notesFile ?? path.join(path.dirname(cfg.stateFile), 'notes.json');
  if (typeof cfg.notesFile !== 'string' || !cfg.notesFile) fail('notesFile must be a non-empty string');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    fail(`port must be an integer from 1 to 65535, got ${JSON.stringify(raw.port)}`);
  }
  const numbers = {
    pollSeconds: cfg.pollSeconds,
    'reconnect.initialSeconds': cfg.reconnect.initialSeconds,
    'reconnect.maxSeconds': cfg.reconnect.maxSeconds,
    'ssh.serverAliveInterval': cfg.ssh.serverAliveInterval,
    'ssh.serverAliveCountMax': cfg.ssh.serverAliveCountMax,
    'ssh.controlPersistSeconds': cfg.ssh.controlPersistSeconds,
    'ssh.connectTimeoutSeconds': cfg.ssh.connectTimeoutSeconds,
  };
  for (const [key, value] of Object.entries(numbers)) {
    if (typeof value !== 'number' || !(value > 0)) fail(`${key} must be a positive number`);
  }
  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) fail('hosts must be a non-empty array');
  const seen = new Set();
  raw.hosts.forEach((h, i) => {
    const where = `hosts[${i}]`;
    if (!h || typeof h !== 'object') fail(`${where} must be an object`);
    if (typeof h.name !== 'string' || !HOST_NAME.test(h.name)) {
      fail(`${where}.name must match ${HOST_NAME} (it appears in URLs)`);
    }
    if (seen.has(h.name)) fail(`${where}.name "${h.name}" is used twice`);
    seen.add(h.name);
    if (!('ssh' in h)) fail(`${where}.ssh is required: an SSH alias, or null for this machine`);
    if (h.ssh !== null && (typeof h.ssh !== 'string' || !h.ssh)) fail(`${where}.ssh must be a non-empty string or null`);
    for (const k of ['claude', 'codex', 'home', 'python']) {
      if (h[k] != null && typeof h[k] !== 'string') fail(`${where}.${k} must be a string`);
    }
    // Where this server's experiments leave run progress records. The collector is told by
    // flag, because its non-interactive SSH shell never has the writer's $SWITCHYARD_RUNS_DIR.
    const runsDirs = h.runsDir == null ? [] : (Array.isArray(h.runsDir) ? [...h.runsDir] : [h.runsDir]);
    if (runsDirs.some((d) => typeof d !== 'string' || !d)) {
      fail(`${where}.runsDir must be a non-empty path, or a list of them`);
    }
    cfg.hosts.push({
      name: h.name,
      ssh: h.ssh,
      claude: h.claude ?? null, // null or missing: the collector looks it up
      codex: h.codex ?? null,
      home: h.home ?? null,     // read another home directory (used by tests)
      python: h.python ?? 'python3',
      runsDirs,                 // [] or missing: just the collector's own default
    });
  });
  return cfg;
}

// No hosts.json: this machine alone, with the defaults. Named after the machine.
function localOnlyConfig(hostname = os.hostname()) {
  const name = hostname.split('.')[0].replace(/[^A-Za-z0-9._-]/g, '-');
  return normalizeConfig({ hosts: [{ name: HOST_NAME.test(name) ? name : 'local', ssh: null }] }, 'this machine');
}

module.exports = { DEFAULTS, HOST_NAME, ConfigError, defaultConfigPath, defaultStateFile, loadConfig, normalizeConfig,
  localOnlyConfig };
