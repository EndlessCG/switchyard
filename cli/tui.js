'use strict';
// The interactive, top-like view: a header per host, a scrolling table of sessions or runs, a
// details pane for the selected row. Pure: (snapshot, view state, screen size) -> lines, and
// (view state, key) -> view state. cli.js owns the terminal, the keyboard and the data.
const L = require('../public/layout');
const { fit, visibleWidth, painter, oneLine } = require('./render');

// The states that want a look (first in the page's attention order). Without a hub there is no
// dashboard membership (which sessions the page shows), so the other sessions are collapsed into
// one row at the end of the table instead. With a hub, the table is exactly the page's sessions.
const FILTERS = ['all', 'working', 'waiting', 'error', 'idle', 'done', 'stopped'];
const ACTIVE = new Set(['error', 'waiting', 'working']);
const SORTS = ['attention', 'updated', 'host', 'name'];

const STATE_STYLE = { error: 'red', waiting: 'yellow', working: 'green', idle: 'dim', done: 'blue', stopped: 'dim' };
const STATE_GLYPH = { error: '✖', waiting: '◐', working: '●', idle: '○', done: '✓', stopped: '■' };
const STEP_GLYPH = { done: '✓', current: '◉', pending: '○' };
const STEP_STYLE = { done: 'green', current: 'yellow', pending: 'dim' };
const AGENT_STYLE = { claude: 'magenta', codex: 'cyan' };
const HOST_STYLE = { online: 'green', offline: 'red', connecting: 'yellow' };

function initialState({ allRuns = false, allSessions = false, collapseInactive = true } = {}) {
  return {
    view: 'runs',                     // or 'sessions'
    selKey: { sessions: null, runs: null }, // the selected row's id, so a refresh keeps it selected
    top: { sessions: 0, runs: 0 },    // first row shown
    filter: 'all', sort: 'attention', query: '', searching: false,
    detail: false, help: false, collapseInactive,
    confirm: null,  // what d asked about, waiting for y/n: {type: 'delete-run', run} or {type: 'delete-session', session}
    pending: null,  // the same, once confirmed, for the caller to carry out and clear
    message: null,  // one line for the footer, until the next key
    expanded: { sessions: allSessions, runs: allRuns }, // the collapsed row at the end of each table
  };
}

// ── rows ────────────────────────────────────────────────────────────────────

function matches(query, fields) {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => f && String(f).toLowerCase().includes(q));
}

