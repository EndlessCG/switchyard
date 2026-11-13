'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { NotFoundError } = require('./dashboard');
const { conversationCommand, killGroup, COLLECTOR_PATH } = require('./host-link');
const { Notes } = require('./notes');

// key = 'claude:<sessionId>' or 'codex:<threadId>'.
const CONVERSATION_KEY = /^(claude|codex):[A-Za-z0-9._-]+$/;

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

// Rejects DNS rebinding: a browser page on an attacker's domain that points at 127.0.0.1
// can still make the victim's browser send that domain as the Host header, so the port
// alone (which we're bound to) isn't enough of a check.
function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  if (hostHeader.startsWith('[')) return hostHeader.slice(1, hostHeader.indexOf(']')); // IPv6, e.g. [::1]:3456
  return hostHeader.split(':')[0];
}

function checkHost(req, res, next) {
  const hostname = hostnameOf(req.headers.host);
  if (hostname && ALLOWED_HOSTNAMES.has(hostname)) return next();
  const port = req.socket.localPort;
  return res.status(403).json({
    error: `Host '${req.headers.host}' is not allowed. Open the dashboard at http://127.0.0.1:${port}/ instead.`,
  });
}

// Rejects a cross-origin write even from a browser that resolved 127.0.0.1 itself (a page on
// some other origin, submitting the form/fetch to us): the port must match too, since anything
// on the loopback address could otherwise reach every port a user might be running a hub on.
function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next(); // curl and other non-browser clients don't send one
  let u;
  try {
    u = new URL(origin);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return res.status(403).json({ error: `Origin '${origin}' is not allowed.` });
  }
  const defaultPort = u.protocol === 'https:' ? 443 : 80;
  const originPort = u.port ? Number(u.port) : defaultPort;
  if (!ALLOWED_HOSTNAMES.has(u.hostname) || originPort !== req.socket.localPort) {
    return res.status(403).json({
      error: `Origin '${origin}' is not allowed. Open the dashboard at http://127.0.0.1:${req.socket.localPort}/ instead.`,
    });
  }
  return next();
}

function requireJsonContentType(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    return res.status(415).json({ error: `Content-Type must be application/json, got ${JSON.stringify(req.headers['content-type'] || null)}` });
  }
  return next();
}

function requireHostAndKey(req, res, next) {
  const { host, key } = req.body || {};
  if (typeof host !== 'string' || typeof key !== 'string') {
    return res.status(400).json({ error: 'body must be {"host": string, "key": string}' });
  }
  return next();
}

