'use strict';
const { loadJsonl, appendJsonl } = require('./jsonl-log');

// A task-history file with a line that isn't a task event. Never reset silently: it holds tasks
// no longer reported anywhere else.
class StepLogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StepLogError';
  }
}

function isStepEvent(e) {
  return Boolean(e) && typeof e === 'object' && !Array.isArray(e) && Number.isInteger(e.id)
    && Number.isFinite(e.at) && typeof e.host === 'string' && typeof e.key === 'string'
    && typeof e.stepId === 'string' && typeof e.title === 'string'
    && (e.status === null || typeof e.status === 'string');
}

const fullKey = (host, key) => `${host}|${key}`;

// Every task (roadmap step) the hub has ever seen in a session, so the page can still show one
// after the agent deletes it or the session's task folder is cleaned up. Events are appended as
// JSON Lines: {id, at, host, key, stepId, title, status, from}. `from` null is a task first
// seen; `status` null is a task that's no longer reported.
class StepLog {
  constructor({ file = null } = {}) {
    this.file = file;
    this.events = file ? loadJsonl(file, isStepEvent, (m) => new StepLogError(m)) : [];
    this.nextId = this.events.length ? this.events[this.events.length - 1].id + 1 : 1;
    // fullKey -> Map(stepId -> {title, status}) as last recorded, rebuilt from the file so a
    // restart doesn't record every task it already knows all over again.
    this.last = new Map();
    for (const e of this.events) this._remember(e);
  }

  _remember(e) {
    const fk = fullKey(e.host, e.key);
    if (!this.last.has(fk)) this.last.set(fk, new Map());
    const steps = this.last.get(fk);
    if (e.status === null) steps.delete(e.stepId);
    else steps.set(e.stepId, { title: e.title, status: e.status });
  }

  _append(event) {
    const entry = { id: this.nextId, ...event };
    if (this.file) appendJsonl(this.file, entry);
    this.nextId += 1;
    this.events.push(entry);
    this._remember(entry);
    return entry;
  }

  // Records what changed in one session's steps since the last look, and returns those events.
  // A task whose title and status are unchanged records nothing, so a session re-sent every
  // poll costs one comparison per task.
  observe(host, key, steps, at) {
    const previous = this.last.get(fullKey(host, key)) || new Map();
    const events = [];
    const present = new Set();
    for (const s of steps) {
      present.add(s.id);
      const was = previous.get(s.id);
      if (was && was.status === s.status && was.title === s.title) continue;
      events.push(this._append({ at, host, key, stepId: s.id, title: s.title, status: s.status,
        from: was ? was.status : null }));
    }
    for (const [stepId, was] of [...previous]) {
      if (present.has(stepId)) continue;
      events.push(this._append({ at, host, key, stepId, title: was.title, status: null, from: was.status }));
    }
    return events;
  }

  // Every task ever seen in one session, in the order they first appeared: {stepId, title,
  // status (the last one it had), firstSeenAt, lastChangeAt, gone, history}.
  forSession(host, key) {
    const tasks = new Map();
    for (const e of this.events) {
      if (e.host !== host || e.key !== key) continue;
      if (!tasks.has(e.stepId)) {
        tasks.set(e.stepId, { stepId: e.stepId, title: e.title, status: e.status,
          firstSeenAt: e.at, lastChangeAt: e.at, gone: false, history: [] });
      }
      const t = tasks.get(e.stepId);
      if (e.status !== null) {
        t.title = e.title;
        t.status = e.status; // a task that's gone keeps the last status it had
      }
      t.gone = e.status === null;
      t.lastChangeAt = e.at;
      t.history.push({ at: e.at, status: e.status, from: e.from });
    }
    return [...tasks.values()];
  }
}

module.exports = { StepLog, StepLogError };