function sessionRows(snapshot, st) {
  const list = (snapshot.sessions || []).filter((s) => {
    if (st.filter !== 'all' && s.state !== st.filter) return false;
    return matches(st.query, [s.name, s.cwd, s.host, s.agent, s.gitBranch, ...(s.steps || []).map((t) => t.title)]);
  });
  const recent = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const by = {
    attention: (a, b) => L.STATE_ORDER.indexOf(a.state) - L.STATE_ORDER.indexOf(b.state) || recent(a, b),
    updated: recent,
    host: (a, b) => a.host.localeCompare(b.host) || recent(a, b),
    name: (a, b) => String(a.name).localeCompare(String(b.name)) || recent(a, b),
  }[st.sort];
  const rows = list.sort(by).map((s) => ({ id: `${s.host}|${s.key}`, s }));
  if (st.filter !== 'all' || !st.collapseInactive) return rows; // a chosen state, or the hub's own list
  const active = rows.filter((row) => ACTIVE.has(row.s.state));
  const rest = rows.filter((row) => !ACTIVE.has(row.s.state));
  if (!rest.length) return active;
  const counts = L.stateCounts(rest.map((row) => row.s));
  const parts = L.STATE_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`);
  parts.push('no hub, so not active');
  return [...active, groupRow('sessions', rest.length, parts, isExpanded(st, 'sessions')),
    ...(isExpanded(st, 'sessions') ? rest : [])];
}

// A search looks through everything, so it opens the collapsed rows too.
function isExpanded(st, view) {
  return Boolean(st.expanded[view] || st.query);
}

function groupRow(view, count, parts, open) {
  return { id: `group|${view}`, group: { view, count, parts, open } };
}

// Exactly the page's rule (L.visibleRuns): runs still running are listed, in the order they
// started; finished ones and ones whose process is gone sit behind one "not running" row.
function runRows(snapshot, st) {
  const runs = (snapshot.runs || []).filter((r) => matches(st.query, [r.label, r.id, r.status, r.cwd, r.host, r.note]));
  const { live, finished } = L.visibleRuns(runs);
  const row = (r) => ({ id: `${r.host}|${r.id}`, r });
  if (!finished.length) return live.map(row);
  return [...live.map(row), groupRow('runs', finished.length, ['not running'], isExpanded(st, 'runs')),
    ...(isExpanded(st, 'runs') ? finished.map(row) : [])];
}

function rowsFor(snapshot, st) {
  return st.view === 'sessions' ? sessionRows(snapshot, st) : runRows(snapshot, st);
}

// Index of the selected row: the one whose id is selKey, else the first.
function selectedIndex(rows, st) {
  const i = rows.findIndex((row) => row.id === st.selKey[st.view]);
  return i >= 0 ? i : 0;
}

// ── keys ────────────────────────────────────────────────────────────────────

// Splits one chunk of raw terminal input into key names. A paste can bring several at once.
function parseKeys(chunk) {
  const keys = [];
  const named = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'backtab',
    '1~': 'home', '4~': 'end', '5~': 'pgup', '6~': 'pgdn', '7~': 'home', '8~': 'end' };
  for (let i = 0; i < chunk.length;) {
    const ch = chunk[i];
    if (ch === '\x1b' && (chunk[i + 1] === '[' || chunk[i + 1] === 'O')) {
      let j = i + 2;
      while (j < chunk.length && /[0-9;]/.test(chunk[j])) j++;
      const seq = chunk.slice(i + 2, j + 1);
      keys.push(named[seq] || named[seq.replace(/^1;\d+/, '')] || 'unknown');
      i = j + 1;
      continue;
    }
    const single = { '\x1b': 'esc', '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace',
      '\x03': 'ctrl-c', '\x15': 'ctrl-u' }[ch];
    keys.push(single || ch);
    i += ch.length;
  }
  return keys;
}

// Applies one key. Returns the new view state, or null to quit. `rows` and `pageSize` describe
// what is on screen now, so movement can be clamped and paged.
function handleKey(st, key, rows, pageSize) {
  const next = { ...st, selKey: { ...st.selKey }, top: { ...st.top }, message: null };
  if (st.confirm) {
    next.confirm = null;
    if (key === 'y' || key === 'Y') {
      next.pending = st.confirm;
      // Select the row below (or above), so the table doesn't jump to the top when it goes.
      const { run, session } = st.confirm;
      const rowId = run ? `${run.host}|${run.id}` : `${session.host}|${session.key}`;
      const i = rows.findIndex((row) => row.id === rowId);
      const neighbour = rows[i + 1] && !rows[i + 1].group ? rows[i + 1] : rows[i - 1];
      if (i >= 0 && neighbour) next.selKey[st.view] = neighbour.id;
    } else {
      next.message = 'Kept it.';
    }
    return next;
  }
  if (st.searching) {
    if (key === 'enter') next.searching = false;
    else if (key === 'esc') { next.searching = false; next.query = ''; }
    else if (key === 'backspace') next.query = st.query.slice(0, -1);
    else if (key === 'ctrl-u') next.query = '';
    else if (key === 'ctrl-c') return null;
    else if ([...key].length === 1 && key >= ' ') next.query = st.query + key;
    return next;
  }
  if (st.help) {
    if (key === 'q' || key === 'ctrl-c') return null;
    next.help = false; // any other key closes help
    return next;
  }
  const n = rows.length;
  const move = (delta) => {
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, selectedIndex(rows, st) + delta));
    next.selKey[st.view] = rows[i].id;
  };
  const cycle = (list, value, step = 1) => list[(list.indexOf(value) + step + list.length) % list.length];
  switch (key) {
    case 'q': case 'ctrl-c': return null;
    case 'up': case 'k': move(-1); break;
    case 'down': case 'j': move(1); break;
    case 'pgup': case 'b': move(-Math.max(1, pageSize)); break;
    case 'pgdn': case ' ': move(Math.max(1, pageSize)); break;
    case 'home': case 'g': move(-Infinity); break;
    case 'end': case 'G': move(Infinity); break;
    case 'enter': {
      const row = rows[selectedIndex(rows, st)];
      if (row && row.group) next.expanded = { ...st.expanded, [st.view]: !st.expanded[st.view] };
      else next.detail = !st.detail;
      break;
    }
    case 'esc': if (st.detail) next.detail = false; else if (st.query) next.query = ''; break;
    case 'tab': case 'backtab': case 'left': case 'right': next.view = st.view === 'sessions' ? 'runs' : 'sessions'; break;
    case '1': next.view = 'sessions'; break;
    case '2': next.view = 'runs'; break;
    case 'f': next.filter = cycle(FILTERS, st.filter); next.view = 'sessions'; break;
    case 'F': next.filter = cycle(FILTERS, st.filter, -1); next.view = 'sessions'; break;
    case 's': next.sort = cycle(SORTS, st.sort); break;
    case 'a': next.expanded = { ...st.expanded, [st.view]: !st.expanded[st.view] }; break;
    case '/': next.searching = true; break;
    case '?': case 'h': next.help = true; break;
    case 'd': {
      const row = rows[selectedIndex(rows, st)];
      if (row && row.r) next.confirm = { type: 'delete-run', run: row.r };
      else if (row && row.s && row.s.agent === 'claude' && row.s.kind === 'interactive') {
        next.message = `${oneLine(row.s.name)} is running in a terminal${row.s.pid ? ` (pid ${row.s.pid})` : ''}; quit it there.`;
      } else if (row && row.s) next.confirm = { type: 'delete-session', session: row.s };
      else next.message = 'd deletes the selected run or session; select one first.';
      break;
    }
    default: break;
  }
  return next;
}

// ── drawing helpers ─────────────────────────────────────────────────────────

// Exactly `w` columns: cut with "…" or padded with spaces.
function cell(text, w, align = 'left') {
  if (w <= 0) return '';
  const t = fit(String(text ?? ''), w);
  const gap = ' '.repeat(Math.max(0, w - visibleWidth(t)));
  return align === 'right' ? gap + t : t + gap;
}

function shortAgo(ms, now) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function bar(fraction, cells) {
  const full = Math.max(0, Math.min(cells, Math.round(fraction * cells)));
  return '█'.repeat(full) + '░'.repeat(cells - full);
}

function fmtRate(rate, unit) {
  if (!(typeof rate === 'number' && rate > 0)) return '';
  const v = rate >= 10 ? String(Math.round(rate)) : String(Math.round(rate * 10) / 10);
  return `${v}${unit ? ` ${unit}` : ''}/s`;
}

function homeOf(snapshot, host) {
  const h = (snapshot.hosts || []).find((x) => x.name === host);
  return h && h.info && h.info.home;
}

// ── header ──────────────────────────────────────────────────────────────────

function hostLine(h, snapshot, p, now, nameW) {
  const mode = L.hostMode(h);
  const glyph = p(HOST_STYLE[mode], '●');
  const name = p('bold', cell(h.name, nameW));
  if (mode === 'offline') {
    const why = oneLine(String(h.error || '').split('\n')[0]);
    return `${glyph} ${name} ${p('red', h.status === 'error' ? 'error' : 'offline')}  ${p('dim', why)}`;
  }
  if (mode === 'connecting') return `${glyph} ${name} ${p('yellow', 'connecting…')}`;
  const sessions = (snapshot.sessions || []).filter((s) => s.host === h.name);
  const counts = L.stateCounts(sessions);
  const parts = L.STATE_ORDER.filter((st) => counts[st]).map((st) => p(STATE_STYLE[st], `${counts[st]} ${st}`));
  const hidden = h.hiddenCount > 0 ? p('dim', ` +${h.hiddenCount} hidden`) : '';
  const runs = { running: L.visibleRuns((snapshot.runs || []).filter((r) => r.host === h.name)).live };
  // Every GPU a running run uses, once each, in number order (other hosts' "host:index" last).
  const used = [...new Set(runs.running.flatMap((r) => (Array.isArray(r.gpus) ? r.gpus : [])).map(String))]
    .sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  const gpus = L.gpuLabel(used, h.name)
    .replace(new RegExp(`^${h.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), '');
  const runText = `${runs.running.length} run${runs.running.length === 1 ? '' : 's'} running${gpus ? ` on ${gpus}` : ''}`;
  const problems = (h.notes || []).length + (h.errors || []).length;
  return `${glyph} ${name} ${p('dim', `synced ${shortAgo(h.lastSyncAt, now)}`)}  │ ${parts.join(' ') || p('dim', 'no sessions')}${hidden}  │ ${runText}`
    + (problems ? `  ${p('yellow', `⚠ ${problems}`)}` : '');
}

