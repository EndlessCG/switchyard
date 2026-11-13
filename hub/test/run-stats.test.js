'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RunStats } = require('../run-stats');

// A clock that returns each time in turn, then sticks on the last one.
function clockOf(times) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}
const run = (done, extra = {}) => ({ id: 'a', status: 'Running', done, total: 20, ...extra });

test('a single sample measures nothing', () => {
  const stats = new RunStats({ now: clockOf([1000]) });
  stats.observe('h', run(0));
  const d = stats.decorate('h', run(0));
  assert.equal(d.rate, null);
  assert.equal(d.etaSeconds, null);
  assert.equal(d.etaSource, null);
  assert.equal(d.advancedAt, null);
});

test('rate and ETA come from the basis and the latest sample', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000]) });
  stats.observe('h', run(0));
  stats.observe('h', run(10));
  const d = stats.decorate('h', run(10));
  assert.equal(d.rate, 1);          // 10 units in 10 s
  assert.equal(d.etaSeconds, 10);   // 10 left at 1/s
  assert.equal(d.etaSource, 'measured');
});

test('a sample is recorded only when done changes', () => {
  const stats = new RunStats({ now: clockOf([1000, 5000, 9000]) });
  stats.observe('h', run(3));
  stats.observe('h', run(3));  // the record was rewritten, but nothing advanced
  stats.observe('h', run(3));
  const d = stats.decorate('h', run(3));
  assert.equal(d.rate, null);
  assert.equal(d.etaSeconds, null);
  assert.equal(d.advancedAt, null);
});

test('advancedAt is when done last changed, not when the record was last written', () => {
  const stats = new RunStats({ now: clockOf([1000, 2000, 60000, 90000]) });
  stats.observe('h', run(1));
  stats.observe('h', run(2));            // advanced at 2000
  stats.observe('h', run(2));            // rewritten at 60000, no advance
  stats.observe('h', run(2));            // rewritten at 90000, no advance
  assert.equal(stats.decorate('h', run(2)).advancedAt, 2000);
});

test('the basis resets when total changes, so a new phase is not extrapolated', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000, 12000, 13000]) });
  stats.observe('h', run(0));
  stats.observe('h', run(10));                        // 1 unit/s over the training phase
  stats.observe('h', { id: 'a', done: 0, total: 50 }); // Evaluating: new basis
  assert.equal(stats.decorate('h', { id: 'a', done: 0, total: 50 }).rate, null);
  stats.observe('h', { id: 'a', done: 1, total: 50 });
  const d = stats.decorate('h', { id: 'a', done: 1, total: 50 });
  assert.equal(d.rate, 1);        // 1 unit in 1 s, measured inside the new phase
  assert.equal(d.etaSeconds, 49);
});

test('the basis resets when done decreases, as a restarted run reusing its id', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000, 12000, 22000]) });
  stats.observe('h', run(0));
  stats.observe('h', run(10));
  stats.observe('h', run(2));     // restarted
  assert.equal(stats.decorate('h', run(2)).rate, null);
  stats.observe('h', run(3));
  assert.equal(stats.decorate('h', run(3)).rate, 0.1); // 1 unit in 10 s
});

test('samples outlive a reconnect: nothing clears them but the run itself changing basis', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000]) });
  stats.observe('h', run(0));
  stats.observe('h', run(10));
  // A hello would clear FleetState's runs; the stats are keyed host|id and stay.
  assert.equal(stats.decorate('h', run(10)).rate, 1);
});

test('a reported eta wins and says so', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000]) });
  stats.observe('h', run(0));
  stats.observe('h', run(10, { eta: 42 }));
  const d = stats.decorate('h', run(10, { eta: 42 }));
  assert.equal(d.etaSeconds, 42);
  assert.equal(d.etaSource, 'reported');
  assert.equal(d.rate, 1); // still measured and shown
});