// express.json() reports a malformed body via next(err), not by calling the handler; without
// this, that err falls through to Express's default handler, which answers with an HTML page
// (and a stack trace) instead of the {error} shape every other route on here uses. Only the
// body-parser's own parse-failure is handled — anything else is a hub bug, not a client mistake.
function jsonParseErrors(err, req, res, next) {
  if (err && err.type === 'entity.parse.failed' && (err.status === 400 || err.statusCode === 400)) {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
}

// remove/restore share everything but which Dashboard method they call.
function dashboardWrite(fn) {
  return (req, res) => {
    const { host, key } = req.body;
    try {
      fn(host, key);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      throw err; // a hub bug, not a client mistake: let Express report a 500
    }
    res.json({ ok: true });
  };
}

function createApp(dashboard, { publicDir = path.join(__dirname, '..', 'public'),
  config = { hosts: [], pollSeconds: 2, ssh: {} },
  collectorSource = fs.readFileSync(COLLECTOR_PATH, 'utf8'),
  notes = new Notes() } = {}) {
  const app = express();
  dashboard.setMaxListeners(0); // each open browser tab adds one listener per event
  app.use(checkHost);
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.static(publicDir));

  app.get('/api/fleet', (req, res) => res.json(dashboard.snapshot()));
  app.get('/api/dashboard/hidden', (req, res) => res.json({ sessions: dashboard.hiddenSessions() }));
  // Status changes at or after `since` (epoch ms; default 0, i.e. all of them), newest first.
  app.get('/api/status-changes', (req, res) => {
    const raw = req.query.since ?? '0';
    const since = Number(raw);
    if (typeof raw !== 'string' || raw.trim() === '' || !Number.isFinite(since) || since < 0) {
      return res.status(400).json({ error: `since must be a time in epoch milliseconds, got ${JSON.stringify(raw)}` });
    }
    return res.json({ changes: dashboard.statusChanges(since) });
  });
  // Every task this session has ever had, including ones the agent has since deleted.
  app.get('/api/session-steps', (req, res) => {
    const { host, key } = req.query;
    if (typeof host !== 'string' || typeof key !== 'string' || !CONVERSATION_KEY.test(key)) {
      return res.status(400).json({ error: `host must be a host name and key must match ${CONVERSATION_KEY}` });
    }
    return res.json({ steps: dashboard.sessionSteps(host, key) });
  });
  // The user's notes about sessions. They stay on this machine: nothing is sent to the servers.
  app.get('/api/notes', (req, res) => res.json({ notes: notes.all() }));

  const jsonBody = express.json(); // only these routes need a parsed body
  // Origin is checked before the body is parsed: a cross-origin request must get 403 even when
  // its body also happens to be malformed, not a 400 that leaks past the origin check.
  app.post('/api/dashboard/remove', requireJsonContentType, requireSameOrigin, jsonBody, jsonParseErrors, requireHostAndKey,
    dashboardWrite((host, key) => dashboard.remove(host, key)));
  app.post('/api/dashboard/restore', requireJsonContentType, requireSameOrigin, jsonBody, jsonParseErrors, requireHostAndKey,
    dashboardWrite((host, key) => dashboard.restore(host, key)));
  app.post('/api/dashboard/add', requireJsonContentType, requireSameOrigin, jsonBody, jsonParseErrors, requireHostAndKey,
    dashboardWrite((host, key) => dashboard.add(host, key)));
  // Saves a session's note, or removes it when the text is blank. Any host/key is accepted: a
  // note about a session that isn't on the dashboard (or has ended) is still the user's to keep.
  app.post('/api/notes', requireJsonContentType, requireSameOrigin, jsonBody, jsonParseErrors, (req, res) => {
    const { host, key, text } = req.body || {};
    if (typeof host !== 'string' || typeof key !== 'string' || typeof text !== 'string') {
      return res.status(400).json({ error: 'body must be {"host": string, "key": string, "text": string}' });
    }
    return res.json({ note: notes.set(host, key, text) });
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const board = (host, s) => { if (s && s.agent === 'claude') send({ type: 'update', sessionId: `${host}~${s.id}` }); };
    const handlers = {
      host: (h) => send({ type: 'host', host: h }),
      session: (host, s) => { send({ type: 'session', host, session: s }); board(host, s); },
      removed: (host, key, previous) => { send({ type: 'removed', host, key }); board(host, previous); },
      reset: (host) => send({ type: 'reset', host }),
      tick: (host, at) => send({ type: 'tick', host, at }),
      'status-change': (change) => send({ type: 'status-change', change }),
      run: (host, run) => send({ type: 'run', host, run }),
      'run-removed': (host, id) => send({ type: 'run-removed', host, id }),
    };
    for (const [e, fn] of Object.entries(handlers)) dashboard.on(e, fn);
    req.on('close', () => { for (const [e, fn] of Object.entries(handlers)) dashboard.off(e, fn); });
    send({ type: 'connected' });
  });

  // Streams one session's full Claude Code or Codex conversation. Each open tab
  // gets its own collector process; there's no caching or de-duplication across tabs.
  app.get('/api/conversation', (req, res) => {
    const host = config.hosts.find((h) => h.name === req.query.host);
    if (!host) return res.status(404).json({ error: `unknown host ${JSON.stringify(req.query.host)}` });
    const key = req.query.key;
    if (typeof key !== 'string' || !CONVERSATION_KEY.test(key)) {
      return res.status(400).json({ error: `key must match ${CONVERSATION_KEY} (got ${JSON.stringify(key)})` });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const { cmd, args } = conversationCommand(host, config, key);
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stderr = '';
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          JSON.parse(line); // validated, then forwarded byte-for-byte: no re-serialization drift
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
          send({ type: 'conv-error', message: `collector sent something unreadable: ${line}` });
          continue;
        }
        res.write(`data: ${line}\n\n`);
      }
    });
    child.on('close', (code) => {
      if (code !== 0) send({ type: 'conv-error', message: stderr.trim() || `collector exited with code ${code}` });
      res.end();
    });
    child.stdin.end(collectorSource);
    req.on('close', () => killGroup(child, 'SIGTERM'));
  });

  // ── upstream board (public/board.html), read-only ──
  app.get('/api/sessions', (req, res) => {
    const p = String(req.query.limit || '20'); // upstream's default
    const limit = p === 'all' ? null : Number(p);
    if (limit !== null && !(Number.isInteger(limit) && limit > 0)) {
      return res.status(400).json({ error: `limit must be a positive whole number or "all", got "${p}"` });
    }
    return res.json(dashboard.boardSessions(limit));
  });
  app.get('/api/sessions/:id', (req, res) => {
    const tasks = dashboard.boardTasks(req.params.id);
    if (!tasks) return res.status(404).json({ error: 'Session not found' });
    return res.json(tasks);
  });
  app.get('/api/tasks/all', (req, res) => res.json(dashboard.allBoardTasks()));
  const notYet = (req, res) => res.status(501).json({
    error: "Editing tasks from the dashboard isn't available yet: Switchyard only reads them.",
  });
  app.post('/api/tasks/:sessionId/:taskId/note', notYet);
  app.delete('/api/tasks/:sessionId/:taskId', notYet);
  return app;
}

module.exports = { createApp };
