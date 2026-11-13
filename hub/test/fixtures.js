'use strict';
const fs = require('fs');
const path = require('path');

const TEMP_ROOT = path.join(__dirname, '..', '..', '.test-tmp');
const created = [];

// A directory under <repo>/.test-tmp/ (never os.tmpdir(): the project's tests must not
// write to /tmp). Tracked so cleanupTempDirs() can remove it after the tests that made it.
function tempDir(prefix) {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
  created.push(dir);
  return dir;
}

function cleanupTempDirs() {
  while (created.length) {
    fs.rmSync(created.pop(), { recursive: true, force: true });
  }
}

function script(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}`);
  fs.chmodSync(p, 0o755);
  return p;
}

// A fake home with one live Claude session that has two tasks, plus stand-in claude/codex binaries.
function makeHome() {
  const home = tempDir('sy-home-');
  const tasks = path.join(home, '.claude', 'tasks', 's-1');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, '1.json'), JSON.stringify({ id: '1', subject: 'Build the prompt set', status: 'completed', blocks: [], blockedBy: [] }));
  fs.writeFileSync(path.join(tasks, '2.json'), JSON.stringify({ id: '2', subject: 'Generate responses', status: 'in_progress', blocks: [], blockedBy: ['1'] }));
  const agents = JSON.stringify([{ pid: process.pid, cwd: '/work/proj', kind: 'interactive', startedAt: 1, sessionId: 's-1', name: 'demo-sess', status: 'busy' }]);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const claude = script(bin, 'claude', `if [ "$1" = "--version" ]; then echo "2.1.271 (Claude Code)"; exit 0; fi\ncat <<'EOF'\n${agents}\nEOF\n`);
  const codex = script(bin, 'codex', 'echo "codex-cli 0.153.4"\n');
  return { home, claude, codex, bin };
}

async function waitFor(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
}

module.exports = { script, makeHome, waitFor, tempDir, cleanupTempDirs };
