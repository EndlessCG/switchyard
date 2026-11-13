'use strict';
// Turns a fleet snapshot ({hosts, sessions, runs}, the shape of GET /api/fleet) into terminal
// text. Pure: no I/O, no clock of its own. Wording and ordering come from public/layout.js, the
// same helpers the web page uses, so the terminal and the page say the same things.
const L = require('../public/layout');

const ESC = '\x1b[';
const STYLE = {
  bold: '1', dim: '2', underline: '4', red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36',
};
// Claude lines are mauve and Codex lines teal on the page; the nearest ANSI colors.
const AGENT_STYLE = { claude: 'magenta', codex: 'cyan' };
const STATE_STYLE = { error: 'red', waiting: 'yellow', working: 'green', idle: 'dim', done: 'blue', stopped: 'dim' };
const STATE_GLYPH = { error: '✖', waiting: '◐', working: '●', idle: '○', done: '✓', stopped: '■' };
const STEP_GLYPH = { done: '✓', current: '◉', pending: '○' };
const STEP_STYLE = { done: 'green', current: 'yellow', pending: 'dim' };
const HOST_STYLE = { online: 'green', offline: 'red', connecting: 'yellow' };
const ACTIVE = new Set(['error', 'waiting', 'working']); // the states that want a look

function painter(color) {
  return (style, text) => {
    if (!color || !style || text === '') return text;
    const codes = style.split(' ').map((s) => STYLE[s]).join(';');
    return `${ESC}${codes}m${text}${ESC}0m`;
  };
}

