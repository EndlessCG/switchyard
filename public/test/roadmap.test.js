'use strict';
/* roadmap.js is a plain browser script (no module wrapper), so this test builds just enough
 * of a fake DOM/browser environment for it to load under `node --test`, then drives it through
 * its public entry points (the EventSource callbacks) the same way a real page would. */
const test = require('node:test');
const assert = require('node:assert/strict');

class FakeElement {
  constructor() { this._html = ''; this.dataset = {}; this.hidden = false; this._matches = []; this._listeners = {}; this.value = ''; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  // Real enough for the conversation list, which appends one item's HTML at a time (instead of
  // rebuilding the whole innerHTML) so opening a huge conversation doesn't reparse it repeatedly.
  insertAdjacentHTML(position, html) {
    if (position === 'beforeend') this._html += html;
    else throw new Error(`FakeElement.insertAdjacentHTML: unsupported position ${position}`);
  }
  // Real enough to test an element-level listener (e.g. the add-search input): recorded here
  // and fired by dispatch(), unlike document-level listeners which use fireDocumentEvent above.
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn); }
  dispatch(type, evt = {}) { (this._listeners[type] || []).forEach((fn) => fn({ target: this, ...evt })); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  focus() {}
  closest(sel) { return this._matches.includes(sel) ? this : null; }
}

const elements = new Map();
const docListeners = {};
global.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  activeElement: null,
};
function fireDocumentEvent(type, evt) { (docListeners[type] || []).forEach((fn) => fn(evt)); }
global.window = global;
global.SwitchyardLayout = require('../layout');
global.ResizeObserver = class { observe() {} unobserve() {} };
// Deferred (like the real browser API), not synchronous: roadmap.js does
// `frame = requestAnimationFrame(flush)` and flush() sets frame = 0 at its start — calling
// fn() synchronously here would let that assignment overwrite frame back to non-zero right
// after flush() already reset it, permanently wedging markDirty's `if (!frame)` guard.
global.requestAnimationFrame = (fn) => { setTimeout(fn, 0); return 1; };
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => { const t = realSetInterval(fn, ms); if (t.unref) t.unref(); return t; };

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeEventSource.last = this;
    // Also indexed by url: `last` is whichever stream opened most recently, which after a
    // conversation test is the conversation's, not the fleet's.
    (FakeEventSource.byUrl ||= new Map()).set(url, this);
  }
  close() { this.closed = true; }
}
global.EventSource = FakeEventSource;

let fetchImpl = () => Promise.reject(new Error('fetch not configured for this test'));
global.fetch = (...args) => fetchImpl(...args);

require('../roadmap.js'); // runs its top-level connect(), which builds the one EventSource

// load()'s fetch chain and the deferred requestAnimationFrame(flush) each need their own
// event-loop turns to settle; poll instead of guessing a fixed number of ticks.
async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting for condition');
}

test('a failed initial load does not wedge the event buffer: later SSE events keep being applied', async () => {
  fetchImpl = () => Promise.reject(new Error('network down'));
  const es = FakeEventSource.last;
  es.onopen(); // → setConn('live', …); load().catch(...)
  await waitFor(() => document.getElementById('conn').dataset.state === 'lost');

  const before = document.getElementById('hosts').innerHTML;
  es.onmessage({ data: JSON.stringify({ type: 'host', host: { name: 'box3', status: 'offline', error: 'timeout' } }) });
  await waitFor(() => document.getElementById('hosts').innerHTML !== before);
  const after = document.getElementById('hosts').innerHTML;

  assert.notEqual(after, before, 'the host chip should render immediately, not sit in a buffer forever');
  assert.match(after, /box3/);
  assert.match(after, /data-status="offline"/);
});

test('s.state, s.agent, t.status, and s.pid are escaped wherever they are interpolated', async () => {
  const XSS = '"><img src=x onerror=alert(1)>';
  const session = {
    host: 'box3', key: 'codex:a', agent: XSS, id: 'a', name: 'demo', cwd: '/w', gitBranch: null,
    kind: 'cli', pid: XSS, short: null, tmuxPane: null, state: XSS, error: null, goal: null,
    updatedAt: Date.now(), stepsSource: null,
    steps: [{ id: '1', title: 'do it', status: XSS, blockedBy: [], blocks: [], description: '', activeForm: null, updatedAt: null }],
  };
  fetchImpl = () => Promise.resolve({ ok: true, json: async () => ({
    hosts: [{ name: 'box3', status: 'online', error: null, errors: [], notes: [], info: { python: '3.10', hostname: 'box3-host' }, lastSyncAt: Date.now(), retryAt: null }],
    sessions: [session],
  }) });
  const es = FakeEventSource.last;
  es.onopen();
  await waitFor(() => !document.getElementById('yard-box3').innerHTML.includes('offline-box'));

  const yard = document.getElementById('yard-box3').innerHTML;
  assert.doesNotMatch(yard, /<img/, 'the line/card view must not contain a raw injected tag');
  assert.match(yard, /&lt;img/, 'the malicious state/status text should show up escaped');

  // Open the drawer (the only place s.pid is rendered) by simulating the click roadmap.js listens for.
  const openBtn = new FakeElement();
  openBtn._matches = ['[data-open]'];
  openBtn.dataset.open = 'box3|codex:a';
  fireDocumentEvent('click', { target: openBtn });

  // The session's own fields (pid, agent, state) render into the roadmap pane, which is a
  // sibling of the drawer's tab/close chrome, not the drawer's own top-level innerHTML.
  const drawer = document.getElementById('drawer').innerHTML + document.getElementById('d-roadmap-pane').innerHTML;
  assert.doesNotMatch(drawer, /<img/, 'the drawer must not contain a raw injected tag from pid/agent/state');
  assert.match(drawer, /&lt;img/);
});

