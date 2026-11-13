/* Pure layout helpers shared by the roadmap page and its tests. No DOM access here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SwitchyardLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Attention order for sessions within a host.
  const STATE_ORDER = ['error', 'waiting', 'working', 'idle', 'done', 'stopped'];
  const STATE_LABEL = { working: 'Working', waiting: 'Waiting on you', error: 'Error', done: 'Done',
    idle: 'Idle', stopped: 'Stopped' };

  function hasDeps(s) {
    return s.agent === 'claude' && s.steps.some((t) => t.blockedBy && t.blockedBy.length);
  }

  // Columns by dependency depth; a session without declared dependencies is a chain in step order.
  function columns(s) {
    if (!hasDeps(s)) return s.steps.map((t) => [t]);
    const byId = new Map(s.steps.map((t) => [t.id, t]));
    const depth = new Map();
    const visiting = new Set();
    const d = (id) => {
      if (depth.has(id)) return depth.get(id);
      if (visiting.has(id)) return 0; // a dependency cycle: break it here instead of recursing forever
      visiting.add(id);
      const v = (byId.get(id).blockedBy || []).filter((a) => byId.has(a))
        .reduce((m, a) => Math.max(m, d(a) + 1), 0);
      visiting.delete(id);
      depth.set(id, v);
      return v;
    };
    const cols = [];
    for (const t of s.steps) (cols[d(t.id)] ||= []).push(t);
    return cols.filter(Boolean);
  }

  function edges(s) {
    if (hasDeps(s)) {
      const ids = new Set(s.steps.map((t) => t.id));
      return s.steps.flatMap((t) => (t.blockedBy || []).filter((a) => ids.has(a)).map((a) => [a, t.id]));
    }
    return s.steps.slice(1).map((t, i) => [s.steps[i].id, t.id]);
  }

  // The `limit` most recently updated sessions that match the filter, then sorted by attention.
  function visibleSessions(list, { filter = 'all', limit = 20 } = {}) {
    const matching = list.filter((s) => filter === 'all' || s.state === filter);
    const byRecent = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
    const shown = [...matching].sort(byRecent).slice(0, limit === 'all' ? undefined : limit);
    shown.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || byRecent(a, b));
    return { shown, total: matching.length };
  }

  function relativeTime(ms, now) {
    if (!ms) return 'unknown';
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return `${s} s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.floor(h / 24)} d ago`;
  }

  function displayPath(p, home) {
    if (!p) return '';
    if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
    return p;
  }

  // Where a session lives, in words: its tmux pane, the VS Code extension, a one-off exec, …
  function whereText(s) {
    if (s.agent === 'claude') {
      if (s.kind === 'background') return `background session ${s.short || ''}`.trim();
      if (s.kind === 'interactive') return s.tmuxPane ? `tmux ${s.tmuxPane}` : 'terminal (not tmux)';
      return 'ended';
    }
    return { cli: 'Codex CLI', vscode: 'VS Code extension', exec: 'codex exec (one-off)' }[s.kind] || (s.kind || 'unknown');
  }

  // Mode for the offline box / chip color: distinct from h.status so a reconnect after a
  // failure (status 'connecting' with error still set) reads as offline, not "Connecting…".
  function hostMode(h) {
    if (h.status === 'online') return 'online';
    if (h.status === 'offline' || h.status === 'error') return 'offline';
    if (h.status === 'connecting' && h.error) return 'offline';
    return 'connecting';
  }

  // ── runs ──────────────────────────────────────────────────────
  // A run's numbers come from a file an experiment wrote, so every helper here has to cope
  // with whatever is in it: no total, a total of 0, a done past the total, junk in gpus.

  const runNum = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  // When a run last said anything, for ordering: its own updatedAt, else the file's mtime.
  function runUpdatedAt(run) {
    return runNum(run.updatedAt) ?? (runNum(run.mtime) === null ? 0 : Math.round(run.mtime * 1000));
  }

  // Live runs first; finished ones, and ones whose process died without finishing, collapsed
  // behind a disclosure on the page. Live runs keep their place as they report progress: oldest
  // start first, new runs appended, id as the tiebreak (a run without startedAt goes after those
  // with one).
  function visibleRuns(list) {
    const byRecent = (a, b) => runUpdatedAt(b) - runUpdatedAt(a);
    const started = (r) => runNum(r.startedAt) ?? Infinity;
    const byStart = (a, b) => (started(a) - started(b)) || String(a.id).localeCompare(String(b.id));
    const ended = (r) => r.finished || r.alive === false;
    return {
      live: list.filter((r) => !ended(r)).sort(byStart),
      finished: list.filter(ended).sort(byRecent),
    };
  }

  // `[0, 1, 'box2:7']` on box3 -> "box3 GPU 0,1 · box2 GPU 7". A bare index belongs to the
  // host the run was reported from; `host:index` names another. An entry that is neither a
  // string nor a number costs its own label, not the row.
  function gpuLabel(gpus, host) {
    if (!Array.isArray(gpus)) return '';
    const groups = new Map();
    for (const entry of gpus) {
      if (typeof entry !== 'string' && typeof entry !== 'number') continue;
      const text = String(entry);
      if (!text) continue;
      const cut = text.lastIndexOf(':');
      const named = cut > 0 && cut < text.length - 1;
      const where = named ? text.slice(0, cut) : host;
      const index = named ? text.slice(cut + 1) : text;
      if (!groups.has(where)) groups.set(where, []);
      groups.get(where).push(index);
    }
    return [...groups].map(([where, idx]) => `${where} GPU ${idx.join(',')}`).join(' · ');
  }

  // The bar and the numbers beside it. percent is null when there is nothing to fill.
  function runProgress(run) {
    const done = runNum(run.done);
    const total = runNum(run.total);
    const unit = run.unit ? ` ${run.unit}` : '';
    if (done === null) return { percent: null, text: '' };
    if (total === null || total <= 0) return { percent: null, text: `${done}${unit}` };
    const percent = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
    return { percent, text: `${done}/${total}${unit}` };
  }

  function durationText(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  // "eta 1h 12m", "eta 24m (reported)", or "measuring…" while no rate has been seen yet. A run
  // with no bar gets no ETA line at all, and a finished one is over.
  function etaText(run) {
    if (run.finished) return '';
    const eta = runNum(run.etaSeconds);
    if (eta !== null && run.etaSource) {
      return `eta ${durationText(eta)}${run.etaSource === 'reported' ? ' (reported)' : ''}`;
    }
    return runProgress(run).percent === null ? '' : 'measuring…';
  }

  // What the row means by "no change for 14m". advancedAt is when `done` last moved, which only
  // the hub knows; without it the page can only say when the record was last written.
  function lastChange(run) {
    const advanced = runNum(run.advancedAt);
    if (advanced !== null) return { at: advanced, source: 'advanced' };
    // The file's mtime before the record's own updatedAt: a stale writer cannot forge mtime.
    const mtime = runNum(run.mtime);
    if (mtime !== null) return { at: Math.round(mtime * 1000), source: 'written' };
    const updated = runNum(run.updatedAt);
    return { at: updated, source: 'written' };
  }

  function stateCounts(list) {
    const counts = {};
    for (const s of list) counts[s.state] = (counts[s.state] || 0) + 1;
    return counts;
  }

  return { STATE_ORDER, STATE_LABEL, hasDeps, columns, edges, visibleSessions, relativeTime, displayPath, whereText, stateCounts, hostMode,
    visibleRuns, gpuLabel, runProgress, durationText, etaText, lastChange };
});
