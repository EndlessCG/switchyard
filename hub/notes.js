'use strict';
const fs = require('fs');
const path = require('path');

// A notes file that exists but can't be trusted (not JSON, or the wrong shape). Never reset it
// silently: the notes are the user's own writing and exist nowhere else.
class NotesFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotesFileError';
  }
}

const fullKey = (host, key) => `${host}|${key}`;

// Notes the user writes about a session. They live only on the machine running the hub — the
// collectors never see them and nothing is written to the servers — in one JSON file replaced
// atomically: {version: 1, notes: {"<host>|<session key>": {text, updatedAt}}}. A null file
// keeps them in memory only (tests).
class Notes {
  constructor({ file = null, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.notes = new Map(Object.entries(file ? this._load() : {}));
  }

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new NotesFileError(`${this.file} is not valid JSON (${err.message}); fix or delete it.`);
    }
    const noteOk = (n) => Boolean(n) && typeof n === 'object' && !Array.isArray(n)
      && typeof n.text === 'string' && Number.isFinite(n.updatedAt);
    const shapeOk = Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw) && raw.version === 1
      && Boolean(raw.notes) && typeof raw.notes === 'object' && !Array.isArray(raw.notes)
      && Object.values(raw.notes).every(noteOk);
    if (!shapeOk) {
      throw new NotesFileError(`${this.file} has an unexpected shape for a Switchyard notes file; fix or delete it.`);
    }
    return raw.notes;
  }

  _write(notes) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, notes: Object.fromEntries(notes) }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(host, key) {
    return this.notes.get(fullKey(host, key)) || null;
  }

  all() {
    return [...this.notes].map(([k, note]) => {
      const cut = k.indexOf('|');
      return { host: k.slice(0, cut), key: k.slice(cut + 1), ...note };
    });
  }

  // Saves a note, or removes it when the text is blank. The file is written before memory is
  // updated, so a failed write (full disk, permissions, …) never leaves memory ahead of it.
  set(host, key, text) {
    const trimmed = text.trim();
    const next = new Map(this.notes);
    const note = { text: trimmed, updatedAt: this.now() };
    if (trimmed) next.set(fullKey(host, key), note);
    else next.delete(fullKey(host, key));
    if (this.file) this._write(next);
    this.notes = next;
    return trimmed ? note : null;
  }
}

module.exports = { Notes, NotesFileError };