test('an unusable reported eta falls back to the measured one', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000]) });
  stats.observe('h', run(0));
  for (const bad of ['soon', -5, null, Infinity, NaN, {}]) {
    stats.observe('h', run(10, { eta: bad }));
    const d = stats.decorate('h', run(10, { eta: bad }));
    assert.equal(d.etaSource, 'measured', `eta ${JSON.stringify(bad)} should be ignored`);
  }
});

test('a finished run gets no ETA, however it is still being rewritten', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000, 12000]) });
  stats.observe('h', run(0));
  stats.observe('h', run(10));
  stats.observe('h', run(10, { finished: true }));
  const d = stats.decorate('h', run(10, { finished: true, eta: 30 }));
  assert.equal(d.etaSeconds, null);
  assert.equal(d.etaSource, null);
});

test('an impossible total or an overshooting done yields no ETA', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000, 12000, 13000]) });
  stats.observe('h', { id: 'a', done: 0, total: 0 });
  stats.observe('h', { id: 'a', done: 5, total: 0 });
  assert.equal(stats.decorate('h', { id: 'a', done: 5, total: 0 }).etaSeconds, null);
  const over = new RunStats({ now: clockOf([1000, 11000]) });
  over.observe('h', run(0));
  over.observe('h', run(25));   // done past total
  const d = over.decorate('h', run(25));
  assert.equal(d.etaSeconds, null, 'no negative remainder');
});

test('a status-only run measures nothing and still decorates', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000]) });
  const waiting = { id: 'a', status: 'Waiting for 4 GPUs' };
  stats.observe('h', waiting);
  stats.observe('h', waiting);
  const d = stats.decorate('h', waiting);
  assert.equal(d.rate, null);
  assert.equal(d.etaSeconds, null);
  assert.equal(d.advancedAt, null);
});

test('decorate does not mutate the run it is given, and keeps its fields', () => {
  const stats = new RunStats({ now: clockOf([1000]) });
  const given = run(3, { label: 'grpo', gpus: [0, 1] });
  stats.observe('h', given);
  const d = stats.decorate('h', given);
  assert.deepEqual(Object.keys(given).sort(), ['done', 'gpus', 'id', 'label', 'status', 'total']);
  assert.equal(d.label, 'grpo');
  assert.deepEqual(d.gpus, [0, 1]);
});

test('runs on different hosts with the same id are measured apart', () => {
  const stats = new RunStats({ now: clockOf([1000, 1000, 11000]) });
  stats.observe('box1', run(0));
  stats.observe('box3', run(0));
  stats.observe('box1', run(10));
  assert.equal(stats.decorate('box1', run(10)).rate, 1);
  assert.equal(stats.decorate('box3', run(0)).rate, null);
});

test('a total that keeps changing while done is frozen is not progress', () => {
  // A reporter that recomputes `total` every poll (files remaining, a re-scanned dataset) must
  // not make a stuck run read as having just advanced — that is anti-goal 3.
  const stats = new RunStats({ now: clockOf([1000, 2000, 60000, 120000]) });
  stats.observe('h', { id: 'a', done: 42, total: 1000 });
  stats.observe('h', { id: 'a', done: 42, total: 1001 });
  stats.observe('h', { id: 'a', done: 42, total: 1002 });
  assert.equal(stats.decorate('h', { id: 'a', done: 42, total: 1002 }).advancedAt, null);
});

test('a basis reset keeps the time done last moved', () => {
  const stats = new RunStats({ now: clockOf([1000, 5000, 9000]) });
  stats.observe('h', run(1));
  stats.observe('h', run(2));                          // advanced at 5000
  stats.observe('h', { id: 'a', done: 2, total: 99 }); // new phase, same done
  assert.equal(stats.decorate('h', { id: 'a', done: 2, total: 99 }).advancedAt, 5000);
});

test('forget drops a run\'s samples', () => {
  const stats = new RunStats({ now: clockOf([1000, 11000, 12000]) });
  stats.observe('h', run(0));
  stats.observe('h', run(10));
  assert.equal(stats.decorate('h', run(10)).rate, 1);
  stats.forget('h', 'a');
  stats.observe('h', run(11));
  assert.equal(stats.decorate('h', run(11)).rate, null);
});
