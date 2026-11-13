/* Switchyard roadmap page: a live view of every host's sessions and runs. */
(function () {
  'use strict';
  const L = window.SwitchyardLayout;
  const LINE = { claude: 'var(--claude)', codex: 'var(--codex)' };
  const STATUS_WORD = { done: 'Done', current: 'Current', pending: 'Upcoming' };
  const $ = (id) => document.getElementById(id);

  const hosts = new Map();    // host name -> host view from the hub
  const sessions = new Map(); // host name -> Map(session key -> session)
  const runs = new Map();     // host name -> Map(run id -> run), as reported by the experiments
  let view = pref('switchyard-view', ['lines', 'cards'], 'lines');
  let limit = pref('switchyard-limit', ['20', '50', 'all'], '20');
  let filter = 'all';
  let open = null; // {kind: 'session', host, key}, {kind: 'add'} or {kind: 'changes'}: what the side panel shows
  let lastFocus = null;
  let addRows = []; // the last GET /api/dashboard/hidden result, while the add panel is open
  let changes = null; // the status changes panel's rows, newest first, or null while they load
  let changesBuffer = []; // status changes that arrive over SSE while the panel is loading
  let changesRange = pref('switchyard-changes-range', ['1h', '24h', '7d', 'all'], '24h');
  const showFinished = loadFinishedHosts(); // hosts whose finished runs are expanded
  let buffer = null; // events that arrive while a snapshot loads; replayed afterwards, in order
  const dirty = new Set();
  let frame = 0;

  function pref(name, allowed, fallback) {
    try {
      const v = localStorage.getItem(name);
      return allowed.includes(v) ? v : fallback;
    } catch (err) {
      console.info(`Saved ${name} unavailable (${err.name}); using ${fallback}.`);
      return fallback;
    }
  }
  function savePref(name, value) {
    try {
      localStorage.setItem(name, value);
    } catch (err) {
      console.info(`Couldn't save ${name} (${err.name}); the choice lasts until you reload.`);
    }
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const code = (s) => `<code>${esc(s)}</code>`;
  const home = (host) => hosts.get(host)?.info?.home || null;
  const path = (host, p) => L.displayPath(p, home(host));
  const ago = (ms) => `<span data-ago="${ms || ''}">${esc(L.relativeTime(ms, Date.now()))}</span>`;
  // "no change for 14m": a duration, not a point in time, kept live by the same interval.
  const since = (ms) => `<span data-since="${ms || ''}">${esc(L.durationText((Date.now() - ms) / 1000))}</span>`;
  const inSeconds = (ms) => `in ${Math.max(0, Math.ceil((ms - Date.now()) / 1000))} s`;
  const until = (ms) => `<span data-until="${ms}">${inSeconds(ms)}</span>`;
  const doneCount = (s) => s.steps.filter((t) => t.status === 'done').length;

  // Hosts with their finished runs revealed. Stored as a comma-joined list, which `pref`'s
  // fixed-value check can't express, so it's read here with the same storage guard.
  function loadFinishedHosts() {
    try {
      return new Set((localStorage.getItem('switchyard-finished-runs') || '').split(',').filter(Boolean));
    } catch (err) {
      console.info(`Saved switchyard-finished-runs unavailable (${err.name}); starting collapsed.`);
      return new Set();
    }
  }

  const whereText = L.whereText;

  // ── rendering ────────────────────────────────────────────────────────────
  function metaHTML(host, s) {
    const prog = s.steps.length ? `${doneCount(s)} of ${s.steps.length} steps` : 'no steps';
    const openKey = `${esc(host)}|${esc(s.key)}`;
    // A plain div (mouse-clickable via [data-open], no role/tabindex of its own): it holds the
    // real Remove <button> as a sibling, and a focusable-but-nested-interactive `role="button"`
    // wrapper around a real button breaks ARIA (screen readers may hide the nested control).
    // The session name is its own real <button>, so keyboard focus/Enter/Space come for free.
    return `<div class="sess-meta" data-open="${openKey}">
      <button type="button" class="sess-open" data-open="${openKey}"><span class="sess-name">${esc(s.name)}</span></button>
      <span class="chips"><span class="line-chip">${esc(s.agent)}</span><span class="pill" data-st="${esc(s.state)}">${L.STATE_LABEL[s.state]}</span>
        <button class="remove-btn" type="button" data-remove="${openKey}">Remove</button>
      </span>
      <span class="meta-line"><span>${esc(path(host, s.cwd))}</span><span>${esc(whereText(s))}</span></span>
      <span class="meta-line"><span>${prog}</span><span>updated ${ago(s.updatedAt)}</span></span>
      ${s.error ? `<span class="err-line">${esc(s.error)}</span>` : ''}
      ${s.waitingFor ? `<span class="wait-line">${s.agent === 'codex' ? 'Codex' : 'Claude'} is waiting: ${esc(s.waitingFor)}</span>` : ''}
      ${noteLineHTML(host, s.key)}
    </div>`;
  }
  const EMPTY = `<p class="track-empty">No roadmap yet: this session hasn't created any tasks.</p>`;

  function stationHTML(s, t) {
    return `<div class="stn st-${esc(t.status)}" data-step="${esc(t.id)}">
      ${s.agent === 'claude' ? `<span class="stn-id">#${esc(t.id)}</span>` : ''}
      <span class="dot"></span>
      <span class="stn-label"><span class="sr">${STATUS_WORD[t.status]}: </span>${esc(t.title)}</span>
    </div>`;
  }
  function lineRowHTML(host, s) {
    let track = EMPTY;
    if (s.steps.length) {
      const note = s.agent === 'claude' && !L.hasDeps(s) ? `<p class="track-note">No dependencies declared, so steps are shown in task order.</p>` : '';
      const cols = L.columns(s).map((col) => `<div class="col">${col.map((t) => stationHTML(s, t)).join('')}</div>`).join('');
      track = `<div class="track-inner" data-sid="${esc(host)}|${esc(s.key)}"><svg class="rails" aria-hidden="true"></svg>${cols}</div>${note}`;
    }
    return `<article class="sess" style="--line:${LINE[s.agent]}" data-state="${esc(s.state)}">${metaHTML(host, s)}<div class="track" data-scroll="${esc(host)}|${esc(s.key)}">${track}</div></article>`;
  }
  function cardHTML(host, s) {
    const list = s.steps.length ? `<ol class="vlist">${s.steps.map((t, i) => {
      const next = s.steps[i + 1];
      const rail = !next ? 'last' : next.status === 'pending' ? 'next-pending' : '';
      const after = t.blockedBy && t.blockedBy.length ? `<span class="after">after ${t.blockedBy.map((a) => '#' + esc(a)).join(' ')}</span>` : '';
      return `<li class="vst st-${esc(t.status)} ${rail}"><span class="dot"></span><span class="vst-body"><span class="stn-label"><span class="sr">${STATUS_WORD[t.status]}: </span>${esc(t.title)}</span>${after}</span></li>`;
    }).join('')}</ol>` : EMPTY;
    return `<article class="card" style="--line:${LINE[s.agent]}" data-state="${esc(s.state)}">${metaHTML(host, s)}${list}</article>`;
  }

  // ── runs ────────────────────────────────────────────────────────────────
  // Everything printed here comes from a file an experiment wrote, so it is escaped as text.

  function fmtRate(rate) {
    return rate >= 10 ? String(Math.round(rate)) : String(Math.round(rate * 10) / 10);
  }

  function runRowHTML(host, r) {
    const p = L.runProgress(r);
    const change = L.lastChange(r);
    const dead = r.alive === false && !r.finished;
    const bar = p.percent === null ? ''
      : `<div class="bar"><i style="width:${p.percent}%"></i></div>`;
    const top = [`<b>${esc(r.label || r.id)}</b>`,
      p.percent === null ? '' : `<span class="pct">${p.percent}%</span>`,
      `<span class="rstatus">${esc(r.status || '')}</span>`].filter(Boolean).join(' ');
    const rate = typeof r.rate === 'number' && r.rate > 0
      ? `${esc(fmtRate(r.rate))}${r.unit ? ` ${esc(r.unit)}` : ''}/s` : '';
    const changed = change.at === null ? ''
      : (change.source === 'advanced' ? `no change for ${since(change.at)}` : `written ${ago(change.at)}`);
    const bits = [esc(L.gpuLabel(r.gpus, host)), esc(p.text), rate, esc(L.etaText(r)),
      dead ? 'no longer running' : '', changed, esc(r.session || ''),
      esc(path(host, r.cwd)), esc(r.note || '')].filter(Boolean);
    const err = r.error ? `<p class="rerr">${esc(r.error)}</p>` : '';
    return `<div class="run" data-run="${esc(r.id)}"${r.finished ? ' data-finished' : ''}${dead ? ' data-dead' : ''}>`
      + `${err}<div class="rtop">${top}</div>${bar}<div class="rmeta">${bits.join(' · ')}</div></div>`;
  }

  // Live runs, then a disclosure for the finished ones: records pile up until whoever wrote
  // them deletes them, and Switchyard never writes on a server.
  function runsBlockHTML(name) {
    const list = [...runs.get(name).values()];
    if (!list.length) return '';
    const { live, finished } = L.visibleRuns(list);
    const open = showFinished.has(name);
    const rows = [...live, ...(open ? finished : [])].map((r) => runRowHTML(name, r)).join('');
    const toggle = finished.length
      ? `<button type="button" class="link-btn rtoggle" data-finished-toggle="${esc(name)}">`
        + `${open ? '▾' : '▸'} ${finished.length} not running${open ? '' : ' · show'}</button>`
      : '';
    return `<section class="runs" aria-label="Runs on ${esc(name)}">${rows}${toggle}</section>`;
  }

  function syncText(h) {
    if (h.status === 'online') return `online · synced ${ago(h.lastSyncAt)}`;
    return { connecting: 'connecting…', offline: 'offline', error: 'error' }[h.status] || h.status;
  }

  function yardHTML(name) {
    const h = hosts.get(name);
    const mode = L.hostMode(h);
    const sub = h.info ? `${esc(h.info.hostname)} · Python ${esc(h.info.python)}` : '';
    const head = `<header class="yard-head"><h2>${esc(name)}</h2><span class="sub">${sub}</span><span class="sync" data-status="${mode}"><i></i><span data-sync="${esc(name)}">${syncText(h)}</span></span></header>`;
    if (mode === 'offline') {
      const what = h.status === 'error'
        ? `<b>The collector on ${esc(name)} stopped with an error.</b>`
        : `<b>Can't reach ${esc(name)}.</b> Connect to the VPN, or check this server's SSH alias in ${code('hosts.json')}.`;
      const retry = h.status === 'connecting' ? 'Retrying now…' : (h.retryAt ? `Retrying ${until(h.retryAt)}` : '');
      const last = h.lastSyncAt ? ` · last synced ${ago(h.lastSyncAt)}, ${h.sessionCount} sessions then` : '';
      return `${head}<div class="offline-box"><p>${what}</p><code class="errtext">${esc(h.error)}</code><p class="muted">${retry}${last}</p></div>`;
    }
    if (mode === 'connecting') return `${head}<p class="none">Connecting…</p>`;
    const problems = [...(h.notes || []).map((n) => esc(n)),
      ...(h.errors || []).map((e) => `${code(e.source)} ${esc(e.message)}${e.count > 1 ? ` (×${e.count})` : ''}`)];
    const box = problems.length ? `<div class="host-problems">${problems.map((p) => `<span>${p}</span>`).join('')}</div>` : '';
    // Runs are their own block: the limit menu bounds the session list and the state chips
    // filter a session's derived state, neither of which a run has.
    const runsBlock = runsBlockHTML(name);
    const { shown, total } = L.visibleSessions([...sessions.get(name).values()], { filter, limit: limit === 'all' ? 'all' : Number(limit) });
    const addLink = `<button type="button" class="link-btn" data-open-add>· add</button>`;
    const hiddenNote = (n) => `${esc(n)} older session${n === 1 ? '' : 's'} hidden`;
    if (!shown.length) {
      if (h.sessionCount === 0) {
        const parenthetical = h.hiddenCount > 0 ? ` (${hiddenNote(h.hiddenCount)} ${addLink})` : '';
        return `${head}${box}${runsBlock}<p class="none">Nothing open here yet: sessions appear when they run or get new activity.${parenthetical}</p>`;
      }
      return `${head}${box}${runsBlock}<p class="none">${filter === 'all' ? 'No sessions on this server.' : `No ${L.STATE_LABEL[filter].toLowerCase()} sessions on this server.`}</p>`;
    }
    const body = view === 'lines' ? `<div>${shown.map((s) => lineRowHTML(name, s)).join('')}</div>` : `<div class="cards">${shown.map((s) => cardHTML(name, s)).join('')}</div>`;
    const more = total > shown.length ? `<p class="more">Showing ${shown.length} of ${total}. Change “Per server” to see more.</p>` : '';
    const hidden = h.hiddenCount > 0 ? `<p class="more hidden-note">${hiddenNote(h.hiddenCount)}. ${addLink}</p>` : '';
    return `${head}${box}${runsBlock}${body}${more}${hidden}`;
  }

  function renderChrome() {
    $('hosts').innerHTML = [...hosts.values()].map((h) => `<span class="hchip" data-status="${L.hostMode(h)}"><i></i>${esc(h.name)}</span>`).join('');
    const live = [...hosts.values()].filter((h) => h.status === 'online').flatMap((h) => [...sessions.get(h.name).values()]);
    const counts = L.stateCounts(live);
    const chips = [['all', 'All', live.length], ...L.STATE_ORDER.filter((st) => counts[st]).map((st) => [st, L.STATE_LABEL[st], counts[st]])];
    $('summary').innerHTML = chips.map(([st, label, n]) => `<button class="fchip" type="button" id="filter-${st}" data-filter="${st}" ${st === 'all' ? '' : `data-st="${st}"`} aria-pressed="${filter === st}">${st === 'all' ? '' : '<i></i>'}${label}<span class="n">${n}</span></button>`).join('');
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    $('limit').value = limit;
  }

  const ro = new ResizeObserver((entries) => entries.forEach((e) => drawRails(e.target)));

  function renderYard(name) {
    const section = $(`yard-${name}`);
    const scroll = {};
    section.querySelectorAll('[data-scroll]').forEach((t) => { scroll[t.dataset.scroll] = t.scrollLeft; });
    section.querySelectorAll('.track-inner').forEach((el) => ro.unobserve(el));
    section.innerHTML = yardHTML(name);
    section.querySelectorAll('[data-scroll]').forEach((t) => { if (scroll[t.dataset.scroll]) t.scrollLeft = scroll[t.dataset.scroll]; });
    section.querySelectorAll('.track-inner').forEach((el) => { drawRails(el); ro.observe(el); });
  }

  function markDirty(name) {
    if (name) dirty.add(name); else hosts.forEach((_, n) => dirty.add(n));
    if (!frame) frame = requestAnimationFrame(flush);
  }
  function flush() {
    frame = 0;
    renderChrome();
    for (const name of dirty) renderYard(name);
    dirty.clear();
    // The add panel manages its own content (fetched once, filtered client-side) and must not
    // be blown away by a re-render here: that would wipe the search box's focus and typed text.
    if (open && open.kind === 'session') renderDrawer();
  }

  function drawRails(inner) {
    const [host, key] = inner.dataset.sid.split('|');
    const s = sessions.get(host)?.get(key);
    if (!s) return;
    const svg = inner.querySelector('svg.rails');
    const box = inner.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    svg.setAttribute('width', box.width);
    svg.setAttribute('height', box.height);
    const center = (id) => {
      const r = inner.querySelector(`[data-step="${CSS.escape(id)}"] .dot`).getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
    };
    const status = Object.fromEntries(s.steps.map((t) => [t.id, t.status]));
    svg.replaceChildren(...L.edges(s).map(([a, b]) => {
      const A = center(a);
      const B = center(b);
      const mx = (A.x + B.x) / 2;
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', Math.abs(A.y - B.y) < 1 ? `M${A.x} ${A.y}H${B.x}` : `M${A.x} ${A.y}C${mx} ${A.y} ${mx} ${B.y} ${B.x} ${B.y}`);
      p.setAttribute('class', status[b] === 'pending' ? 'rail ahead' : 'rail');
      return p;
    }));
  }

  // ── side panel (read-only) ───────────────────────────────────────────────
  const drawer = $('drawer');
  const scrim = $('scrim');
  let activeTab = 'roadmap'; // 'roadmap' | 'conversation': which pane of an open session drawer shows
  let conv = null; // live state for an open Conversation tab's EventSource, or null

  const TAB_PANES = [['roadmap', 'd-roadmap-pane'], ['conversation', 'd-conversation-pane'],
    ['tasks', 'd-tasks-pane'], ['notes', 'd-notes-pane']];
  const TAB_LABEL = { roadmap: 'Roadmap', conversation: 'Conversation', tasks: 'Task history', notes: 'Notes' };

  function tabsHTML() {
    return TAB_PANES.map(([name]) => `<button type="button" class="d-tab" data-tab="${name}" role="tab" aria-selected="${activeTab === name}">${TAB_LABEL[name]}</button>`).join('');
  }

  // Builds the drawer's outer chrome (tabs + close button + the two panes) once per session,
  // and leaves the conversation pane's own contents alone on every later call: a session update
  // must not rebuild or lose the scroll position of a conversation that's mid-stream.
  function ensureDrawerSkeleton() {
    const wanted = `${open.host}|${open.key}`;
    if (drawer.dataset.sessionKey === wanted) return;
    closeConversation();
    activeTab = 'roadmap';
    drawer.dataset.sessionKey = wanted;
    drawer.innerHTML = `
      <div class="d-top"><div class="d-tabs" id="d-tabs" role="tablist" aria-label="Session panel">${tabsHTML()}</div><button class="btn ghost" type="button" id="d-close">Close</button></div>
      <div id="d-roadmap-pane" role="tabpanel"></div>
      <div id="d-conversation-pane" role="tabpanel" hidden></div>
      <div id="d-tasks-pane" role="tabpanel" hidden></div>
      <div id="d-notes-pane" role="tabpanel" hidden></div>`;
  }

  function renderRoadmapPane(s) {
    const steps = s.steps.length ? `<ol class="dsteps">${s.steps.map((t) => `
      <li class="st-${esc(t.status)}" style="--line:${LINE[s.agent]}"><span class="dot"></span>
        <span><span class="d-label">${s.agent === 'claude' ? `<span class="stn-id">#${esc(t.id)}</span> ` : ''}<span class="sr">${STATUS_WORD[t.status]}: </span>${esc(t.title)}</span>${t.blockedBy && t.blockedBy.length ? `<br><span class="after">after ${t.blockedBy.map((a) => '#' + esc(a)).join(' ')}</span>` : ''}</span><span></span>
      </li>`).join('')}</ol>` : `<p class="track-empty">No steps yet.</p>`;
    $('d-roadmap-pane').innerHTML = `
      <div class="d-head"><span class="line-chip" style="--line:${LINE[s.agent]}">${esc(s.agent)} · ${esc(open.host)}</span></div>
      <div class="d-head"><h2 id="d-title">${esc(s.name)}</h2><span class="pill" data-st="${esc(s.state)}">${L.STATE_LABEL[s.state]}</span>${s.error ? `<span class="err-line">${esc(s.error)}</span>` : ''}</div>
      <dl class="facts">
        <dt>Server</dt><dd>${esc(open.host)}</dd>
        <dt>Folder</dt><dd>${esc(path(open.host, s.cwd)) || '—'}</dd>
        <dt>Runs in</dt><dd>${esc(whereText(s))}</dd>
        ${s.waitingFor ? `<dt>Waiting for</dt><dd>${esc(s.waitingFor)}</dd>` : ''}
        ${s.pid ? `<dt>Process</dt><dd>pid ${esc(s.pid)}</dd>` : ''}
        ${s.gitBranch ? `<dt>Branch</dt><dd>${esc(s.gitBranch)}</dd>` : ''}
        ${s.goal ? `<dt>Goal</dt><dd>${esc(s.goal)}</dd>` : ''}
        <dt>Updated</dt><dd>${ago(s.updatedAt)}</dd>
      </dl>
      <section><h3 class="dh">Roadmap · ${doneCount(s)} of ${s.steps.length} done</h3>${steps}</section>
      <section><p class="why">Stop, send, and edit controls come in the next version.</p>
        <button class="btn danger" type="button" data-remove="${esc(open.host)}|${esc(s.key)}">Remove from dashboard</button>
      </section>`;
  }

  function renderDrawer() {
    const s = sessions.get(open.host)?.get(open.key);
    if (!s) {
      closeConversation();
      drawer.dataset.sessionKey = '';
      drawer.innerHTML = `<div class="d-top"><span></span><button class="btn ghost" type="button" id="d-close">Close</button></div><p class="why" id="d-title">${esc(open.host)} no longer reports this session.</p>`;
      return;
    }
    ensureDrawerSkeleton();
    renderRoadmapPane(s);
    if (activeTab === 'tasks') loadTaskHistory(); // a step just changed: keep the history current
  }

  function selectTab(tab) {
    if (tab === activeTab) return;
    if (activeTab === 'conversation') closeConversation();
    if (activeTab === 'notes') saveNoteIfChanged();
    activeTab = tab;
    $('d-tabs').innerHTML = tabsHTML();
    for (const [name, pane] of TAB_PANES) $(pane).hidden = tab !== name;
    if (tab === 'conversation') openConversation();
    if (tab === 'tasks') loadTaskHistory();
    if (tab === 'notes') renderNotesPane();
  }

  function openDrawer(host, key) {
    open = { kind: 'session', host, key };
    lastFocus = document.activeElement;
    renderDrawer();
    scrim.hidden = false;
    drawer.hidden = false;
    $('d-close').focus();
  }
  function closeDrawer() {
    if (activeTab === 'notes') saveNoteIfChanged();
    closeConversation();
    open = null;
    drawer.dataset.sessionKey = '';
    drawer.hidden = true;
    scrim.hidden = true;
    if (lastFocus) lastFocus.focus();
  }

  // ── conversation tab: a live stream of one session's full transcript ─────

  const firstLine = (s) => { const t = String(s ?? ''); const i = t.indexOf('\n'); return i < 0 ? t : t.slice(0, i); };

  function convStatusText() {
    if (conv.error) return { text: conv.error, state: 'error' };
    if (!conv.synced) return { text: 'Loading conversation…', state: 'loading' };
    return conv.reconnecting ? { text: 'Reconnecting…', state: 'reconnecting' } : { text: 'Live', state: 'live' };
  }
  function renderConvStatus() {
    const el = $('conv-status');
    const { text, state } = convStatusText();
    el.textContent = text;
    el.dataset.state = state;
  }

  function convLabel(item) {
    if (item.role === 'user') return 'You';
    return conv.agent === 'codex' ? 'Codex' : 'Claude';
  }
  function textItemHTML(item) {
    return `<div class="conv-msg conv-${esc(item.role)}"><div class="conv-label">${esc(convLabel(item))}</div><div class="conv-body">${esc(item.text)}</div></div>`;
  }

  // A tool_call/tool_result pair (or an orphaned result) tracked by an id used both for the
  // <details data-entry-id> toggle lookup and, once opened, to update it again if a matching
  // result arrives later. The <pre> bodies are strings built lazily (on 'toggle'), so a 25 MB
  // conversation full of large tool calls doesn't create huge DOM trees up front.
  function toolBodyHTML(entry) {
    const label = entry.tool ? esc(entry.tool) : 'Result';
    const first = esc(firstLine(entry.callText ?? entry.resultText ?? ''));
    let html = `<summary>${label} — ${first}</summary>`;
    if (entry.callText != null) html += `<pre class="conv-pre">${esc(entry.callText)}</pre>`;
    if (entry.hasResult) {
      html += `<div class="conv-output-label${entry.isError ? ' conv-error-label' : ''}">Output</div><pre class="conv-pre${entry.isError ? ' conv-pre-error' : ''}">${esc(entry.resultText)}</pre>`;
    }
    return html;
  }
  function toolSummaryHTML(entry, id) {
    const label = entry.tool ? esc(entry.tool) : 'Result';
    const first = esc(firstLine(entry.callText ?? entry.resultText ?? ''));
    return `<details class="conv-tool" id="${id}" data-entry-id="${id}"><summary>${label} — ${first}</summary></details>`;
  }
  function onConvToggle(e) {
    const details = e.target;
    if (!conv || !details || !details.dataset) return;
    const entry = conv.entries.get(details.dataset.entryId);
    if (entry && !entry.built) {
      entry.built = true;
      details.innerHTML = toolBodyHTML(entry);
    }
  }

  function appendConvItem(item) {
    const list = $('conv-list');
    if (item.kind === 'text') {
      list.insertAdjacentHTML('beforeend', textItemHTML(item));
    } else if (item.kind === 'tool_call') {
      conv.seq += 1;
      const id = `conv-e${conv.seq}`;
      const entry = { tool: item.tool, callText: item.text, resultText: null, isError: false, hasResult: false, built: false };
      conv.entries.set(id, entry);
      if (item.callId != null) conv.byCallId.set(item.callId, id);
      list.insertAdjacentHTML('beforeend', toolSummaryHTML(entry, id));
    } else if (item.kind === 'tool_result') {
      const id = item.callId != null ? conv.byCallId.get(item.callId) : null;
      const entry = id ? conv.entries.get(id) : null;
      if (entry) {
        entry.resultText = item.text;
        entry.isError = item.isError;
        entry.hasResult = true;
        if (entry.built) {
          const el = $(id);
          if (el) el.innerHTML = toolBodyHTML(entry);
        }
      } else {
        conv.seq += 1;
        const newId = `conv-e${conv.seq}`;
        const orphan = { tool: null, callText: null, resultText: item.text, isError: item.isError, hasResult: true, built: false };
        conv.entries.set(newId, orphan);
        list.insertAdjacentHTML('beforeend', toolSummaryHTML(orphan, newId));
      }
    }
    stickOrShowJump();
  }

  function stickOrShowJump() {
    const list = $('conv-list');
    if (conv.atBottom) list.scrollTop = list.scrollHeight;
    else $('conv-jump').hidden = false;
  }
  function onConvScroll() {
    const list = $('conv-list');
    conv.atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
    if (conv.atBottom) $('conv-jump').hidden = true;
  }
  function onConvJumpClick() {
    const list = $('conv-list');
    list.scrollTop = list.scrollHeight;
    $('conv-jump').hidden = true;
    conv.atBottom = true;
  }

  function showConvWarn(message) {
    const bar = $('conv-warnbar');
    bar.hidden = false;
    bar.textContent = message;
  }
  function resetConvList() {
    conv.synced = false;
    conv.error = null;
    conv.entries.clear();
    conv.byCallId.clear();
    conv.seq = 0;
    conv.atBottom = true;
    $('conv-list').innerHTML = '';
    $('conv-jump').hidden = true;
    renderConvStatus();
  }
  function handleConvMessage(msg) {
    if (!conv) return; // the stream was already closed (tab switched away, panel closed, …)
    switch (msg.type) {
      case 'conv-hello': break;
      case 'items': msg.items.forEach(appendConvItem); break;
      case 'conv-synced': conv.synced = true; renderConvStatus(); break;
      case 'conv-warn': showConvWarn(msg.message); break;
      case 'conv-reset': resetConvList(); break;
      case 'conv-error':
        conv.error = msg.message;
        renderConvStatus();
        conv.es.close();
        break;
      default: console.error('Unknown conversation event from the hub:', msg);
    }
  }

  function openConversation() {
    const s = sessions.get(open.host)?.get(open.key);
    $('d-conversation-pane').innerHTML = `
      <div class="conv-status" id="conv-status" role="status"></div>
      <div class="conv-warn" id="conv-warnbar" hidden></div>
      <div class="conv-list" id="conv-list"></div>
      <button type="button" class="conv-jump" id="conv-jump" hidden>New messages ↓</button>`;
    const list = $('conv-list');
    list.innerHTML = ''; // a fresh <div id="conv-list"> in a real browser; belt-and-braces here too
    list.addEventListener('toggle', onConvToggle, true);
    list.addEventListener('scroll', onConvScroll);
    $('conv-jump').hidden = true;
    $('conv-jump').addEventListener('click', onConvJumpClick);
    const es = new EventSource(`/api/conversation?host=${encodeURIComponent(open.host)}&key=${encodeURIComponent(open.key)}`);
    conv = { es, host: open.host, key: open.key, agent: s ? s.agent : null, synced: false, error: null,
            reconnecting: false, atBottom: true, seq: 0, entries: new Map(), byCallId: new Map() };
    renderConvStatus();
    es.onopen = () => { conv.reconnecting = false; renderConvStatus(); };
    es.onerror = () => { conv.reconnecting = true; renderConvStatus(); };
    es.onmessage = (ev) => handleConvMessage(JSON.parse(ev.data));
  }
  function closeConversation() {
    if (conv) conv.es.close();
    conv = null;
  }

  // ── task history tab ─────────────────────────────────────────────────────
  // A task's status as the board's state colors, so a task reads the same here as on the line.
  const TASK_STATE = { done: ['done', 'Done'], current: ['working', 'Current'], pending: ['idle', 'Upcoming'] };

  function taskHistoryHTML(steps) {
    if (!steps.length) {
      return `<p class="none">No tasks recorded yet. Switchyard remembers every task from the moment the hub first sees it, so they stay here even after the agent deletes them.</p>`;
    }
    const rows = steps.map((t) => {
      const [st, word] = TASK_STATE[t.status] || ['idle', t.status || 'unknown'];
      // Only worth showing once a task has been through more than one status: for a task seen
      // just once, the trail would just repeat the pill beside it.
      const statuses = t.history.filter((h) => h.status).map((h) => (TASK_STATE[h.status] || [null, h.status])[1]);
      const trail = statuses.length > 1 ? statuses.join(' → ') : '';
      return `<li class="th-row${t.gone ? ' th-gone' : ''}">
        <span class="th-head"><span class="stn-id">#${esc(t.stepId)}</span> <span class="th-title">${esc(t.title)}</span></span>
        <span class="chips"><span class="pill" data-st="${st}">${esc(word)}</span>${t.gone ? '<span class="th-tag">deleted</span>' : ''}</span>
        <span class="meta-line"><span>first seen ${ago(t.firstSeenAt)}</span><span>last change ${ago(t.lastChangeAt)}</span></span>
        ${trail ? `<span class="th-trail">${esc(trail)}</span>` : ''}
      </li>`;
    }).join('');
    return `<ol class="th-list">${rows}</ol>`;
  }
  function loadTaskHistory() {
    if (!open || open.kind !== 'session') return;
    const { host, key } = open;
    const pane = $('d-tasks-pane');
    if (!pane.innerHTML) pane.innerHTML = `<p class="none">Loading…</p>`;
    fetch(`/api/session-steps?host=${encodeURIComponent(host)}&key=${encodeURIComponent(key)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await serverErrorText(res));
        const data = await res.json();
        if (!open || open.kind !== 'session' || open.host !== host || open.key !== key) return;
        pane.innerHTML = `<div class="d-head"><h3 class="dh">Every task this session has had</h3></div>${taskHistoryHTML(data.steps)}`;
      })
      .catch((err) => { pane.innerHTML = `<p class="none">Couldn't load the task history: ${esc(err.message)}</p>`; });
  }

  // ── notes tab: the user's own notes, kept by the hub on this machine ─────
  const notes = new Map(); // "host|key" -> {text, updatedAt}
  const noteKey = (host, key) => `${host}|${key}`;
  const noteOf = (host, key) => notes.get(noteKey(host, key)) || null;

  function noteLineHTML(host, key) {
    const note = noteOf(host, key);
    if (!note) return '';
    return `<span class="note-line" title="${esc(note.text)}">📝 ${esc(firstLine(note.text))}</span>`;
  }
  function noteSavedText(note) {
    return note ? `saved ${L.relativeTime(note.updatedAt, Date.now())}` : 'nothing saved yet';
  }
  function renderNotesPane() {
    if (!open || open.kind !== 'session') return;
    const note = noteOf(open.host, open.key);
    $('d-notes-pane').innerHTML = `
      <div class="d-head"><h3 class="dh">Notes</h3></div>
      <p class="why">Kept by the hub on this machine only: nothing is written to the server, and the agent never sees it.</p>
      <textarea id="d-note" class="note-box" rows="10" placeholder="Anything worth remembering about this session…">${esc(note ? note.text : '')}</textarea>
      <div class="note-actions"><button type="button" class="btn quiet" data-save-note>Save</button><span class="note-status" id="d-note-status">${esc(noteSavedText(note))}</span></div>`;
    $('d-note').addEventListener('blur', saveNoteIfChanged);
  }
  // Saves on Save and on leaving the box, and does nothing when the text is unchanged, so
  // switching tabs or closing the panel can call it freely.
  function saveNoteIfChanged() {
    const box = $('d-note');
    if (!box || !open || open.kind !== 'session') return;
    const { host, key } = open;
    const text = String(box.value ?? '');
    const current = noteOf(host, key);
    if ((current ? current.text : '') === text.trim()) return;
    const status = $('d-note-status');
    if (status) status.textContent = 'saving…';
    fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, key, text }) })
      .then(async (res) => {
        if (!res.ok) {
          toastError(await serverErrorText(res));
          if (status) status.textContent = "couldn't save";
          return;
        }
        const data = await res.json();
        if (data.note) notes.set(noteKey(host, key), data.note);
        else notes.delete(noteKey(host, key));
        if (status) status.textContent = data.note ? 'saved just now' : 'note removed';
        markDirty(host); // the session's row shows the note's first line
      })
      .catch((err) => toastError(err.message));
  }
  function loadNotes() {
    return fetch('/api/notes')
      .then(async (res) => {
        if (!res.ok) throw new Error(await serverErrorText(res));
        return res.json();
      })
      .then((data) => {
        notes.clear();
        for (const n of data.notes) notes.set(noteKey(n.host, n.key), { text: n.text, updatedAt: n.updatedAt });
        markDirty(null);
      })
      .catch((err) => toastError(`Couldn't load notes: ${err.message}`));
  }

  // ── add sessions panel ───────────────────────────────────────────────────
  function addRowHTML(r) {
    const openKey = `${esc(r.host)}|${esc(r.key)}`;
    const steps = r.stepsTotal ? `<span>${esc(r.stepsDone)} of ${esc(r.stepsTotal)} steps</span>` : '';
    return `<div class="add-row">
      <div class="add-row-main">
        <span class="add-name">${esc(r.name)}</span>
        <span class="chips"><span class="line-chip">${esc(r.agent)}</span><span class="pill" data-st="${esc(r.state)}">${L.STATE_LABEL[r.state]}</span></span>
        <span class="meta-line"><span>${esc(path(r.host, r.cwd))}</span><span>updated ${ago(r.updatedAt)}</span></span>
        ${steps ? `<span class="meta-line">${steps}</span>` : ''}
        ${r.removed ? '<span class="muted">removed</span>' : ''}
      </div>
      <button type="button" class="btn quiet add-btn" data-add="${openKey}">Add</button>
    </div>`;
  }
  function addPanelHTML() {
    return `<div class="d-top"><span id="d-title">Add sessions</span><button class="btn ghost" type="button" id="d-close">Close</button></div>
      <div class="add-search-wrap"><input id="add-search" type="search" placeholder="Filter by name or folder" autocomplete="off"></div>
      <div id="add-rows"></div>`;
  }
  function renderAddRows() {
    const container = $('add-rows');
    if (!addRows.length) {
      container.innerHTML = `<p class="none">Every session is already on the dashboard.</p>`;
      return;
    }
    const q = ($('add-search').value || '').trim().toLowerCase();
    const filtered = addRows.filter((r) => !q || r.name.toLowerCase().includes(q) || path(r.host, r.cwd).toLowerCase().includes(q));
    if (!filtered.length) {
      container.innerHTML = `<p class="none">No sessions match “${esc(q)}”.</p>`;
      return;
    }
    const byHost = new Map();
    for (const r of filtered) { if (!byHost.has(r.host)) byHost.set(r.host, []); byHost.get(r.host).push(r); }
    container.innerHTML = [...byHost].map(([host, rows]) => `<div class="add-group"><h3 class="add-host">${esc(host)}</h3>${rows.map(addRowHTML).join('')}</div>`).join('');
  }
  function openAddPanel() {
    closeConversation();
    drawer.dataset.sessionKey = '';
    open = { kind: 'add' };
    lastFocus = document.activeElement;
    addRows = [];
    drawer.innerHTML = addPanelHTML();
    $('add-rows').innerHTML = `<p class="none">Loading…</p>`;
    $('add-search').value = '';
    $('add-search').addEventListener('input', renderAddRows);
    scrim.hidden = false;
    drawer.hidden = false;
    $('d-close').focus();
    fetch('/api/dashboard/hidden')
      .then(async (res) => {
        if (!res.ok) { toastError(await serverErrorText(res)); return null; }
        return res.json();
      })
      .then((data) => {
        if (!data || !open || open.kind !== 'add') return;
        addRows = data.sessions;
        renderAddRows();
      })
      .catch((err) => toastError(err.message));
  }
  function addSession(host, key) {
    fetch('/api/dashboard/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, key }) })
      .then(async (res) => {
        if (!res.ok) { toastError(await serverErrorText(res)); return; }
        // The hub's SSE `session` event puts the session on the dashboard itself; this just
        // drops the row from the panel's own list.
        addRows = addRows.filter((r) => !(r.host === host && r.key === key));
        if (open && open.kind === 'add') renderAddRows();
      })
      .catch((err) => toastError(err.message));
  }

  // ── status changes panel ─────────────────────────────────────────────────
  // How far back each choice looks, in ms ('all' asks for everything the hub has recorded).
  const RANGES = [['1h', 'Last hour', 3600e3], ['24h', 'Last 24 hours', 86400e3], ['7d', 'Last 7 days', 7 * 86400e3], ['all', 'All', null]];
  const rangeOf = (v) => RANGES.find(([value]) => value === v);

  function changePill(st, none) {
    if (st === null) return `<span class="chg-none">${none}</span>`;
    return `<span class="pill" data-st="${esc(st)}">${esc(L.STATE_LABEL[st] || st)}</span>`;
  }
  const dayKey = (ms) => new Date(ms).toDateString();
  function dayHeading(ms) {
    const now = new Date();
    if (dayKey(ms) === now.toDateString()) return 'Today';
    if (dayKey(ms) === new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString()) return 'Yesterday';
    return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const clockTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function changeRowHTML(c) {
    // Only a session that's on the dashboard has a side panel to open.
    const name = sessions.get(c.host)?.has(c.key)
      ? `<button type="button" class="chg-name chg-open" data-open="${esc(c.host)}|${esc(c.key)}">${esc(c.name)}</button>`
      : `<span class="chg-name">${esc(c.name)}</span>`;
    return `<li class="chg-row">
      <time class="chg-time" datetime="${esc(new Date(c.at).toISOString())}">${esc(clockTime(c.at))}</time>
      <div class="chg-main">
        ${name}
        <span class="chg-trans">${changePill(c.from, 'New session')}<span class="chg-arrow" aria-hidden="true">→</span><span class="sr"> to </span>${changePill(c.to, 'No longer reported')}</span>
        <span class="meta-line"><span>${esc(c.host)}</span>${c.agent ? `<span>${esc(c.agent)}</span>` : ''}</span>
        ${c.reason ? `<span class="chg-reason">${esc(c.reason)}</span>` : ''}
      </div>
    </li>`;
  }
  function changesPanelHTML() {
    const options = RANGES.map(([v, label]) => `<option value="${v}"${v === changesRange ? ' selected' : ''}>${label}</option>`).join('');
    return `<div class="d-top"><span id="d-title">Status changes</span><button class="btn ghost" type="button" id="d-close">Close</button></div>
      <div class="chg-controls">
        <label class="chg-range" for="changes-range">Show <select id="changes-range">${options}</select></label>
        <input id="changes-search" type="search" placeholder="Filter by session or server" autocomplete="off">
      </div>
      <p class="why chg-note">Every change the hub has seen while running, newest first, hidden sessions included.</p>
      <div id="changes-rows"></div>`;
  }
  function renderChangeRows() {
    const container = $('changes-rows');
    if (changes === null) { container.innerHTML = `<p class="none">Loading…</p>`; return; }
    if (!changes.length) {
      container.innerHTML = `<p class="none">${changesRange === 'all' ? 'No status changes recorded yet.' : `No status changes in the ${esc(rangeOf(changesRange)[1].toLowerCase())}.`}</p>`;
      return;
    }
    const q = ($('changes-search').value || '').trim().toLowerCase();
    const shown = changes.filter((c) => !q || String(c.name).toLowerCase().includes(q) || c.host.toLowerCase().includes(q));
    if (!shown.length) { container.innerHTML = `<p class="none">No changes match “${esc(q)}”.</p>`; return; }
    const days = [];
    for (const c of shown) {
      if (!days.length || days[days.length - 1].key !== dayKey(c.at)) days.push({ key: dayKey(c.at), at: c.at, rows: [] });
      days[days.length - 1].rows.push(c);
    }
    container.innerHTML = days.map((d) => `<div class="add-group"><h3 class="add-host">${esc(dayHeading(d.at))}</h3><ol class="chg-list">${d.rows.map(changeRowHTML).join('')}</ol></div>`).join('');
  }
  function loadChanges() {
    changes = null;
    changesBuffer = [];
    renderChangeRows();
    const range = changesRange;
    const ms = rangeOf(range)[2];
    const current = () => open && open.kind === 'changes' && changesRange === range;
    const fail = (text) => { if (current()) $('changes-rows').innerHTML = `<p class="none">Couldn't load status changes: ${esc(text)}</p>`; };
    fetch(`/api/status-changes?since=${ms === null ? 0 : Date.now() - ms}`)
      .then(async (res) => {
        if (!res.ok) { fail(await serverErrorText(res)); return; }
        const data = await res.json();
        if (!current()) return;
        // Changes that arrived over SSE during the fetch may or may not be in its answer.
        const fetched = new Set(data.changes.map((c) => c.id));
        changes = [...changesBuffer.filter((c) => !fetched.has(c.id)).reverse(), ...data.changes];
        changesBuffer = [];
        renderChangeRows();
      })
      .catch((err) => fail(err.message));
  }
  function openChangesPanel() {
    closeConversation();
    drawer.dataset.sessionKey = '';
    open = { kind: 'changes' };
    lastFocus = document.activeElement;
    drawer.innerHTML = changesPanelHTML();
    $('changes-search').value = '';
    $('changes-search').addEventListener('input', renderChangeRows);
    $('changes-range').value = changesRange;
    $('changes-range').addEventListener('change', (e) => {
      changesRange = e.target.value;
      savePref('switchyard-changes-range', changesRange);
      loadChanges();
    });
    scrim.hidden = false;
    drawer.hidden = false;
    $('d-close').focus();
    loadChanges();
  }
  function onStatusChange(c) {
    if (!open || open.kind !== 'changes') return;
    if (changes === null) { changesBuffer.push(c); return; }
    changes.unshift(c);
    renderChangeRows();
  }

  // ── remove / undo ────────────────────────────────────────────────────────
  const toast = $('toast');

  function showToast(html) {
    toast.innerHTML = html;
    toast.hidden = false;
  }
  function hideToast() {
    toast.hidden = true;
    toast.innerHTML = '';
  }
  function toastError(text) {
    showToast(`<span class="toast-msg">${esc(text)}</span><button type="button" class="toast-close" aria-label="Close">×</button>`);
  }
  function toastRemoved(name, host, key) {
    showToast(`<span class="toast-msg">Removed “${esc(name)}”</span>
      <button type="button" class="toast-undo" data-undo="${esc(host)}|${esc(key)}">Undo</button>
      <button type="button" class="toast-close" aria-label="Close">×</button>`);
  }

  // A 500 from Express's default handler (or any non-JSON error page) isn't {error: "..."} —
  // res.json() would throw and the toast would show "Unexpected token '<'" instead of anything
  // useful. Read the body as text first, and only trust it as our own {error} shape if it
  // actually parses; otherwise fall back to the status and the response's own first line.
  async function serverErrorText(res) {
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return `HTTP ${res.status}: ${(text.split('\n')[0] || '').trim()}`;
    }
    return parsed.error;
  }

  // On success the hub's SSE `removed` event does the actual removal from `sessions`; this
  // only closes the panel (if it's showing the removed session) and raises the Undo toast.
  function removeSession(host, key) {
    const name = sessions.get(host)?.get(key)?.name ?? key;
    fetch('/api/dashboard/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, key }) })
      .then(async (res) => {
        if (!res.ok) { toastError(await serverErrorText(res)); return; }
        if (open && open.host === host && open.key === key) closeDrawer();
        toastRemoved(name, host, key);
      })
      .catch((err) => toastError(err.message));
  }
  function undoRemove(host, key) {
    fetch('/api/dashboard/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, key }) })
      .then(async (res) => {
        if (!res.ok) { toastError(await serverErrorText(res)); return; }
        hideToast();
      })
      .catch((err) => toastError(err.message));
  }

  // ── data ─────────────────────────────────────────────────────────────────
  function handle(msg) {
    if (buffer) { buffer.push(msg); return; }
    switch (msg.type) {
      case 'host': hosts.set(msg.host.name, msg.host); markDirty(msg.host.name); break;
      case 'session': sessions.get(msg.host).set(msg.session.key, msg.session); markDirty(msg.host); break;
      case 'removed': sessions.get(msg.host).delete(msg.key); markDirty(msg.host); break;
      case 'reset': sessions.get(msg.host).clear(); runs.get(msg.host).clear(); markDirty(msg.host); break;
      case 'run': runs.get(msg.host).set(msg.run.id, msg.run); markDirty(msg.host); break;
      case 'run-removed': runs.get(msg.host).delete(msg.id); markDirty(msg.host); break;
      case 'status-change': onStatusChange(msg.change); break;
      case 'tick': {
        const h = hosts.get(msg.host);
        h.lastSyncAt = msg.at;
        const el = document.querySelector(`[data-sync="${CSS.escape(msg.host)}"] [data-ago]`);
        if (el) el.dataset.ago = String(msg.at);
        break;
      }
      case 'connected':
      case 'update': // for the board page
        break;
      default:
        console.error('Unknown event from the hub:', msg);
    }
  }

  async function load() {
    buffer = [];
    try {
      const res = await fetch('/api/fleet');
      if (!res.ok) throw new Error(`GET /api/fleet failed: ${res.status}`);
      const fleet = await res.json();
      const firstLoad = hosts.size === 0;
      hosts.clear();
      sessions.clear();
      runs.clear();
      for (const h of fleet.hosts) { hosts.set(h.name, h); sessions.set(h.name, new Map()); runs.set(h.name, new Map()); }
      for (const s of fleet.sessions) sessions.get(s.host).set(s.key, s);
      for (const r of (fleet.runs || [])) runs.get(r.host).set(r.id, r);
      if (firstLoad) $('yards').innerHTML = fleet.hosts.map((h) => `<section class="yard" id="yard-${esc(h.name)}" aria-label="${esc(h.name)}"></section>`).join('');
      const pending = buffer;
      buffer = null;
      pending.forEach(handle);
      markDirty(null);
    } catch (err) {
      // A stuck buffer (still an array) would silently swallow every event from here on;
      // reset it so events keep being applied even though this snapshot didn't load.
      buffer = null;
      throw err;
    }
  }

  function setConn(state, text) {
    $('conn').dataset.state = state;
    $('conn').textContent = text;
  }

  function connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => {
      setConn('live', 'Live');
      load().catch((err) => setConn('lost', `Couldn't load sessions from the hub: ${err.message}`));
      loadNotes();
    };
    es.onerror = () => setConn('lost', 'Lost the connection to the hub. Retrying…'); // EventSource reconnects by itself
    es.onmessage = (ev) => handle(JSON.parse(ev.data));
  }

  // ── events ───────────────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    // Checked before [data-open]: Remove sits inside a [data-open] row/card and must not also
    // open the side panel.
    const r = e.target.closest('[data-remove]');
    if (r) { e.stopPropagation(); const [host, key] = r.dataset.remove.split('|'); removeSession(host, key); return; }
    const u = e.target.closest('[data-undo]');
    if (u) { const [host, key] = u.dataset.undo.split('|'); undoRemove(host, key); return; }
    const ab = e.target.closest('[data-add]');
    if (ab) { e.stopPropagation(); const [host, key] = ab.dataset.add.split('|'); addSession(host, key); return; }
    if (e.target.closest('[data-open-add]')) { openAddPanel(); return; }
    if (e.target.closest('[data-open-changes]')) { openChangesPanel(); return; }
    if (e.target.closest('[data-save-note]')) { saveNoteIfChanged(); return; }
    if (e.target.closest('.toast-close')) { hideToast(); return; }
    const o = e.target.closest('[data-open]');
    if (o) { const [host, key] = o.dataset.open.split('|'); openDrawer(host, key); return; }
    const tb = e.target.closest('[data-tab]');
    if (tb) { selectTab(tb.dataset.tab); return; }
    const ft = e.target.closest('[data-finished-toggle]');
    if (ft) {
      const h = ft.dataset.finishedToggle;
      if (showFinished.has(h)) showFinished.delete(h); else showFinished.add(h);
      savePref('switchyard-finished-runs', [...showFinished].join(','));
      markDirty(h);
      return;
    }
    const f = e.target.closest('[data-filter]');
    if (f) { filter = f.dataset.filter; markDirty(null); return; }
    const v = e.target.closest('[data-view]');
    if (v) { view = v.dataset.view; savePref('switchyard-view', view); markDirty(null); return; }
    if (e.target.id === 'd-close') closeDrawer();
  });
  $('limit').addEventListener('change', (e) => { limit = e.target.value; savePref('switchyard-limit', limit); markDirty(null); });
  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) closeDrawer(); });
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('[data-ago]').forEach((el) => {
      const ms = Number(el.dataset.ago);
      if (ms) el.textContent = L.relativeTime(ms, now);
    });
    document.querySelectorAll('[data-since]').forEach((el) => {
      const ms = Number(el.dataset.since);
      if (ms) el.textContent = L.durationText((now - ms) / 1000);
    });
    document.querySelectorAll('[data-until]').forEach((el) => { el.textContent = inSeconds(Number(el.dataset.until)); });
  }, 1000);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => document.querySelectorAll('.track-inner').forEach(drawRails));

  connect();
})();