test('a Remove click POSTs the right body, does not open the drawer, and shows an Undo toast', async () => {
  const session = { host: 'box3', key: 'claude:a', agent: 'claude', id: 'a', name: 'demo-sess', cwd: '/w',
    gitBranch: null, kind: 'interactive', pid: 1, short: null, tmuxPane: null, state: 'working', error: null,
    goal: null, updatedAt: Date.now(), stepsSource: null, steps: [] };
  let removeCall = null;
  fetchImpl = (url, opts) => {
    if (url === '/api/fleet') {
      return Promise.resolve({ ok: true, json: async () => ({
        hosts: [{ name: 'box3', status: 'online', error: null, errors: [], notes: [], info: { python: '3.10', hostname: 'box3-host' }, lastSyncAt: Date.now(), retryAt: null, sessionCount: 1, hiddenCount: 0 }],
        sessions: [session],
      }) });
    }
    if (url === '/api/dashboard/remove') {
      removeCall = opts;
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  };
  const es = FakeEventSource.last;
  es.onopen();
  // Specific to this test's own fixture: an earlier test may have left yard-box3 rendered
  // (not offline-box) from its own load, which would make that weaker check resolve too soon,
  // before this test's own load() finished repopulating `sessions`.
  await waitFor(() => document.getElementById('yard-box3').innerHTML.includes('demo-sess'));

  // Reset to a known "closed" state for this test: earlier tests may have left the shared
  // drawer/toast FakeElements open (or, before this fix, FakeElement always defaulted
  // `hidden = false`, which made a `hidden === false` check meaningless either way).
  const drawer = document.getElementById('drawer');
  const toastEl = document.getElementById('toast');
  drawer.hidden = true;
  toastEl.hidden = true;
  const drawerBefore = drawer.innerHTML;

  // Mirrors the real nesting (metaHTML): the Remove button sits inside the outer `.sess-meta`
  // div, which also carries [data-open] so a click anywhere else in the row opens the drawer.
  // A fake that only matched [data-remove] could never have caught a bug in the click handler's
  // branch order, because closest('[data-open]') would trivially find nothing.
  const removeBtn = new FakeElement();
  removeBtn._matches = ['[data-remove]', '[data-open]'];
  removeBtn.dataset.remove = 'box3|claude:a';
  removeBtn.dataset.open = 'box3|claude:a';
  fireDocumentEvent('click', { target: removeBtn, stopPropagation() {} });

  await waitFor(() => removeCall !== null);
  assert.equal(removeCall.method, 'POST');
  assert.equal(removeCall.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(removeCall.body), { host: 'box3', key: 'claude:a' });

  // The click must never have reached the [data-open] handler: the drawer stayed hidden and
  // its content untouched.
  assert.equal(drawer.hidden, true);
  assert.equal(drawer.innerHTML, drawerBefore);

  await waitFor(() => toastEl.hidden === false);
  assert.match(toastEl.innerHTML, /Removed/);
  assert.match(toastEl.innerHTML, /demo-sess/);
  assert.match(toastEl.innerHTML, /Undo/);
});

test('a failed Remove shows the server error text, even when the body is HTML (a raw 500)', async () => {
  const session = { host: 'box3', key: 'claude:b', agent: 'claude', id: 'b', name: 'other', cwd: '/w',
    gitBranch: null, kind: 'interactive', pid: 2, short: null, tmuxPane: null, state: 'working', error: null,
    goal: null, updatedAt: Date.now(), stepsSource: null, steps: [] };
  fetchImpl = (url) => {
    if (url === '/api/fleet') {
      return Promise.resolve({ ok: true, json: async () => ({
        hosts: [{ name: 'box3', status: 'online', error: null, errors: [], notes: [], info: { python: '3.10', hostname: 'box3-host' }, lastSyncAt: Date.now(), retryAt: null, sessionCount: 1, hiddenCount: 0 }],
        sessions: [session],
      }) });
    }
    if (url === '/api/dashboard/remove') {
      return Promise.resolve({ ok: false, status: 500,
        text: async () => '<!DOCTYPE html>\n<html><body>\n<pre>TypeError: something broke\n    at Server (/hub/routes.js:1:1)</pre>\n</body></html>' });
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  };
  const es = FakeEventSource.last;
  es.onopen();
  await waitFor(() => document.getElementById('yard-box3').innerHTML.includes('>other<'));

  const toastEl = document.getElementById('toast');
  toastEl.hidden = true;
  const removeBtn = new FakeElement();
  removeBtn._matches = ['[data-remove]', '[data-open]'];
  removeBtn.dataset.remove = 'box3|claude:b';
  removeBtn.dataset.open = 'box3|claude:b';
  fireDocumentEvent('click', { target: removeBtn, stopPropagation() {} });

  await waitFor(() => toastEl.hidden === false);
  assert.match(toastEl.innerHTML, /HTTP 500/);
  assert.match(toastEl.innerHTML, /DOCTYPE html/);
  assert.doesNotMatch(toastEl.innerHTML, /Unexpected token/, 'a JSON.parse failure on an HTML body must not leak as the shown message');
});

test('a failed Undo shows the parsed {error} text from a JSON error response', async () => {
  const session = { host: 'box3', key: 'claude:c', agent: 'claude', id: 'c', name: 'third', cwd: '/w',
    gitBranch: null, kind: 'interactive', pid: 3, short: null, tmuxPane: null, state: 'working', error: null,
    goal: null, updatedAt: Date.now(), stepsSource: null, steps: [] };
  fetchImpl = (url) => {
    if (url === '/api/fleet') {
      return Promise.resolve({ ok: true, json: async () => ({
        hosts: [{ name: 'box3', status: 'online', error: null, errors: [], notes: [], info: { python: '3.10', hostname: 'box3-host' }, lastSyncAt: Date.now(), retryAt: null, sessionCount: 1, hiddenCount: 0 }],
        sessions: [session],
      }) });
    }
    if (url === '/api/dashboard/restore') {
      return Promise.resolve({ ok: false, status: 404, text: async () => JSON.stringify({ error: 'unknown session claude:c on box3' }) });
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  };
  const es = FakeEventSource.last;
  es.onopen();
  await waitFor(() => document.getElementById('yard-box3').innerHTML.includes('>third<'));

  const toastEl = document.getElementById('toast');
  toastEl.hidden = true;
  const undoBtn = new FakeElement();
  undoBtn._matches = ['[data-undo]'];
  undoBtn.dataset.undo = 'box3|claude:c';
  fireDocumentEvent('click', { target: undoBtn });

  await waitFor(() => toastEl.hidden === false);
  assert.match(toastEl.innerHTML, /unknown session claude:c on box3/);
});

// ── Add sessions panel ───────────────────────────────────────────────────

const hiddenAlpha = { host: 'box3', key: 'codex:old1', id: 'old1', agent: 'codex', name: 'alpha-hunter',
  cwd: '/work/alpha', kind: 'cli', state: 'idle', updatedAt: 2000, stepsTotal: 0, stepsDone: 0 };
const hiddenBeta = { host: 'box3', key: 'codex:old2', id: 'old2', agent: 'codex', name: 'beta-project',
  cwd: '/work/beta', kind: 'cli', state: 'idle', updatedAt: 1000, stepsTotal: 2, stepsDone: 1, removed: true };

function clickOpenAdd() {
  const btn = new FakeElement();
  btn._matches = ['[data-open-add]'];
  fireDocumentEvent('click', { target: btn });
}

test('clicking "Add sessions" fetches /api/dashboard/hidden and renders the rows', async () => {
  let hiddenCalled = false;
  fetchImpl = (url) => {
    if (url === '/api/dashboard/hidden') {
      hiddenCalled = true;
      return Promise.resolve({ ok: true, json: async () => ({ sessions: [hiddenAlpha, hiddenBeta] }) });
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  };
  clickOpenAdd();
  const rows = document.getElementById('add-rows');
  await waitFor(() => rows.innerHTML.includes('alpha-hunter'));
  assert.equal(hiddenCalled, true);
  assert.match(rows.innerHTML, /alpha-hunter/);
  assert.match(rows.innerHTML, /beta-project/);
  assert.match(rows.innerHTML, /removed/);
});

test('the search filters the rows', async () => {
  fetchImpl = (url) => {
    if (url === '/api/dashboard/hidden') return Promise.resolve({ ok: true, json: async () => ({ sessions: [hiddenAlpha, hiddenBeta] }) });
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  };
  clickOpenAdd();
  const rows = document.getElementById('add-rows');
  await waitFor(() => rows.innerHTML.includes('alpha-hunter'));

  const search = document.getElementById('add-search');
  search.value = 'alpha';
  search.dispatch('input');
  assert.match(rows.innerHTML, /alpha-hunter/);
  assert.doesNotMatch(rows.innerHTML, /beta-project/);

  search.value = 'beta';
  search.dispatch('input');
  assert.doesNotMatch(rows.innerHTML, /alpha-hunter/);
  assert.match(rows.innerHTML, /beta-project/);
});

test('Add POSTs the right body, and removes the row on success', async () => {
  let addCall = null;
  fetchImpl = (url, opts) => {
    if (url === '/api/dashboard/hidden') return Promise.resolve({ ok: true, json: async () => ({ sessions: [hiddenAlpha] }) });
    if (url === '/api/dashboard/add') {
      addCall = opts;
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  };
  clickOpenAdd();
  const rows = document.getElementById('add-rows');
  await waitFor(() => rows.innerHTML.includes('alpha-hunter'));

  const addBtn = new FakeElement();
  addBtn._matches = ['[data-add]'];
  addBtn.dataset.add = 'box3|codex:old1';
  fireDocumentEvent('click', { target: addBtn, stopPropagation() {} });

  await waitFor(() => addCall !== null);
  assert.equal(addCall.method, 'POST');
  assert.equal(addCall.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(addCall.body), { host: 'box3', key: 'codex:old1' });
  await waitFor(() => !rows.innerHTML.includes('alpha-hunter'));
});

test('a failed Add shows the server error text', async () => {
  fetchImpl = (url) => {
    if (url === '/api/dashboard/hidden') return Promise.resolve({ ok: true, json: async () => ({ sessions: [hiddenAlpha] }) });
    if (url === '/api/dashboard/add') {
      return Promise.resolve({ ok: false, status: 404, text: async () => JSON.stringify({ error: 'unknown session codex:old1 on box3' }) });
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  };
  clickOpenAdd();
  const rows = document.getElementById('add-rows');
  await waitFor(() => rows.innerHTML.includes('alpha-hunter'));

  const toastEl = document.getElementById('toast');
  toastEl.hidden = true;
  const addBtn = new FakeElement();
  addBtn._matches = ['[data-add]'];
  addBtn.dataset.add = 'box3|codex:old1';
  fireDocumentEvent('click', { target: addBtn, stopPropagation() {} });

  await waitFor(() => toastEl.hidden === false);
  assert.match(toastEl.innerHTML, /unknown session codex:old1 on box3/);
});

// ── Conversation tab ─────────────────────────────────────────────────────

// roadmap.js's own connect() creates exactly one EventSource (for /api/fleet's events), at
// require() time above — before any test body runs. Capture it now: once a conversation test
// opens its own EventSource, FakeEventSource.last points at that instead, so re-reading
// FakeEventSource.last later to mean "the fleet stream" would grab the wrong object.
const fleetEsRef = FakeEventSource.last;

// A fresh session per test (distinct key), so ensureDrawerSkeleton's "already open" cache in
// roadmap.js (a real optimization: reopening the same session's drawer leaves it alone) never
// makes one test's conversation state leak into the next, the way reusing one key would.
let convSessionSeq = 0;
function makeConvSession(overrides = {}) {
  convSessionSeq += 1;
  return { host: 'box3', key: `claude:conv-${convSessionSeq}`, agent: 'claude', id: `conv-${convSessionSeq}`,
    name: `conv-demo-${convSessionSeq}`, cwd: '/w', gitBranch: null, kind: 'interactive', pid: 5, short: null,
    tmuxPane: null, state: 'working', error: null, goal: null, updatedAt: Date.now(), stepsSource: null,
    steps: [], ...overrides };
}

function loadFleetWith(session) {
  fetchImpl = (url) => {
    if (url === '/api/notes') return Promise.resolve({ ok: true, json: async () => ({ notes: [] }) });
    if (url === '/api/fleet') {
      return Promise.resolve({ ok: true, json: async () => ({
        hosts: [{ name: session.host, status: 'online', error: null, errors: [], notes: [], info: { python: '3.10', hostname: 'box3-host' }, lastSyncAt: Date.now(), retryAt: null, sessionCount: 1, hiddenCount: 0 }],
        sessions: [session],
      }) });
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  };
  fleetEsRef.onopen();
  return fleetEsRef;
}

async function openConvDrawerReady(session) {
  const fleetEs = loadFleetWith(session);
  await waitFor(() => document.getElementById(`yard-${session.host}`).innerHTML.includes(session.name));
  const openBtn = new FakeElement();
  openBtn._matches = ['[data-open]'];
  openBtn.dataset.open = `${session.host}|${session.key}`;
  fireDocumentEvent('click', { target: openBtn });
  return fleetEs;
}

function clickSaveNote() {
  const btn = new FakeElement();
  btn._matches = ['[data-save-note]'];
  fireDocumentEvent('click', { target: btn });
}

function clickTab(name) {
  const tabBtn = new FakeElement();
  tabBtn._matches = ['[data-tab]'];
  tabBtn.dataset.tab = name;
  fireDocumentEvent('click', { target: tabBtn });
}

test('clicking the Conversation tab opens an EventSource with the right URL', async () => {
  const session = makeConvSession();
  await openConvDrawerReady(session);
  clickTab('conversation');
  const es = FakeEventSource.last;
  assert.equal(es.url, `/api/conversation?host=box3&key=${encodeURIComponent(session.key)}`);
});

test('conversation items render in order with the You / Claude labels', async () => {
  await openConvDrawerReady(makeConvSession());
  clickTab('conversation');
  const es = FakeEventSource.last;
  es.onmessage({ data: JSON.stringify({ type: 'items', items: [
    { n: 1, role: 'user', kind: 'text', text: 'hi there', tool: null, callId: null, isError: false, ts: 't1' },
    { n: 2, role: 'assistant', kind: 'text', text: 'hello!', tool: null, callId: null, isError: false, ts: 't2' },
  ] }) });
  const html = document.getElementById('conv-list').innerHTML;
  assert.match(html, />You</);
  assert.match(html, /hi there/);
  assert.match(html, />Claude</);
  assert.match(html, /hello!/);
  assert.ok(html.indexOf('hi there') < html.indexOf('hello!'), 'items must render in arrival order');
});

test('a tool call renders collapsed, and its body is built only when opened', async () => {
  await openConvDrawerReady(makeConvSession());
  clickTab('conversation');
  const es = FakeEventSource.last;
  // A first line short enough to belong in the always-visible summary, then a large blob that
  // must only ever be built once the <details> is opened.
  const restOfBody = 'X'.repeat(500);
  const bigInput = `ls -la\n${restOfBody}`;
  es.onmessage({ data: JSON.stringify({ type: 'items', items: [
    { n: 1, role: 'tool', kind: 'tool_call', text: bigInput, tool: 'Bash', callId: 'c1', isError: false, ts: 't1' },
  ] }) });
  const list = document.getElementById('conv-list');
  assert.match(list.innerHTML, /Bash/);
  assert.match(list.innerHTML, /ls -la/);
  assert.doesNotMatch(list.innerHTML, new RegExp(restOfBody), 'the input body must not be built until opened');

  const m = list.innerHTML.match(/id="([^"]+)"/);
  assert.ok(m, 'the tool call should render with an id for later lookup');
  const details = new FakeElement();
  details.dataset.entryId = m[1];
  details.open = true;
  list.dispatch('toggle', { target: details });
  assert.match(details.innerHTML, new RegExp(restOfBody));
});

test('a tool_result attaches to its call by callId when opened', async () => {
  await openConvDrawerReady(makeConvSession());
  clickTab('conversation');
  const es = FakeEventSource.last;
  es.onmessage({ data: JSON.stringify({ type: 'items', items: [
    { n: 1, role: 'tool', kind: 'tool_call', text: '{"cmd":"ls"}', tool: 'Bash', callId: 'c2', isError: false, ts: 't1' },
  ] }) });
  es.onmessage({ data: JSON.stringify({ type: 'items', items: [
    { n: 2, role: 'tool', kind: 'tool_result', text: 'file1\nfile2', tool: null, callId: 'c2', isError: false, ts: 't2' },
  ] }) });
  const list = document.getElementById('conv-list');
  const m = list.innerHTML.match(/id="([^"]+)"/);
  const details = new FakeElement();
  details.dataset.entryId = m[1];
  details.open = true;
  list.dispatch('toggle', { target: details });
  assert.match(details.innerHTML, /ls/);
  assert.match(details.innerHTML, /file1/);
  assert.match(details.innerHTML, /Output/);
});

test('a session update re-renders the panel without disturbing the open conversation', async () => {
  const session = makeConvSession();
  const fleetEs = await openConvDrawerReady(session);
  clickTab('conversation');
  const convEs = FakeEventSource.last;
  convEs.onmessage({ data: JSON.stringify({ type: 'items', items: [
    { n: 1, role: 'user', kind: 'text', text: 'keep me', tool: null, callId: null, isError: false, ts: 't1' },
  ] }) });
  const before = document.getElementById('conv-list').innerHTML;
  assert.match(before, /keep me/);

  fleetEs.onmessage({ data: JSON.stringify({ type: 'session', host: 'box3', session: { ...session, updatedAt: Date.now() + 1 } }) });
  await new Promise((r) => setTimeout(r, 10)); // let the deferred animation-frame flush run

  assert.equal(document.getElementById('conv-list').innerHTML, before, 'the conversation container must not be rebuilt');
  assert.equal(convEs.closed, false, 'the conversation stream must stay open across a session update');
});

test('switching back to Roadmap or closing the panel closes the conversation EventSource', async () => {
  await openConvDrawerReady(makeConvSession());
  clickTab('conversation');
  const es1 = FakeEventSource.last;
  assert.equal(es1.closed, false);
  clickTab('roadmap');
  assert.equal(es1.closed, true, 'switching to Roadmap should close the stream');

  clickTab('conversation');
  const es2 = FakeEventSource.last;
  assert.notEqual(es2, es1);
  const closeBtn = new FakeElement();
  closeBtn.id = 'd-close';
  fireDocumentEvent('click', { target: closeBtn });
  assert.equal(es2.closed, true, 'closing the panel should close the stream');
});

test('conv-error shows its message in the tab and closes the stream', async () => {
  await openConvDrawerReady(makeConvSession());
  clickTab('conversation');
  const es = FakeEventSource.last;
  assert.match(document.getElementById('conv-status').textContent, /Loading conversation/);
  es.onmessage({ data: JSON.stringify({ type: 'conv-error', message: 'no transcript found' }) });
  assert.match(document.getElementById('conv-status').textContent, /no transcript found/);
  assert.equal(es.closed, true);
});

test('conv-warn shows a muted note', async () => {
  await openConvDrawerReady(makeConvSession());
  clickTab('conversation');
  const es = FakeEventSource.last;
  es.onmessage({ data: JSON.stringify({ type: 'conv-warn', message: '2 unreadable line(s) skipped' }) });
  const bar = document.getElementById('conv-warnbar');
  assert.equal(bar.hidden, false);
  assert.match(bar.textContent, /2 unreadable line/);
});

test('conv-reset clears the list and re-renders from the stream', async () => {
  await openConvDrawerReady(makeConvSession());
  clickTab('conversation');
  const es = FakeEventSource.last;
  es.onmessage({ data: JSON.stringify({ type: 'items', items: [
    { n: 1, role: 'user', kind: 'text', text: 'before reset', tool: null, callId: null, isError: false, ts: 't1' },
  ] }) });
  assert.match(document.getElementById('conv-list').innerHTML, /before reset/);
  es.onmessage({ data: JSON.stringify({ type: 'conv-reset' }) });
  assert.equal(document.getElementById('conv-list').innerHTML, '');
  es.onmessage({ data: JSON.stringify({ type: 'items', items: [
    { n: 1, role: 'user', kind: 'text', text: 'after reset', tool: null, callId: null, isError: false, ts: 't1' },
  ] }) });
  assert.match(document.getElementById('conv-list').innerHTML, /after reset/);
});


// ── Status changes panel ─────────────────────────────────────────────────

function clickOpenChanges() {
  const btn = new FakeElement();
  btn._matches = ['[data-open-changes]'];
  fireDocumentEvent('click', { target: btn });
}
const statusChange = (id, extra = {}) => ({ id, at: Date.now() - id * 1000, host: 'box3', key: `claude:chg-${id}`,
  agent: 'claude', name: `chg-session-${id}`, from: 'working', to: 'idle', reason: null, ...extra });

test('clicking "Status changes" fetches the last 24 hours and renders each transition', async () => {
  let url = null;
  fetchImpl = (u) => {
    if (u.startsWith('/api/status-changes')) {
      url = u;
      return Promise.resolve({ ok: true, json: async () => ({ changes: [
        statusChange(1, { to: 'waiting', reason: 'input needed' }), statusChange(2, { from: null, to: 'working' }),
        statusChange(3, { to: null })] }) });
    }
    return Promise.reject(new Error(`unexpected fetch to ${u}`));
  };
  const before = Date.now();
  clickOpenChanges();
  const rows = document.getElementById('changes-rows');
  await waitFor(() => rows.innerHTML.includes('chg-session-1'));
  const since = Number(new URL(url, 'http://x').searchParams.get('since'));
  assert.ok(Math.abs(since - (before - 86400e3)) < 5000, `since=${since} should be about 24 h ago`);
  assert.match(rows.innerHTML, /chg-session-1[\s\S]*?data-st="working"[\s\S]*?data-st="waiting"[\s\S]*?input needed/);
  assert.match(rows.innerHTML, /New session/);
  assert.match(rows.innerHTML, /No longer reported/);
  assert.match(rows.innerHTML, /Today/);
});

test('a live status change goes to the top of the open panel', async () => {
  fetchImpl = (u) => (u.startsWith('/api/status-changes')
    ? Promise.resolve({ ok: true, json: async () => ({ changes: [statusChange(5)] }) })
    : Promise.reject(new Error(`unexpected fetch to ${u}`)));
  clickOpenChanges();
  const rows = document.getElementById('changes-rows');
  await waitFor(() => rows.innerHTML.includes('chg-session-5'));
  fleetEsRef.onmessage({ data: JSON.stringify({ type: 'status-change',
    change: statusChange(0, { id: 99, name: 'fresh-one', to: 'error', reason: 'boom' }) }) });
  assert.ok(rows.innerHTML.indexOf('fresh-one') >= 0 && rows.innerHTML.indexOf('fresh-one') < rows.innerHTML.indexOf('chg-session-5'));
  assert.match(rows.innerHTML, /boom/);
});

test('a Claude session waiting on you shows the reason it gives', async () => {
  const session = makeConvSession({ state: 'waiting', waitingFor: 'input needed', name: 'waiting-demo' });
  loadFleetWith(session);
  const yard = document.getElementById(`yard-${session.host}`);
  await waitFor(() => yard.innerHTML.includes('waiting-demo'));
  assert.match(yard.innerHTML, /Waiting on you/);
  assert.match(yard.innerHTML, /class="wait-line">Claude is waiting: input needed</);
});

test('choosing "All" refetches every recorded change', async () => {
  const urls = [];
  fetchImpl = (u) => {
    if (u.startsWith('/api/status-changes')) { urls.push(u); return Promise.resolve({ ok: true, json: async () => ({ changes: [] }) }); }
    return Promise.reject(new Error(`unexpected fetch to ${u}`));
  };
  clickOpenChanges();
  const rows = document.getElementById('changes-rows');
  await waitFor(() => rows.innerHTML.includes('No status changes in the last 24 hours'));
  const range = document.getElementById('changes-range');
  range.value = 'all';
  range.dispatch('change');
  await waitFor(() => rows.innerHTML.includes('No status changes recorded yet.'));
  assert.equal(urls.at(-1), '/api/status-changes?since=0');
});


// ── Task history and Notes tabs ──────────────────────────────────────────

test('the Task history tab lists every task the session has had, including deleted ones', async () => {
  const session = makeConvSession({ name: 'history-demo' });
  await openConvDrawerReady(session);
  fetchImpl = (u) => (u.startsWith('/api/session-steps')
    ? Promise.resolve({ ok: true, json: async () => ({ steps: [
      { stepId: '1', title: 'Write the plan', status: 'done', firstSeenAt: Date.now() - 6e5,
        lastChangeAt: Date.now() - 3e5, gone: false, history: [{ status: 'pending' }, { status: 'done' }] },
      { stepId: '2', title: 'Deleted task', status: 'current', firstSeenAt: Date.now() - 6e5,
        lastChangeAt: Date.now() - 1e5, gone: true, history: [{ status: 'current' }, { status: null }] }] }) })
    : Promise.reject(new Error(`unexpected fetch to ${u}`)));
  clickTab('tasks');
  const pane = document.getElementById('d-tasks-pane');
  await waitFor(() => pane.innerHTML.includes('Write the plan'));
  assert.match(pane.innerHTML, /Deleted task/);
  assert.match(pane.innerHTML, /th-gone/);
  assert.match(pane.innerHTML, /th-tag">deleted/);
  assert.match(pane.innerHTML, /Upcoming → Done/);
});

test('a note is saved for the session and then shown on its row', async () => {
  const session = makeConvSession({ name: 'notes-demo' });
  await openConvDrawerReady(session);
  let posted = null;
  fetchImpl = (u, opts) => {
    if (u === '/api/notes' && opts && opts.method === 'POST') {
      posted = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ note: { text: posted.text.trim(), updatedAt: Date.now() } }) });
    }
    return Promise.reject(new Error(`unexpected fetch to ${u}`));
  };
  clickTab('notes');
  const box = document.getElementById('d-note');
  box.value = 'remember: gpu 7 only';
  clickSaveNote();
  await waitFor(() => posted !== null);
  assert.deepEqual([posted.host, posted.key, posted.text], [session.host, session.key, 'remember: gpu 7 only']);
  await waitFor(() => document.getElementById('d-note-status').textContent === 'saved just now');
  const yard = document.getElementById(`yard-${session.host}`);
  await waitFor(() => yard.innerHTML.includes('note-line'));
  assert.match(yard.innerHTML, /📝 remember: gpu 7 only/);
});

test('saving the same note text again sends nothing', async () => {
  const session = makeConvSession({ name: 'notes-idempotent' });
  await openConvDrawerReady(session);
  let posts = 0;
  fetchImpl = (u, opts) => {
    if (u === '/api/notes' && opts && opts.method === 'POST') {
      posts += 1;
      return Promise.resolve({ ok: true, json: async () => ({ note: { text: JSON.parse(opts.body).text.trim(), updatedAt: Date.now() } }) });
    }
    return Promise.reject(new Error(`unexpected fetch to ${u}`));
  };
  clickTab('notes');
  const box = document.getElementById('d-note');
  box.value = 'only once';
  clickSaveNote();
  // wait for the save to land, not just to be sent, before trying again
  await waitFor(() => document.getElementById('d-note-status').textContent === 'saved just now');
  assert.equal(posts, 1);
  clickSaveNote(); // unchanged: no second request
  box.dispatch('blur');
  assert.equal(posts, 1);
});

// ── runs ────────────────────────────────────────────────────────────────────────

const RUN_HOST = { name: 'box3', status: 'online', error: null, errors: [], notes: [],
  info: { python: '3.10', hostname: 'box3-host' }, lastSyncAt: Date.now(), retryAt: null };

const aRunRow = (extra = {}) => ({ host: 'box3', id: 'grpo-r3', label: 'GRPO round 3',
  status: 'Running', done: 680, total: 1000, unit: 'steps', gpus: [0, 1, 'box2:7'], pid: 42,
  alive: true, session: 'claude:a', cwd: '/w', updatedAt: Date.now(), mtime: Date.now() / 1000,
  advancedAt: Date.now(), rate: 2.4, etaSeconds: 4320, etaSource: 'measured', finished: false,
  error: null, dir: '/r', ...extra });

const yardHTML = () => document.getElementById('yard-box3').innerHTML;

const fleetES = () => FakeEventSource.byUrl.get('/api/events');

// Each load gets a unique lastSyncAt, so the wait can tell this snapshot's render from the
// HTML the previous test left in the yard.
let runLoadSeq = 0;
async function loadRuns(runs, sessions = []) {
  const stamp = 1792000000000 + (runLoadSeq += 1);
  fetchImpl = () => Promise.resolve({ ok: true,
    json: async () => ({ hosts: [{ ...RUN_HOST, lastSyncAt: stamp }], sessions, runs }) });
  fleetES().onopen();
  await waitFor(() => yardHTML().includes(`data-ago="${stamp}"`));
}

// The page is required once, so `showFinished` outlives each test: these put the host into the
// state the test needs before asserting.
async function revealFinished(host, runId) {
  if (yardHTML().includes(`data-run="${runId}"`)) return;
  clickFake('[data-finished-toggle]', { finishedToggle: host });
  await waitFor(() => yardHTML().includes(`data-run="${runId}"`));
}

async function collapseFinished(host, runId) {
  if (!yardHTML().includes(`data-run="${runId}"`)) return;
  clickFake('[data-finished-toggle]', { finishedToggle: host });
  await waitFor(() => !yardHTML().includes(`data-run="${runId}"`));
}

function clickFake(selector, dataset) {
  const el = new FakeElement();
  el._matches = [selector];
  Object.assign(el.dataset, dataset);
  fireDocumentEvent('click', { target: el, stopPropagation() {} });
}

test('a run renders a bar, its GPUs, its own status and the ETA', async () => {
  await loadRuns([aRunRow()]);
  const html = yardHTML();
  assert.match(html, /class="runs"/);
  assert.match(html, /data-run="grpo-r3"/);
  assert.match(html, /GRPO round 3/);
  assert.match(html, /Running/);
  assert.match(html, /box3 GPU 0,1 · box2 GPU 7/);
  assert.match(html, /680\/1000 steps/);
  assert.match(html, /eta 1h 12m/);
  assert.match(html, /width:\s*68%/);
});

test('a run waiting for GPUs shows its status and no bar', async () => {
  await loadRuns([aRunRow({ id: 'dllm-ar', done: undefined, total: undefined, unit: undefined,
    status: 'Waiting for 2 GPUs', gpus: [], etaSeconds: null, etaSource: null })]);
  const html = yardHTML();
  assert.match(html, /Waiting for 2 GPUs/);
  assert.doesNotMatch(html, /class="bar"/);
});

test('a run event updates the block and run-removed drops the run', async () => {
  await loadRuns([aRunRow()]);
  const es = fleetES();
  es.onmessage({ data: JSON.stringify({ type: 'run', host: 'box3', run: aRunRow({ done: 900 }) }) });
  await waitFor(() => yardHTML().includes('900/1000'));
  es.onmessage({ data: JSON.stringify({ type: 'run-removed', host: 'box3', id: 'grpo-r3' }) });
  await waitFor(() => !yardHTML().includes('data-run="grpo-r3"'));
});

test('reset clears a host\'s runs', async () => {
  await loadRuns([aRunRow()]);
  fleetES().onmessage({ data: JSON.stringify({ type: 'reset', host: 'box3' }) });
  await waitFor(() => !yardHTML().includes('class="runs"'));
});

test('a run\'s own text is escaped, never markup', async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  await loadRuns([aRunRow({ label: XSS, status: XSS, note: XSS, unit: XSS, gpus: [XSS],
    error: XSS, finished: true })]);
  // Finished runs are collapsed, so reveal them before checking what was rendered.
  await revealFinished('box3', 'grpo-r3');
  assert.doesNotMatch(yardHTML(), /<img/);
  assert.match(yardHTML(), /&lt;img/);
});

test('an overlong label still renders one run row', async () => {
  await loadRuns([aRunRow({ label: 'x'.repeat(500) })]);
  assert.equal((yardHTML().match(/data-run="/g) || []).length, 1);
  assert.match(yardHTML(), /class="run"/);
});

test('finished runs are collapsed behind a disclosure that reveals them', async () => {
  await loadRuns([aRunRow(), aRunRow({ id: 'old', finished: true, status: 'Done', etaSource: null,
    etaSeconds: null })]);
  await collapseFinished('box3', 'old');
  assert.match(yardHTML(), /data-finished-toggle="box3"/);
  assert.match(yardHTML(), /1 not running/);
  assert.doesNotMatch(yardHTML(), /data-run="old"/);
  clickFake('[data-finished-toggle]', { finishedToggle: 'box3' });
  await waitFor(() => yardHTML().includes('data-run="old"'));
  assert.match(yardHTML(), /▾ 1 not running/);
  clickFake('[data-finished-toggle]', { finishedToggle: 'box3' });
  await waitFor(() => !yardHTML().includes('data-run="old"'));
});

test('the runs block renders in both lines and cards view', async () => {
  await loadRuns([aRunRow()]);
  clickFake('[data-view]', { view: 'cards' });
  await waitFor(() => yardHTML().includes('class="cards"') || yardHTML().includes('class="runs"'));
  assert.match(yardHTML(), /class="runs"/);
  clickFake('[data-view]', { view: 'lines' });
  await waitFor(() => yardHTML().includes('class="runs"'));
  assert.match(yardHTML(), /class="runs"/);
});

test('neither the per-server limit nor a state filter hides runs', async () => {
  await loadRuns(Array.from({ length: 25 }, (_, i) => aRunRow({ id: `r${i}` })));
  assert.equal((yardHTML().match(/data-run="/g) || []).length, 25);
  clickFake('[data-filter]', { filter: 'working' });
  await waitFor(() => yardHTML().includes('data-run="r0"'));
  assert.equal((yardHTML().match(/data-run="/g) || []).length, 25);
  clickFake('[data-filter]', { filter: 'all' });
});

test('a run whose process is gone is collapsed and says it is no longer running', async () => {
  await loadRuns([aRunRow(), aRunRow({ id: 'gone', alive: false })]);
  await collapseFinished('box3', 'gone');
  assert.doesNotMatch(yardHTML(), /data-run="gone"/);
  assert.match(yardHTML(), /1 not running · show/);
  clickFake('[data-finished-toggle]', { finishedToggle: 'box3' });
  await waitFor(() => yardHTML().includes('data-run="gone"'));
  assert.match(yardHTML(), /no longer running/);
  clickFake('[data-finished-toggle]', { finishedToggle: 'box3' });
  await waitFor(() => !yardHTML().includes('data-run="gone"'));
});

test('a run that failed leads with its error', async () => {
  await loadRuns([aRunRow({ error: 'CUDA OOM on box3:1', finished: true, etaSource: null })]);
  await revealFinished('box3', 'grpo-r3');
  assert.match(yardHTML(), /CUDA OOM on box3:1/);
});

test('the row says "no change for" only when the hub measured it', async () => {
  await loadRuns([aRunRow({ advancedAt: Date.now() - 14 * 60 * 1000 })]);
  assert.match(yardHTML(), /no change for/);
  await loadRuns([aRunRow({ advancedAt: null, updatedAt: Date.now() - 3000 })]);
  assert.match(yardHTML(), /written/);
  assert.doesNotMatch(yardHTML(), /no change for/);
});

test('a run row says where it lives', async () => {
  await loadRuns([aRunRow({ cwd: '/home/alice/rl-lab' })]);
  assert.match(yardHTML(), /rl-lab/);
});

test('a failed run leads with its error, above the label line', async () => {
  await loadRuns([aRunRow({ id: 'boom', error: 'CUDA OOM on box3:1', finished: true })]);
  await revealFinished('box3', 'boom');
  const html = yardHTML();
  assert.ok(html.indexOf('class="rerr"') < html.indexOf('class="rtop"'),
    'the error should come before the label/percent line');
});
