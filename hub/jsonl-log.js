'use strict';
const fs = require('fs');
const path = require('path');

// Shared reader/writer for the hub's history files: one JSON object per line, appended as
// things happen, never rewritten. A line that isn't a valid record is an error naming the line
// number — never a silent reset, because these files are the only copy of the history.
function loadJsonl(file, isValid, fail) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw fail(`${file} line ${i + 1} is not valid JSON (${err.message}); fix or delete that line.`);
    }
    if (!isValid(value)) {
      throw fail(`${file} line ${i + 1} is not a Switchyard ${path.basename(file)} record; fix or delete that line.`);
    }
    entries.push(value);
  });
  return entries;
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

module.exports = { loadJsonl, appendJsonl };
