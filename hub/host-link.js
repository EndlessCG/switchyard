'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProtocolError } = require('./state');

const COLLECTOR_PATH = path.join(__dirname, '..', 'collector', 'collector.py');

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Parses one collector line and applies it to state. Only a malformed line or a message the
// protocol rejects is a ProtocolError; anything else (a hub bug in state.apply or a listener
// it calls) propagates unchanged so it isn't relabelled as the collector's fault.
function parseAndApply(state, hostName, line, now) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    if (err instanceof SyntaxError) throw new ProtocolError(`not JSON (${err.message})`);
    throw err;
  }
  state.apply(hostName, msg, now);
  return msg;
}

// SIGTERM to just the direct child can leave a descendant (e.g. a shell's grandchild)
// holding the child's stdout pipe open, so 'close' never fires. detached: true (in start())
// makes the child the leader of its own process group; killing -pid reaches the whole group.
function killGroup(child, signal) {
  if (!child.pid) { child.kill(signal); return; }
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

// Shared by commandFor and conversationCommand: wraps a `python3 <pythonArgs>` invocation over
// ssh (or returns it as-is for a local host, ssh: null).
function sshWrap(host, config, pythonArgs) {
  if (host.ssh === null) return { cmd: host.python, args: pythonArgs };
  const o = config.ssh;
  return {
    cmd: 'ssh',
    args: ['-T', '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${o.connectTimeoutSeconds}`,
      '-o', `ServerAliveInterval=${o.serverAliveInterval}`, '-o', `ServerAliveCountMax=${o.serverAliveCountMax}`,
      '-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(os.homedir(), '.ssh', 'switchyard-%C')}`,
      '-o', `ControlPersist=${o.controlPersistSeconds}`,
      host.ssh, [host.python, ...pythonArgs].map(shq).join(' ')],
  };
}

function commandFor(host, config) {
  const args = ['-', '--stream', '--poll', String(config.pollSeconds)];
  if (host.claude) args.push('--claude-bin', host.claude);
  if (host.codex) args.push('--codex-bin', host.codex);
  if (host.home) args.push('--home', host.home);
  for (const dir of host.runsDirs || []) args.push('--runs-dir', dir);
  return sshWrap(host, config, args);
}

// The same command shape as commandFor, but for streaming one session's full conversation
// (collector `--conversation <key>`) instead of the fleet snapshot loop.
function conversationCommand(host, config, key) {
  const args = ['-', '--conversation', key, '--poll', String(config.pollSeconds)];
  if (host.home) args.push('--home', host.home);
  return sshWrap(host, config, args);
}

// Deletes one run's record (`<dir>/<id>.json`, the file the collector read it from) on that host,
// over the same ssh as the collector, or locally for `ssh: null`. Only the CLI calls this: the hub
// itself never writes on a server.
const REMOVE_FILE_PY = 'import os, sys; os.remove(sys.argv[1])';
function removeRunCommand(host, config, file) {
  return sshWrap(host, config, ['-c', REMOVE_FILE_PY, file]);
}

// Removes one session the agent's own way on that host (collector `--remove-session`: codex
// archive, claude rm, or an ended Claude session's task list), finding claude/codex the way the
// collector does. The collector is sent on stdin, as for the other commands. CLI only.
function removeSessionCommand(host, config, key) {
  const args = ['-', '--remove-session', key];
  if (host.claude) args.push('--claude-bin', host.claude);
  if (host.codex) args.push('--codex-bin', host.codex);
  if (host.home) args.push('--home', host.home);
  return sshWrap(host, config, args);
}

class HostLink {
  constructor({ host, config, state, spawnFn = spawn, setTimer = setTimeout, clearTimer = clearTimeout,
    now = Date.now, source }) {
    Object.assign(this, { host, config, state, spawnFn, setTimer, clearTimer, now });
    this.source = source ?? fs.readFileSync(COLLECTOR_PATH, 'utf8');
    this.attempt = 0;
    this.child = null;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    if (this.stopped) return;
    this.timer = null;
    const { cmd, args } = commandFor(this.host, this.config);
    this.state.setStatus(this.host.name, { status: 'connecting', retryAt: null });
    let stderr = '';
    let buf = '';
    let failed = null;      // a hard failure: a protocol violation we caught, or a failed spawn
    let stdinError = null;  // best-effort text if we couldn't finish sending the script
    let done = false;
    const child = this.spawnFn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child = child;

    const finish = (code, signal) => {
      if (done) return;
      done = true;
      this.child = null;
      if (this.stopped) return;
      // A child that crashes fast (or an ssh that dies fast) often closes stdin before we
      // finish writing the script (EPIPE) — that's a side effect of the crash, not itself
      // the most useful explanation, so the collector's own stderr wins when there is any.
      const text = failed || stderr.trim() || stdinError
        || (signal ? `The collector was stopped by ${signal}.` : `The collector exited with code ${code}.`);
      // ssh(1): ssh exits with 255 if an error occurred (unreachable host, auth failure, …).
      const status = !failed && this.host.ssh !== null && code === 255 ? 'offline' : 'error';
      const { initialSeconds, maxSeconds } = this.config.reconnect;
      const delayS = Math.min(initialSeconds * 2 ** this.attempt, maxSeconds);
      this.attempt += 1;
      this.state.setStatus(this.host.name, { status, error: text, retryAt: this.now() + delayS * 1000 });
      this.timer = this.setTimer(() => this.start(), delayS * 1000);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (failed || !line.trim()) continue;
        let msg;
        try {
          msg = parseAndApply(this.state, this.host.name, line, this.now());
        } catch (err) {
          if (!(err instanceof ProtocolError)) throw err;
          // The hub and collector disagree: show exactly what arrived, then restart the collector.
          failed = `The collector sent something the hub can't use (${err.message}): ${line}`;
          killGroup(child, 'SIGTERM');
          continue;
        }
        if (msg.type === 'hello') this.attempt = 0;
      }
    });
    child.stdin.on('error', (err) => {
      stdinError = stdinError || `Couldn't send the collector to ${this.host.name}: ${err.message}`;
    });
    child.on('error', (err) => {
      failed = failed || `Couldn't start ${cmd}: ${err.message}`;
      finish(null, null);
    });
    child.on('close', finish);
    child.stdin.end(this.source);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    if (this.child) killGroup(this.child, 'SIGTERM');
  }
}

module.exports = { HostLink, commandFor, conversationCommand, removeRunCommand, removeSessionCommand, shq, parseAndApply, killGroup,
  COLLECTOR_PATH };