// ── tables ──────────────────────────────────────────────────────────────────

function sessionColumns(width, hostW) {
  const fixed = { mark: 2, host: hostW, agent: 6, state: 16, steps: 13, upd: 5 };
  const used = Object.values(fixed).reduce((a, b) => a + b, 0) + 6; // single spaces between columns
  const rest = Math.max(10, width - used);
  const name = Math.max(10, Math.round(rest * 0.45));
  return { ...fixed, name, where: Math.max(0, rest - name - 1) };
}

function sessionHeader(c) {
  return `  ${cell('HOST', c.host)} ${cell('AGENT', c.agent)} ${cell('STATE', c.state)} ${cell('STEPS', c.steps)} ${cell('UPD', c.upd, 'right')} ${cell('NAME', c.name)} ${cell('WHERE', c.where)}`;
}

function stepsCell(s, p, w) {
  if (!s.steps.length) return cell(p('dim', '—'), w);
  const done = s.steps.filter((t) => t.status === 'done').length;
  const count = `${done}/${s.steps.length}`;
  const cells = Math.max(3, w - count.length - 1);
  return cell(`${p(done === s.steps.length ? 'blue' : 'green', bar(done / s.steps.length, cells))} ${count}`, w);
}

function sessionRow(s, c, p, now, home) {
  const state = `${STATE_GLYPH[s.state] || '?'} ${L.STATE_LABEL[s.state] || s.state}`;
  const where = [L.displayPath(s.cwd, home), L.whereText(s)].filter(Boolean).join(' · ');
  const name = s.waitingFor ? `${oneLine(s.name)} ${p('yellow', `(${oneLine(s.waitingFor)})`)}` : oneLine(s.name);
  return `${cell(s.host, c.host)} ${p(AGENT_STYLE[s.agent], cell(s.agent, c.agent))} ${p(STATE_STYLE[s.state], cell(state, c.state))} `
    + `${stepsCell(s, p, c.steps)} ${cell(shortAgo(s.updatedAt, now), c.upd, 'right')} ${cell(p('bold', name), c.name)} ${p('dim', cell(oneLine(where), c.where))}`;
}

