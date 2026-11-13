'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { FleetState } = require('./state');
const { StatusLog } = require('./status-log');
const { StepLog } = require('./step-log');
const { RunStats } = require('./run-stats');

// A dashboard state file that exists but can't be trusted (not JSON, or the wrong shape).
// Never reset it silently: that would erase which sessions the user removed.
class StateFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateFileError';
  }
}

// remove()/restore() on a host or session Dashboard doesn't know about.
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

function fullKey(host, key) {
  return `${host}|${key}`;
}

// Wraps a FleetState so the page only ever sees sessions that are actually "opened": running
// now, or with activity since Switchyard first started.
// Routes use this in place of FleetState directly.
class Dashboard extends EventEmitter {
  constructor(state, { stateFile, statusLogFile = null, stepLogFile = null, now = Date.now }) {
    super();
    this.state = state;
    this.stateFile = stateFile;
    this.now = now;

    // Every observed status change, for the page's "Status changes" panel (null file: memory
    // only). Tracked apart from lastSeenState, which serves membership: a session its host
    // stops reporting is forgotten here, so if it's reported again it's recorded as new.
    this.statusLog = new StatusLog({ file: statusLogFile });
    // What the hub measures about each run: rate, when it last advanced, ETA.
    this.runStats = new RunStats({ now: this.now });
    // Every task ever seen in a session, so the page can still show one after the agent deletes
    // it or the session's task folder is cleaned up (null file: memory only).
    this.stepLog = new StepLog({ file: stepLogFile });
    this.loggedState = new Map(); // fullKey -> the state last recorded (or first seen)
    // Hosts whose first snapshot this hub run has arrived (their first `tick`). A session first
    // seen before that already existed when the hub started, so it isn't recorded as new.
    this.syncedHosts = new Set();

    // In-memory only, never cleared on a reconnect's `reset` (a reconnect re-sends sessions):
    // the last state seen per key, and when it last transitioned into 'working'.
    this.lastSeenState = new Map();   // fullKey -> last observed s.state
    this.becameWorkingAt = new Map(); // fullKey -> ms of the last observed transition into 'working'

    this.visibleKeys = new Map(); // host -> Set(session key) currently shown
    this.lastCounts = new Map();  // host -> {sessionCount, hiddenCount} last emitted, to dedupe host views
    for (const host of state.hosts.keys()) this.visibleKeys.set(host, new Set());

    const loaded = this._load();
    this.trackingSince = loaded.trackingSince;
    this.removed = new Map(Object.entries(loaded.removed)); // fullKey -> removedAt ms
    this.added = new Map(Object.entries(loaded.added || {})); // fullKey -> addedAt ms

    // In-memory only, never persisted: a removed session's "was added" flag, so Undo in the
    // same hub run restores it as added. After a restart this is empty, so Undo
    // just clears the removal, as it did before "add" existed.
    this.undoAddedAt = new Map(); // fullKey -> addedAt ms, set by remove() when it removed an added session

    state.on('host', (h) => this._onHost(h));
    state.on('session', (host, s) => this._onSession(host, s));
    state.on('removed', (host, key, previous) => this._onStateRemoved(host, key, previous));
    state.on('reset', (host) => this._onReset(host));
    // Runs pass straight through: the opened-session membership rules are about conversations,
    // not about the experiments they launched. What the hub adds is what it alone
    // can know: the rate progress is really moving at, when it last moved, and the ETA.
    state.on('run', (host, r) => {
      this.runStats.observe(host, r);
      this.emit('run', host, this.runStats.decorate(host, r));
    });
    state.on('run-removed', (host, id) => {
      this.runStats.forget(host, id);
      this.emit('run-removed', host, id);
    });
    state.on('tick', (host, at) => { this.syncedHosts.add(host); this.emit('tick', host, at); });
  }

