'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../../package.json');

test('engines.node requires >=18.2.0 (server.closeAllConnections needs 18.2)', () => {
  assert.equal(pkg.engines.node, '>=18.2.0');
});
