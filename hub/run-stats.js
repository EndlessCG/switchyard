'use strict';

// What the hub measures about a run, which no record can tell it: the rate progress
// is actually moving at, when `done` last changed, and the ETA that follows. Two samples per
// run — the basis and the latest — because that is all the arithmetic needs. In memory only:
// after a restart a run shows no ETA until it advances twice, which is the honest answer.

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

class RunStats {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.samples = new Map(); // `${host}|${id}` -> {basisAt, basisDone, latestAt, latestDone, total, advancedAt}
  }

  _key(host, run) {
    return `${host}|${run.id}`;
  }

  // Called once per run message. The only writer of sample state.
  observe(host, run) {
    if (!run || typeof run.id !== 'string') return;
    const done = num(run.done);
    if (done === null) return; // a status-only run has nothing to measure
    const total = num(run.total);
    const at = this.now();
    const prev = this.samples.get(this._key(host, run));
    // A changed total is a phase boundary; a done that went backwards is a restarted run
    // reusing its id. Either way the old rate describes different work.
    if (!prev || prev.total !== total || done < prev.latestDone) {
      // A new basis is not progress: a reporter that recomputes `total` every write while
      // `done` sits still must not make a stuck run read as having just advanced.
      const advancedAt = prev ? (done === prev.latestDone ? prev.advancedAt : at) : null;
      this.samples.set(this._key(host, run), { basisAt: at, basisDone: done, latestAt: at,
        latestDone: done, total, advancedAt });
      return;
    }
    if (done !== prev.latestDone) {
      prev.latestAt = at;
      prev.latestDone = done;
      prev.advancedAt = at;
    }
  }

  // Called when a host stops reporting a run. A removal is not a reconnect: an id that comes
  // back belongs to a different attempt, and measuring across the gap would invent a rate.
  forget(host, id) {
    this.samples.delete(`${host}|${id}`);
  }

  // A copy of `run` plus what was measured. Pure: records nothing.
  decorate(host, run) {
    const s = this.samples.get(this._key(host, run));
    let rate = null;
    if (s && s.latestDone > s.basisDone && s.latestAt > s.basisAt) {
      rate = (s.latestDone - s.basisDone) / ((s.latestAt - s.basisAt) / 1000);
    }
    const done = num(run.done);
    const total = num(run.total);
    const reported = num(run.eta);
    let etaSeconds = null;
    let etaSource = null;
    if (run.finished) {
      etaSeconds = null; // over: whatever it last reported is history
    } else if (reported !== null && reported >= 0) {
      etaSeconds = reported;
      etaSource = 'reported';
    } else if (rate !== null && rate > 0 && total !== null && total > 0 && done !== null && done < total) {
      etaSeconds = (total - done) / rate;
      etaSource = 'measured';
    }
    return { ...run, advancedAt: s ? s.advancedAt : null, rate, etaSeconds, etaSource };
  }
}

module.exports = { RunStats };
