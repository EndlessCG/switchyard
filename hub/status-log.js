'use strict';
const { loadJsonl, appendJsonl } = require('./jsonl-log');

// A status-changes file with a line that isn't a change record. Like the dashboard state file,
// it's never reset silently: that would erase the history.
class StatusLogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StatusLogError';
  }
}

const isState = (v) => v === null || typeof v === 'string';

function isChange(c) {
  return Boolean(c) && typeof c === 'object' && !Array.isArray(c) && Number.isInteger(c.id)
    && Number.isFinite(c.at) && typeof c.host === 'string' && typeof c.key === 'string'
    && isState(c.from) && isState(c.to) && (c.from !== null || c.to !== null);
}

// Every session status change the hub has observed, oldest first. Kept in memory and, when a
// file is given, appended to it as JSON Lines (one change per line) so a hub restart keeps the
// history; nothing is ever dropped. A change is {id, at, host, key, agent, name, from, to,
// reason}: `from` null means a newly seen session, `to` null means its host stopped reporting it.
class StatusLog {
  constructor({ file = null } = {}) {
    this.file = file;
    this.entries = file ? loadJsonl(file, isChange, (m) => new StatusLogError(m)) : [];
    this.nextId = this.entries.length ? this.entries[this.entries.length - 1].id + 1 : 1;
  }

  append(change) {
    const entry = { id: this.nextId, ...change };
    if (this.file) appendJsonl(this.file, entry);
    this.nextId += 1;
    this.entries.push(entry);
    return entry;
  }

  // Changes at or after `since` (epoch ms), newest first.
  since(since) {
    return this.entries.filter((c) => c.at >= since).reverse();
  }
}

module.exports = { StatusLog, StatusLogError };