// Terminal columns a code point takes: East Asian wide/fullwidth characters and emoji take two.
function charWidth(cp) {
  if (cp < 0x1100) return 1;
  if ((cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

// Visible columns of a line that may hold ANSI color codes.
function visibleWidth(line) {
  let n = 0;
  for (const ch of line.replace(/\x1b\[[0-9;]*m/g, '')) n += charWidth(ch.codePointAt(0));
  return n;
}

// Cuts a line (which may hold ANSI color codes) to `width` visible columns, ending in "…".
// width null: leave it alone (output is going to a file or a pipe, not a screen).
function fit(line, width) {
  if (!width || visibleWidth(line) <= width) return line;
  let out = '';
  let cols = 0;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { out += part; continue; } // escape codes take no columns
    for (const ch of part) {
      const w = charWidth(ch.codePointAt(0));
      if (cols + w > width - 1) return `${out}…${out.includes('\x1b[') ? `${ESC}0m` : ''}`;
      out += ch;
      cols += w;
    }
  }
  return out;
}

// Collector text may hold newlines or control characters; one session row is one line.
function oneLine(text) {
  return String(text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
}

function bar(percent, cells) {
  const full = Math.round((percent / 100) * cells);
  return '█'.repeat(full) + '░'.repeat(cells - full);
}

function fmtRate(rate) {
  return rate >= 10 ? String(Math.round(rate)) : String(Math.round(rate * 10) / 10);
}

function syncText(h, now) {
  if (h.status === 'online') return `online · synced ${L.relativeTime(h.lastSyncAt, now)}`;
  return { connecting: 'connecting…', offline: 'offline', error: 'error' }[h.status] || h.status;
}

function countsText(list, p) {
  const counts = L.stateCounts(list);
  return L.STATE_ORDER.filter((st) => counts[st])
    .map((st) => p(STATE_STYLE[st], `${counts[st]} ${L.STATE_LABEL[st].toLowerCase()}`)).join(' · ');
}

function runLines(host, r, ctx) {
  const { p, now, home } = ctx;
  const prog = L.runProgress(r);
  const change = L.lastChange(r);
  const dead = r.alive === false && !r.finished;
  const head = [p('bold', oneLine(r.label || r.id))];
  if (prog.percent !== null) head.push(`${p(r.finished ? 'dim' : 'green', bar(prog.percent, 20))} ${String(prog.percent).padStart(3)}%`);
  if (r.status) head.push(oneLine(r.status));
  if (r.finished) head.push(p('dim', 'finished'));
  // "measuring…" promises an ETA once the rate is known; a one-shot view never gets there.
  const eta = ctx.measuring ? L.etaText(r) : (r.etaSource ? L.etaText(r) : '');
  const rate = typeof r.rate === 'number' && r.rate > 0 ? `${fmtRate(r.rate)}${r.unit ? ` ${r.unit}` : ''}/s` : '';
  const changed = change.at === null ? ''
    : (change.source === 'advanced' ? `no change for ${L.durationText((now - change.at) / 1000)}`
      : `written ${L.relativeTime(change.at, now)}`);
  const meta = [prog.text, rate, eta, dead ? p('red', 'no longer running') : '', L.gpuLabel(r.gpus, host),
    changed, r.session || '', L.displayPath(r.cwd, home), r.note || ''].map(oneLine).filter(Boolean);
  const out = [`   ${head.join('  ')}`];
  if (meta.length) out.push(`     ${p('dim', meta.join(' · '))}`);
  if (r.error) out.push(`     ${p('red', oneLine(r.error))}`);
  return out;
}

function stepSummary(s, p) {
  if (!s.steps.length) return p('dim', 'no roadmap yet');
  const strip = s.steps.map((t) => p(STEP_STYLE[t.status], STEP_GLYPH[t.status] || '?')).join('');
  const done = s.steps.filter((t) => t.status === 'done').length;
  const current = s.steps.filter((t) => t.status === 'current');
  const pending = s.steps.find((t) => t.status === 'pending');
  let what = '';
  if (current.length) what = `now: ${current.map((t) => oneLine(t.activeForm || t.title)).join(' · ')}`;
  else if (pending) what = p('dim', `next: ${oneLine(pending.title)}`);
  return `${strip} ${done}/${s.steps.length}${what ? `  ${what}` : ''}`;
}

function stepListLines(s, p) {
  if (!s.steps.length) return [`      ${p('dim', "No roadmap yet: this session hasn't created any tasks.")}`];
  return s.steps.map((t) => {
    const id = s.agent === 'claude' ? p('dim', `#${t.id} `) : '';
    const after = t.blockedBy && t.blockedBy.length ? p('dim', `  after ${t.blockedBy.map((a) => `#${a}`).join(' ')}`) : '';
    const title = t.status === 'pending' ? p('dim', oneLine(t.title)) : oneLine(t.title);
    return `      ${p(STEP_STYLE[t.status], STEP_GLYPH[t.status] || '?')} ${id}${title}${after}`;
  });
}

function sessionLines(s, ctx) {
  const { p, now, home } = ctx;
  const label = `${STATE_GLYPH[s.state] || '?'} ${(L.STATE_LABEL[s.state] || s.state).padEnd(14)}`;
  const head = [p(STATE_STYLE[s.state], label), p(AGENT_STYLE[s.agent], s.agent.padEnd(6)), p('bold', oneLine(s.name))];
  const where = [L.displayPath(s.cwd, home), L.whereText(s), s.gitBranch ? `⎇ ${s.gitBranch}` : '',
    `updated ${L.relativeTime(s.updatedAt, now)}`].map(oneLine).filter(Boolean);
  const out = [`   ${head.join(' ')}  ${p('dim', where.join(' · '))}`];
  if (s.error) out.push(`      ${p('red', oneLine(s.error))}`);
  if (s.waitingFor) out.push(`      ${p('yellow', `${s.agent === 'codex' ? 'Codex' : 'Claude'} is waiting: ${oneLine(s.waitingFor)}`)}`);
  if (ctx.notes && ctx.notes[`${ctx.host}|${s.key}`]) {
    out.push(`      ${p('blue', `✎ ${oneLine(String(ctx.notes[`${ctx.host}|${s.key}`].text || '').split('\n')[0])}`)}`);
  }
  if (ctx.steps) out.push(...stepListLines(s, p));
  else out.push(`      ${stepSummary(s, p)}`);
  return out;
}

function hostLines(h, sessions, runs, opts) {
  const p = painter(opts.color);
  const now = opts.now;
  const home = h.info && h.info.home;
  const ctx = { p, now, home, host: h.name, steps: opts.steps, measuring: opts.measuring, notes: opts.notes };
  const mode = L.hostMode(h);
  const sub = h.info ? p('dim', `${h.info.hostname} · Python ${h.info.python}`) : '';
  const out = [`${p(`bold ${HOST_STYLE[mode]}`, '▌')} ${p('bold', h.name)}  ${p(HOST_STYLE[mode], syncText(h, now))}  ${sub}`];
  if (mode === 'offline') {
    out.push(`   ${p('red', h.status === 'error' ? `The collector on ${h.name} stopped with an error.` : `Can't reach ${h.name}.`)}`);
    if (h.error) out.push(...String(h.error).trim().split('\n').map((l) => `   ${p('dim', l)}`));
    if (h.lastSyncAt) out.push(`   ${p('dim', `last synced ${L.relativeTime(h.lastSyncAt, now)}, ${h.sessionCount} sessions then`)}`);
    return out;
  }
  if (mode === 'connecting') return [...out, `   ${p('dim', 'Connecting…')}`];
  for (const n of h.notes || []) out.push(`   ${p('yellow', `! ${oneLine(n)}`)}`);
  for (const e of h.errors || []) out.push(`   ${p('yellow', `! ${e.source} ${oneLine(e.message)}${e.count > 1 ? ` (×${e.count})` : ''}`)}`);

  if (runs.length) {
    // Exactly the page's rule (L.visibleRuns): running runs listed in start order; finished ones
    // and ones whose process is gone counted as "not running".
    const { live, finished } = L.visibleRuns(runs);
    out.push(`  ${p('bold', 'RUNS')}${live.length ? '' : p('dim', '  none running')}`);
    for (const r of opts.allRuns ? [...live, ...finished] : live) out.push(...runLines(h.name, r, ctx));
    if (finished.length && !opts.allRuns) out.push(`   ${p('dim', `▸ ${finished.length} not running (--all-runs to show)`)}`);
  }

  // Without a hub (no membership), with no --state and no --all, the sessions that want a look
  // are listed and the rest counted on one line, as in the interactive view.
  const collapse = opts.collapseInactive && !opts.states && opts.limit !== 'all';
  const rest = collapse ? sessions.filter((s) => !ACTIVE.has(s.state)) : [];
  let matching = opts.states ? sessions.filter((s) => opts.states.has(s.state)) : sessions;
  if (collapse) matching = matching.filter((s) => ACTIVE.has(s.state));
  const { shown, total } = L.visibleSessions(matching, { limit: opts.limit });
  const hidden = h.hiddenCount > 0 ? p('dim', `  ${h.hiddenCount} older hidden by the hub`) : '';
  out.push(`  ${p('bold', 'SESSIONS')}  ${countsText(sessions, p)}${hidden}`);
  if (!shown.length && !rest.length) {
    out.push(`   ${p('dim', sessions.length ? 'No sessions match the --state filter.' : 'Nothing open here yet.')}`);
  }
  for (const s of shown) out.push(...sessionLines(s, ctx));
  if (total > shown.length) out.push(`   ${p('dim', `showing ${shown.length} of ${total} · --limit N for more`)}`);
  if (rest.length) {
    const counts = L.stateCounts(rest);
    const parts = L.STATE_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`);
    out.push(`   ${p('dim', `▸ ${rest.length} more: ${parts.join(' · ')} · no hub, so not active (--all or --state to list)`)}`);
  }
  return out;
}

// opts: now (ms), color, width (columns or null), source (header text), limit (number|'all'),
// states (Set|null), steps, allRuns, measuring, notes ({"host|key": {text}} or null).
function render(snapshot, opts) {
  const p = painter(opts.color);
  const sessions = snapshot.sessions || [];
  const runs = snapshot.runs || [];
  const time = new Date(opts.now).toLocaleTimeString([], { hour12: false });
  const lines = [`${p('bold', 'Switchyard')}  ${p('dim', `${opts.source} · ${time}`)}  ${countsText(sessions, p)}`, ''];
  for (const h of snapshot.hosts || []) {
    lines.push(...hostLines(h, sessions.filter((s) => s.host === h.name), runs.filter((r) => r.host === h.name), opts), '');
  }
  return lines.map((l) => fit(l, opts.width)).join('\n');
}

module.exports = { render, fit, visibleWidth, charWidth, painter, oneLine };