function runColumns(width, hostW) {
  const fixed = { mark: 2, host: hostW, prog: 16, count: 15, eta: 8, gpu: 9 };
  const used = Object.values(fixed).reduce((a, b) => a + b, 0) + 6;
  const rest = Math.max(10, width - used);
  const name = Math.max(10, Math.round(rest * 0.5));
  return { ...fixed, name, status: Math.max(0, rest - name - 1) };
}

function runHeader(c) {
  return `  ${cell('HOST', c.host)} ${cell('RUN', c.name)} ${cell('PROGRESS', c.prog)} ${cell('DONE', c.count, 'right')} ${cell('ETA', c.eta, 'right')} ${cell('GPU', c.gpu)} ${cell('STATUS', c.status)}`;
}

function runRow(r, c, p, measuring) {
  const prog = L.runProgress(r);
  const progCell = prog.percent === null ? cell('', c.prog)
    : cell(`${p(r.finished ? 'dim' : 'green', bar(prog.percent / 100, c.prog - 5))} ${String(prog.percent).padStart(3)}%`, c.prog);
  let eta = r.etaSource ? L.durationText(r.etaSeconds) : (measuring && prog.percent !== null && !r.finished ? '…' : '');
  if (r.finished) eta = p('dim', 'done');
  else if (r.alive === false) eta = p('red', 'gone');
  const gpus = L.gpuLabel(r.gpus, r.host).split(' · ').map((g) => g.replace(new RegExp(`^${r.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} GPU `), '')).join(' ');
  return `${cell(r.host, c.host)} ${cell(p('bold', oneLine(r.label || r.id)), c.name)} ${progCell} ${cell(prog.text, c.count, 'right')} `
    + `${cell(eta, c.eta, 'right')} ${cell(gpus, c.gpu)} ${cell(oneLine(r.status || ''), c.status)}`;
}

