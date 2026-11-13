'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tempDir, cleanupTempDirs } = require('./fixtures');

test('tempDir creates a directory under the repo, not os.tmpdir(), and cleanupTempDirs removes it', () => {
  const dir = tempDir('sy-fixturetest-');
  assert.ok(fs.existsSync(dir));
  assert.ok(dir.startsWith(path.join(__dirname, '..', '..', '.test-tmp')) || dir.includes(`${path.sep}.test-tmp${path.sep}`));
  assert.ok(!dir.startsWith(os.tmpdir()));
  cleanupTempDirs();
  assert.ok(!fs.existsSync(dir));
});
