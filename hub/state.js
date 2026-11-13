'use strict';
const { EventEmitter } = require('events');

const BOARD_STATUS = { done: 'completed', current: 'in_progress', pending: 'pending' };

// A collector sent something the protocol doesn't allow — distinct from a hub bug (a bad
// listener, a coding mistake in apply's own callers), which must surface, not be relabelled.
class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

class FleetState extends EventEmitter {
  constructor(hostNames) {
    super();
    this.hosts = new Map();
    this.sessions = new Map();
    // Runs reported by the experiments on each host. Kept beside sessions, not
    // inside them: a session may own any number of runs, and a run may own none.
    this.runs = new Map();
    for (const name of hostNames) {
      this.hosts.set(name, { name, status: 'connecting', error: null, errors: [], notes: [], info: null,
        lastSyncAt: null, retryAt: null });
      this.sessions.set(name, new Map());
      this.runs.set(name, new Map());
    }
  }

  _host(name) {
    const h = this.hosts.get(name);
    if (!h) throw new Error(`unknown host ${name}`);
    return h;
  }

  hostView(name) {
    return { ...this._host(name), sessionCount: this.sessions.get(name).size };
  }

  setStatus(name, patch) {
    Object.assign(this._host(name), patch);
    this.emit('host', this.hostView(name));
  }

  apply(name, msg, now = Date.now()) {
    const h = this._host(name); // an unknown host is a hub bug, not a protocol problem
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new ProtocolError('message is not a JSON object');
    const map = this.sessions.get(name);
    switch (msg.type) {
      case 'hello': {
        if (msg.protocol !== 2) throw new ProtocolError(`the collector speaks protocol ${msg.protocol}; this hub speaks 2`);
        map.clear();
        this.runs.get(name).clear();
        this.emit('reset', name);
        const { python, hostname, home, claude, codex } = msg;
        this.setStatus(name, { status: 'online', error: null, retryAt: null, notes: msg.notes || [],
          info: { python, hostname, home, claude, codex }, lastSyncAt: now });
        return;
      }
      case 'session':
        if (!msg.session || typeof msg.session !== 'object' || typeof msg.session.key !== 'string') {
          throw new ProtocolError('session message needs a session object with a string key');
        }
        map.set(msg.session.key, msg.session);
        this.emit('session', name, msg.session);
        return;
      case 'removed': {
        if (typeof msg.key !== 'string') throw new ProtocolError('removed message needs a string key');
        const previous = map.get(msg.key);
        map.delete(msg.key);
        this.emit('removed', name, msg.key, previous);
        return;
      }
      // A run's contents are the collector's business: it validated the record and reported
      // whatever it rejected. Checking more here would turn one odd file on a server into a
      // ProtocolError, which kills the collector and reconnects with backoff.
      case 'run': {
        const r = msg.run;
        if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.id !== 'string') {
          throw new ProtocolError('run message needs a run object with a string id');
        }
        this.runs.get(name).set(r.id, r);
        this.emit('run', name, r);
        return;
      }
      case 'run-removed': {
        if (typeof msg.id !== 'string') throw new ProtocolError('run-removed message needs a string id');
        this.runs.get(name).delete(msg.id);
        this.emit('run-removed', name, msg.id);
        return;
      }
      case 'errors':
        if (!Array.isArray(msg.errors)) throw new ProtocolError('errors message needs an errors array');
        this.setStatus(name, { errors: msg.errors });
        return;
      case 'tick':
        h.lastSyncAt = now;
        this.emit('tick', name, now);
        return;
      default:
        throw new ProtocolError(`unknown message type ${JSON.stringify(msg.type)}`);
    }
  }

  snapshot() {
    return {
      hosts: [...this.hosts.keys()].map((n) => this.hostView(n)),
      sessions: [...this.sessions].flatMap(([host, m]) => [...m.values()].map((s) => ({ host, ...s }))),
      runs: [...this.runs].flatMap(([host, m]) => [...m.values()].map((r) => ({ host, ...r }))),
    };
  }

  // ── adapters for upstream's board (public/board.html): Claude task sessions only ──

  _taskSessions() {
    const out = [];
    for (const [host, m] of this.sessions) {
      for (const s of m.values()) if (s.stepsSource === 'claude-tasks') out.push({ host, s });
    }
    return out;
  }

  boardSessions(limit) {
    const list = this._taskSessions().map(({ host, s }) => {
      const n = (st) => s.steps.filter((t) => t.status === st).length;
      return {
        id: `${host}~${s.id}`, name: `${s.name} · ${host}`, slug: null,
        project: s.cwd ? `${host}:${s.cwd}` : null, description: null, gitBranch: s.gitBranch,
        taskCount: s.steps.length, completed: n('done'), inProgress: n('current'), pending: n('pending'),
        createdAt: null, modifiedAt: new Date(s.updatedAt).toISOString(),
      };
    });
    list.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return limit ? list.slice(0, limit) : list;
  }

  _boardTask(step) {
    // Linux can't give a file's creation time, so the board's timeline starts at the last update (decision 8).
    const at = step.updatedAt ? new Date(step.updatedAt).toISOString() : null;
    return { id: step.id, subject: step.title, description: step.description ?? '',
      activeForm: step.activeForm ?? undefined, status: BOARD_STATUS[step.status],
      blocks: step.blocks, blockedBy: step.blockedBy, createdAt: at, updatedAt: at };
  }

  boardTasks(boardId) {
    const cut = boardId.indexOf('~');
    if (cut < 0) return null;
    const m = this.sessions.get(boardId.slice(0, cut));
    const s = m && m.get(`claude:${boardId.slice(cut + 1)}`);
    if (!s || s.stepsSource !== 'claude-tasks') return null;
    return s.steps.map((t) => this._boardTask(t));
  }

  allBoardTasks() {
    return this._taskSessions().flatMap(({ host, s }) => s.steps.map((t) => ({
      ...this._boardTask(t), sessionId: `${host}~${s.id}`, sessionName: `${s.name} · ${host}`,
      project: s.cwd ? `${host}:${s.cwd}` : null,
    })));
  }
}

module.exports = { FleetState, BOARD_STATUS, ProtocolError };