// ── details pane ────────────────────────────────────────────────────────────

function sessionDetail(s, ctx, height) {
  const { p, now, notes, home } = ctx;
  const out = [`${p('bold', oneLine(s.name))}  ${p(AGENT_STYLE[s.agent], s.agent)} · ${p(STATE_STYLE[s.state], L.STATE_LABEL[s.state] || s.state)} · ${s.host}`,
    p('dim', [L.displayPath(s.cwd, home), L.whereText(s), s.gitBranch ? `⎇ ${s.gitBranch}` : '',
      `updated ${L.relativeTime(s.updatedAt, now)}`, s.pid ? `pid ${s.pid}` : '', s.key].filter(Boolean).join(' · '))];
  if (s.waitingFor) out.push(p('yellow', `${s.agent === 'codex' ? 'Codex' : 'Claude'} is waiting: ${oneLine(s.waitingFor)}`));
  if (s.error) out.push(p('red', oneLine(s.error)));
  const note = notes && notes[`${s.host}|${s.key}`];
  if (note) out.push(p('blue', `✎ ${oneLine(String(note.text || '').split('\n')[0])}`));
  if (!s.steps.length) { out.push(p('dim', "No roadmap yet: this session hasn't created any tasks.")); return out; }
  // As many steps as fit, in a window that keeps the first current step in view.
  const room = Math.max(1, height - out.length);
  const firstCurrent = Math.max(0, s.steps.findIndex((t) => t.status === 'current'));
  let start = 0;
  if (s.steps.length > room) start = Math.min(Math.max(0, firstCurrent - Math.floor(room / 3)), s.steps.length - room + 1);
  const shown = s.steps.slice(start, start + (s.steps.length - start > room ? room - 1 : room));
  if (start > 0) shown[0] = null; // replaced by an "earlier" marker below
  const lines = shown.map((t, i) => {
    if (t === null) return p('dim', `  ↑ ${start + 1} earlier`);
    const id = s.agent === 'claude' ? p('dim', `#${t.id} `) : '';
    const after = t.blockedBy && t.blockedBy.length ? p('dim', `  after ${t.blockedBy.map((a) => `#${a}`).join(' ')}`) : '';
    const title = t.status === 'current' && t.activeForm ? `${oneLine(t.title)} ${p('dim', `— ${oneLine(t.activeForm)}`)}`
      : (t.status === 'pending' ? p('dim', oneLine(t.title)) : oneLine(t.title));
    return `  ${p(STEP_STYLE[t.status], STEP_GLYPH[t.status] || '?')} ${id}${title}${after}`;
  });
  const left = s.steps.length - start - shown.length;
  if (left > 0) lines.push(p('dim', `  ↓ ${left} more`));
  return [...out, ...lines];
}

function runDetail(r, ctx, width) {
  const { p, now, home, measuring } = ctx;
  const prog = L.runProgress(r);
  const change = L.lastChange(r);
  const out = [`${p('bold', oneLine(r.label || r.id))}  ${p('dim', r.id)} · ${r.host}${r.status ? ` · ${oneLine(r.status)}` : ''}`];
  if (prog.percent !== null) out.push(`${p('green', bar(prog.percent / 100, Math.max(10, Math.min(60, width - 30))))} ${prog.percent}%  ${prog.text}`);
  const eta = measuring ? L.etaText(r) : (r.etaSource ? L.etaText(r) : '');
  const changed = change.at === null ? '' : (change.source === 'advanced'
    ? `no change for ${L.durationText((now - change.at) / 1000)}` : `written ${L.relativeTime(change.at, now)}`);
  out.push([fmtRate(r.rate, r.unit), eta, changed, r.finished ? 'finished' : (r.alive === false ? p('red', 'no longer running') : '')]
    .filter(Boolean).join(' · '));
  out.push(p('dim', [L.gpuLabel(r.gpus, r.host), r.pid ? `pid ${r.pid}` : '', L.displayPath(r.cwd, home),
    r.startedAt ? `started ${L.relativeTime(r.startedAt, now)}` : ''].filter(Boolean).join(' · ')));
  if (r.session) out.push(p('dim', `session ${r.session}`));
  if (r.note) out.push(oneLine(r.note));
  if (r.error) out.push(p('red', oneLine(r.error)));
  return out;
}

const HELP = [
  ['↑ ↓  j k', 'move the selection'], ['PgUp PgDn  b Space', 'move a page'], ['g G  Home End', 'first / last row'],
  ['Enter', 'open / close details for the selected row'], ['Tab  1 2', 'sessions / runs'],
  ['f  F', 'filter sessions by state (all shows error, waiting, working, and the rest collapsed)'],
  ['s', 'sort sessions: attention, updated, host, name'], ['/', 'search names, folders, hosts, steps, run labels (Enter keeps, Esc clears)'],
  ['a  (Enter on ▸ row)', 'expand / collapse the ▸ row: runs not running; without a hub, idle, done, stopped sessions'],
  ['d', "delete the selected run's record, or remove the selected session the agent's own way (asks first)"],
  ['Esc', 'close details, then clear the search'],
  ['q  Ctrl-C', 'quit'],
];

// What d is about to do, in words, so y/n is an informed answer.
function confirmText(c) {
  if (c.type === 'delete-run') {
    const r = c.run;
    const still = r.alive === true && !r.finished ? ' It is still running, so its writer will make it again.' : '';
    return `Delete ${oneLine(r.label || r.id)}'s record ${r.host}:${r.dir}/${r.id}.json?${still}`;
  }
  const s = c.session;
  const name = `"${oneLine(s.name)}" on ${s.host}`;
  if (s.agent === 'codex') return `Archive Codex session ${name} (codex archive ${s.id}; codex unarchive brings it back)?`;
  if (s.kind === 'background') return `Remove background session ${name} (claude rm ${s.short || s.id}; the conversation is kept)?`;
  return `Delete the task list of ${name} (~/.claude/tasks/${s.id}; the conversation is kept)?`;
}

// ── screen ──────────────────────────────────────────────────────────────────

// Returns exactly `height` lines, each at most `width` columns, the page size it used, and where
// the table is scrolled to.
function screen(snapshot, st, { width, height, now, color, source, measuring, notes, error }) {
  const p = painter(color);
  const hosts = snapshot.hosts || [];
  const nameW = Math.min(20, Math.max(4, ...hosts.map((h) => h.name.length)));
  const time = new Date(now).toLocaleTimeString([], { hour12: false });
  const top = [];
  const right = `filter ${st.filter} · sort ${st.sort}${st.query ? ` · search "${st.query}"` : ''}`;
  const left = `${p('bold', 'Switchyard')}  ${p('dim', source)}  ${time}`;
  top.push(`${left}${' '.repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)))}${p('cyan', right)}`);
  for (const h of hosts) top.push(hostLine(h, snapshot, p, now, nameW));
  if (error) top.push(p('red', `! last refresh failed: ${oneLine(error)} (showing the last good data)`));

  // The current tab and the selected row are marked, never shown in inverse video.
  const tab = (label, on) => (on ? p('bold cyan underline', `▶ ${label}`) : p('dim', `  ${label}`));
  // "4 running · +2 not running", "4 active · +4 more": what is listed, then what is collapsed.
  const tabLabel = (view, word, rest) => {
    const list = view === 'sessions' ? sessionRows(snapshot, st) : runRows(snapshot, st);
    const group = list.find((row) => row.group);
    const head = list.filter((row) => !row.group).length - (group && group.group.open ? group.group.count : 0);
    return `${head}${word ? ` ${word}` : ''}${group ? ` · +${group.group.count} ${rest}` : ''}`;
  };
  const sessionWord = st.filter !== 'all' ? st.filter : (st.collapseInactive ? 'active' : '');
  top.push(`${tab(`1 Sessions ${tabLabel('sessions', sessionWord, 'more')}`, st.view === 'sessions')}   `
    + `${tab(`2 Runs ${tabLabel('runs', 'running', 'not running')}`, st.view === 'runs')}`);

  const rows = rowsFor(snapshot, st);
  const hostW = nameW;
  const cols = st.view === 'sessions' ? sessionColumns(width, hostW) : runColumns(width, hostW);
  top.push(p('bold underline', cell(st.view === 'sessions' ? sessionHeader(cols) : runHeader(cols), width)));

  let footerLine = p('dim', '↑↓ move  Enter details  Tab sessions/runs  a expand rest  d delete  f filter  s sort  / search  ? help  q quit');
  if (st.searching) footerLine = `/${st.query}█  ${p('dim', 'Enter keep · Esc clear')}`;
  // [y/n] goes first: a long question gets cut at the screen's edge.
  else if (st.confirm) footerLine = p('bold red', `[y/n] ${confirmText(st.confirm)}`);
  else if (st.message) footerLine = p('yellow', oneLine(st.message));
  const free = Math.max(1, height - top.length - 1);
  // The details pane takes the lower part of the screen; the table keeps at least a few rows.
  const selRow = rows[selectedIndex(rows, st)];
  const detailH = st.detail && selRow && !selRow.group && !st.help ? Math.max(4, Math.min(free - 3, Math.floor(free * 0.45))) : 0;
  const listH = Math.max(1, free - detailH);

  let body;
  let scrollTop = st.top[st.view];
  if (st.help) {
    body = ['', ...HELP.map(([k, v]) => `  ${p('bold', cell(k, 22))} ${v}`), '', p('dim', '  any key closes this help')];
  } else if (!rows.length) {
    const why = st.query ? `Nothing matches "${st.query}".` : (st.view === 'runs' ? 'No runs reported.'
      : (st.filter === 'all' ? 'No sessions.' : `No ${st.filter} sessions. Press f to change the filter.`));
    body = ['', `  ${p('dim', why)}`];
  } else {
    const sel = selectedIndex(rows, st);
    // Keep the selection on screen, scrolling as little as possible.
    let first = Math.min(st.top[st.view], Math.max(0, rows.length - listH));
    if (sel < first) first = sel;
    if (sel >= first + listH) first = sel - listH + 1;
    scrollTop = first;
    body = rows.slice(first, first + listH).map((row, i) => {
      const isSel = first + i === sel;
      let text;
      if (row.group) {
        const g = row.group;
        const what = g.view === 'runs' ? `${g.count} not running` : `${g.count} more: ${g.parts.join(' · ')}`;
        text = p('dim', `${g.open ? '▾' : '▸'} ${what}  (Enter or a to ${g.open ? 'collapse' : 'show'})`);
      } else {
        const home = homeOf(snapshot, row.s ? row.s.host : row.r.host);
        text = row.s ? sessionRow(row.s, cols, p, now, home) : runRow(row.r, cols, p, measuring);
      }
      return `${isSel ? p('bold cyan', '▶ ') : '  '}${text}`;
    });
    if (rows.length > listH) {
      const last = Math.min(rows.length, first + listH);
      top[top.length - 1] = p('bold underline', cell(`${st.view === 'sessions' ? sessionHeader(cols) : runHeader(cols)}`, width - 12)
        + cell(` ${first + 1}-${last}/${rows.length}`, 12, 'right'));
    }
  }
  while (body.length < listH) body.push('');
  body = body.slice(0, listH);

  let detail = [];
  if (detailH) {
    const row = selRow;
    const home = homeOf(snapshot, row.s ? row.s.host : row.r.host);
    const ctx = { p, now, notes, home, measuring };
    const content = row.s ? sessionDetail(row.s, ctx, detailH - 1) : runDetail(row.r, ctx, width);
    detail = [p('dim', '─'.repeat(width)), ...content.map((l) => ` ${l}`)].slice(0, detailH);
    while (detail.length < detailH) detail.push('');
  }

  const lines = [...top, ...body, ...detail, footerLine].slice(0, height);
  while (lines.length < height) lines.splice(lines.length - 1, 0, '');
  // scrollTop: the first row shown, for the caller to keep in its state for the next frame.
  return { lines: lines.map((l) => fit(l, width)), pageSize: Math.max(1, listH - 1), scrollTop };
}

module.exports = { initialState, handleKey, parseKeys, screen, sessionRows, runRows, rowsFor, selectedIndex,
  FILTERS, SORTS };