  // ── persistent file ──────────────────────────────────────────────────────

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.stateFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const initial = { version: 1, trackingSince: this.now(), removed: {}, added: {} };
      this._writeFile(initial);
      return initial;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new StateFileError(`${this.stateFile} is not valid JSON (${err.message}); delete it to start tracking afresh.`);
    }
    const mapOk = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((n) => Number.isFinite(n));
    // `added` is optional: a file written by a version of the hub that predates it is still
    // valid and means added = {} — but if present, it's checked exactly like `removed`.
    const shapeOk = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version === 1
      && typeof raw.trackingSince === 'number'
      && mapOk(raw.removed)
      && (raw.added === undefined || mapOk(raw.added));
    if (!shapeOk) {
      throw new StateFileError(`${this.stateFile} has an unexpected shape for a Switchyard dashboard state file; delete it to start tracking afresh.`);
    }
    return raw;
  }

  _writeFile(obj) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  // Writes candidate `removed`/`added` maps to disk WITHOUT touching `this.removed`/`this.added`.
  // Callers must only assign them after this returns successfully, so a failed write (full disk,
  // permissions, …) never leaves memory ahead of what's actually persisted.
  _persist(removedMap, addedMap) {
    this._writeFile({ version: 1, trackingSince: this.trackingSince,
      removed: Object.fromEntries(removedMap), added: Object.fromEntries(addedMap) });
  }

  // ── visibility ───────────────────────────────────────────────────────────

  _observeTransition(key, s) {
    const prev = this.lastSeenState.get(key);
    if (prev !== undefined && prev !== 'working' && s.state === 'working') {
      this.becameWorkingAt.set(key, this.now());
    }
    this.lastSeenState.set(key, s.state);
  }

  _recordChange(host, key, s, from, to) {
    const reason = to === 'waiting' ? (s && s.waitingFor) || null : to === 'error' ? (s && s.error) || null : null;
    const change = this.statusLog.append({ at: this.now(), host, key, agent: s ? s.agent : null,
      name: s ? s.name : key, from, to, reason });
    this.emit('status-change', change);
  }

  _logSession(host, s) {
    const fk = fullKey(host, s.key);
    const prev = this.loggedState.get(fk);
    this.loggedState.set(fk, s.state);
    const changed = prev === undefined ? this.syncedHosts.has(host) : prev !== s.state;
    if (changed) this._recordChange(host, s.key, s, prev ?? null, s.state);
    this.stepLog.observe(host, s.key, s.steps || [], this.now());
  }

  _logRemoved(host, key, previous) {
    const fk = fullKey(host, key);
    if (!this.loggedState.has(fk)) return;
    const prev = this.loggedState.get(fk);
    this.loggedState.delete(fk);
    this._recordChange(host, key, previous, prev, null);
  }

  _becameWorking(key, since) {
    const at = this.becameWorkingAt.get(key);
    return at !== undefined && at > since;
  }

  _active(host, s) {
    const key = fullKey(host, s.key);
    return (s.agent === 'claude' && s.pid != null)
      || (s.updatedAt || 0) > this.trackingSince
      || this._becameWorking(key, this.trackingSince);
  }

  // Also the place a removed session "comes back on new activity": when it does, the removed
  // entry is deleted and persisted here, as a side effect of the visibility check itself.
  _computeVisible(host, s) {
    const key = fullKey(host, s.key);
    if (this.added.has(key)) return true; // checked first, and kept visible even idle
    if (this.removed.has(key)) {
      const removedAt = this.removed.get(key);
      const backAgain = (s.updatedAt || 0) > removedAt || this._becameWorking(key, removedAt);
      if (backAgain) {
        const next = new Map(this.removed);
        next.delete(key);
        this._persist(next, this.added); // if this throws, `this.removed` is untouched below
        this.removed = next;
      }
      return backAgain;
    }
    return this._active(host, s);
  }

  // ── host views ───────────────────────────────────────────────────────────

  _overrideCounts(h) {
    const visible = this.visibleKeys.get(h.name).size;
    return { ...h, sessionCount: visible, hiddenCount: h.sessionCount - visible };
  }

  // Always emits, for a caller-initiated change (remove/restore) or a host event FleetState
  // itself raised, which the page must see regardless of whether the counts moved.
  _emitHostView(host) {
    const view = this._overrideCounts(this.state.hostView(host));
    this.lastCounts.set(host, { sessionCount: view.sessionCount, hiddenCount: view.hiddenCount });
    this.emit('host', view);
  }

  // Emits only when sessionCount/hiddenCount actually changed since the last emission.
  _emitHostViewIfChanged(host) {
    const view = this._overrideCounts(this.state.hostView(host));
    const last = this.lastCounts.get(host);
    if (last && last.sessionCount === view.sessionCount && last.hiddenCount === view.hiddenCount) return;
    this.lastCounts.set(host, { sessionCount: view.sessionCount, hiddenCount: view.hiddenCount });
    this.emit('host', view);
  }

  // ── state event handlers ─────────────────────────────────────────────────

  _onHost(h) {
    const view = this._overrideCounts(h);
    this.lastCounts.set(h.name, { sessionCount: view.sessionCount, hiddenCount: view.hiddenCount });
    this.emit('host', view);
  }

  _onSession(host, s) {
    this._observeTransition(fullKey(host, s.key), s);
    this._logSession(host, s);
    const visibleSet = this.visibleKeys.get(host);
    const wasVisible = visibleSet.has(s.key);
    const visible = this._computeVisible(host, s);
    if (visible) {
      visibleSet.add(s.key);
      this.emit('session', host, s);
    } else if (wasVisible) {
      visibleSet.delete(s.key);
      this.emit('removed', host, s.key, s);
    }
    this._emitHostViewIfChanged(host);
  }

  _onStateRemoved(host, key, previous) {
    this._logRemoved(host, key, previous);
    const visibleSet = this.visibleKeys.get(host);
    if (visibleSet.has(key)) {
      visibleSet.delete(key);
      this.emit('removed', host, key, previous);
    }
    this._emitHostViewIfChanged(host);
  }

  _onReset(host) {
    this.visibleKeys.set(host, new Set());
    this.emit('reset', host);
    this._emitHostViewIfChanged(host);
  }

  // ── queries ──────────────────────────────────────────────────────────────

  snapshot() {
    const hosts = [...this.state.hosts.keys()].map((name) => this._overrideCounts(this.state.hostView(name)));
    const sessions = [];
    for (const [host, keys] of this.visibleKeys) {
      const m = this.state.sessions.get(host);
      for (const key of keys) {
        const s = m.get(key);
        if (s) sessions.push({ host, ...s });
      }
    }
    const runs = [];
    for (const [host, m] of this.state.runs) {
      for (const r of m.values()) runs.push({ host, ...this.runStats.decorate(host, r) });
    }
    return { hosts, sessions, runs };
  }

  // A FleetState-shaped view holding only visible sessions, so the board adapters (defined on
  // FleetState.prototype) can shape them without duplicating that logic.
  _visibleView() {
    const view = Object.create(FleetState.prototype);
    view.sessions = new Map();
    for (const [host, keys] of this.visibleKeys) {
      const m = this.state.sessions.get(host);
      const filtered = new Map();
      for (const key of keys) if (m.has(key)) filtered.set(key, m.get(key));
      view.sessions.set(host, filtered);
    }
    return view;
  }

  boardSessions(limit) {
    return this._visibleView().boardSessions(limit);
  }

  boardTasks(boardId) {
    return this._visibleView().boardTasks(boardId);
  }

  allBoardTasks() {
    return this._visibleView().allBoardTasks();
  }

  // Every recorded status change at or after `since` (epoch ms), newest first, hidden sessions
  // included.
  statusChanges(since) {
    return this.statusLog.since(since);
  }

  // Every task this session has ever had, in the order they first appeared.
  sessionSteps(host, key) {
    return this.stepLog.forSession(host, key);
  }

  // Every reported session that isn't visible, newest (by its own updatedAt) first.
  hiddenSessions() {
    const out = [];
    for (const [host, keys] of this.visibleKeys) {
      for (const [key, s] of this.state.sessions.get(host)) {
        if (keys.has(key)) continue;
        const entry = { host, key, id: s.id, agent: s.agent, name: s.name, cwd: s.cwd, kind: s.kind,
          state: s.state, updatedAt: s.updatedAt, stepsTotal: s.steps.length,
          stepsDone: s.steps.filter((t) => t.status === 'done').length };
        if (this.removed.has(fullKey(host, key))) entry.removed = true;
        out.push(entry);
      }
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }

  // ── mutations ────────────────────────────────────────────────────────────

  add(host, key) {
    if (!this.state.hosts.has(host)) throw new NotFoundError(`unknown host ${host}`);
    const m = this.state.sessions.get(host);
    if (!m.has(key)) throw new NotFoundError(`unknown session ${key} on ${host}`);
    const fk = fullKey(host, key);
    const addedNext = new Map(this.added);
    addedNext.set(fk, this.now());
    const removedNext = new Map(this.removed);
    removedNext.delete(fk);
    this._persist(removedNext, addedNext); // throws (leaving memory unchanged) if the write fails
    this.added = addedNext;
    this.removed = removedNext;
    const s = m.get(key);
    const visibleSet = this.visibleKeys.get(host);
    if (!visibleSet.has(key) && this._computeVisible(host, s)) {
      visibleSet.add(key);
      this.emit('session', host, s);
    }
    this._emitHostView(host);
  }

  remove(host, key) {
    if (!this.state.hosts.has(host)) throw new NotFoundError(`unknown host ${host}`);
    const m = this.state.sessions.get(host);
    if (!m.has(key)) throw new NotFoundError(`unknown session ${key} on ${host}`);
    const fk = fullKey(host, key);
    const removedNext = new Map(this.removed);
    removedNext.set(fk, this.now());
    const addedNext = new Map(this.added);
    const wasAdded = addedNext.has(fk);
    const addedAt = addedNext.get(fk);
    addedNext.delete(fk);
    this._persist(removedNext, addedNext); // throws (leaving memory unchanged) if the write fails
    this.removed = removedNext;
    this.added = addedNext;
    // In-memory only: remembered so Undo in this same hub run can restore it as added.
    if (wasAdded) this.undoAddedAt.set(fk, addedAt);
    const visibleSet = this.visibleKeys.get(host);
    if (visibleSet.has(key)) {
      const previous = m.get(key);
      visibleSet.delete(key);
      this.emit('removed', host, key, previous);
    }
    this._emitHostView(host);
  }

  restore(host, key) {
    if (!this.state.hosts.has(host)) throw new NotFoundError(`unknown host ${host}`);
    const m = this.state.sessions.get(host);
    if (!m.has(key)) throw new NotFoundError(`unknown session ${key} on ${host}`);
    const fk = fullKey(host, key);
    const wasAdded = this.undoAddedAt.has(fk);
    if (this.removed.has(fk) || wasAdded) {
      const removedNext = new Map(this.removed);
      removedNext.delete(fk);
      const addedNext = new Map(this.added);
      if (wasAdded) addedNext.set(fk, this.undoAddedAt.get(fk));
      this._persist(removedNext, addedNext); // throws (leaving memory unchanged) if the write fails
      this.removed = removedNext;
      this.added = addedNext;
      if (wasAdded) this.undoAddedAt.delete(fk);
    }
    const s = m.get(key);
    const visibleSet = this.visibleKeys.get(host);
    if (!visibleSet.has(key) && this._computeVisible(host, s)) {
      visibleSet.add(key);
      this.emit('session', host, s);
    }
    this._emitHostView(host);
  }
}

module.exports = { Dashboard, StateFileError, NotFoundError };
