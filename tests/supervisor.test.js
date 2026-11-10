'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeSupervisor } = require('../runners/supervisor.js');

const quiet = { log() {}, warn() {} };
// Policies in tests use no real waiting: backoff_s of 0 keeps the suite fast.
const fast = { backoff_s: [0] };

test('a healthy child just runs', async () => {
  const sup = makeSupervisor({ log: quiet });
  const r = await sup.supervise('skald', async () => 42, fast);
  assert.deepStrictEqual([r.ok, r.value, r.attempts, r.state], [true, 42, 1, 'ok']);
  assert.strictEqual(sup.health('skald').state, 'ok');
  assert.strictEqual(sup.summaryLine(), null);          // silent when all is well
});

test('a flaky child is retried and recovers', async () => {
  const sup = makeSupervisor({ log: quiet });
  let n = 0;
  const r = await sup.supervise('cavalier', async () => { if (++n < 2) throw new Error('timeout'); return 'ok'; },
                                { ...fast, attempts: 3 });
  assert.deepStrictEqual([r.ok, r.attempts, r.value], [true, 2, 'ok']);
  assert.strictEqual(sup.health('cavalier').state, 'ok');
});

test('attempts are bounded: it gives up without throwing', async () => {
  const sup = makeSupervisor({ log: quiet });
  let calls = 0;
  const r = await sup.supervise('ravens', async () => { calls++; throw new Error('no data'); },
                                { ...fast, attempts: 3, max_failures: 9 });
  assert.strictEqual(calls, 3);                          // exactly the attempts allowed, not one more
  assert.deepStrictEqual([r.ok, r.state, r.error], [false, 'failed', 'no data']);
  assert.strictEqual(sup.health('ravens').state, 'shaky');
});

test('restart intensity: enough failures and the child is disabled, not retried forever', async () => {
  const sup = makeSupervisor({ log: quiet });
  const boom = async () => { throw new Error('dead source'); };
  const policy = { ...fast, attempts: 1, max_failures: 3, within_hours: 24 };
  let calls = 0;
  const counting = async () => { calls++; return boom(); };
  for (let i = 0; i < 3; i++) await sup.supervise('weatherwise', counting, policy);
  assert.strictEqual(sup.health('weatherwise').state, 'disabled');
  const after = await sup.supervise('weatherwise', counting, policy);
  assert.deepStrictEqual([after.ok, after.state, after.skipped], [false, 'disabled', true]);
  assert.strictEqual(calls, 3);                          // it stopped calling: no horse-beating all night
  assert.match(sup.summaryLine(), /weatherwise: disabled/);
});

test('the window slides: old failures are forgiven', async () => {
  let clock = new Date('2026-11-09T18:00:00Z');
  const sup = makeSupervisor({ log: quiet, now: () => clock });
  const boom = async () => { throw new Error('x'); };
  const policy = { ...fast, attempts: 1, max_failures: 3, within_hours: 24 };
  await sup.supervise('a', boom, policy);
  await sup.supervise('a', boom, policy);
  clock = new Date('2026-11-12T18:00:00Z');              // three days later
  await sup.supervise('a', boom, policy);
  assert.strictEqual(sup.health('a').state, 'shaky');     // not disabled: the first two aged out
  assert.strictEqual(sup.health('a').failures_in_window, 1);
});

test('rest_for_one: a child whose dependency failed is skipped, not fed stale data', async () => {
  const sup = makeSupervisor({ log: quiet });
  await sup.supervise('cavalier', async () => { throw new Error('price file missing'); },
                      { ...fast, attempts: 1, max_failures: 9 });
  let ravensRan = false;
  const r = await sup.supervise('ravens-league', async () => { ravensRan = true; return 'league'; },
                                { ...fast, after: ['cavalier'] });
  assert.strictEqual(ravensRan, false);
  assert.deepStrictEqual([r.ok, r.state, r.skipped], [false, 'skipped', true]);
  assert.match(r.reason, /depends on cavalier/);
});

test('a dependency that recovered does not block its dependents', async () => {
  const sup = makeSupervisor({ log: quiet });
  let n = 0;
  await sup.supervise('cavalier', async () => { if (++n < 2) throw new Error('blip'); return 1; },
                      { ...fast, attempts: 2 });
  const r = await sup.supervise('ravens-league', async () => 'league', { ...fast, after: ['cavalier'] });
  assert.deepStrictEqual([r.ok, r.value], [true, 'league']);
});

test('temporary children get one shot and are never retried', async () => {
  const sup = makeSupervisor({ log: quiet });
  let calls = 0;
  await sup.supervise('one-shot', async () => { calls++; throw new Error('x'); },
                      { ...fast, restart: 'temporary', attempts: 5 });
  assert.strictEqual(calls, 1);
});

test('only the Emperor can revive a disabled child', async () => {
  const sup = makeSupervisor({ log: quiet });
  const policy = { ...fast, attempts: 1, max_failures: 1 };
  await sup.supervise('b', async () => { throw new Error('x'); }, policy);
  assert.strictEqual(sup.health('b').state, 'disabled');
  assert.strictEqual(sup.revive('b'), true);
  assert.strictEqual(sup.health('b').state, 'ok');
  const r = await sup.supervise('b', async () => 'back', policy);
  assert.strictEqual(r.value, 'back');
  assert.strictEqual(sup.revive('nobody'), false);
});

test('health is published to the Blackboard when one is present, and absence is survivable', async () => {
  const posted = [];
  const board = { post: n => posted.push(n) };
  const sup = makeSupervisor({ log: quiet, board });
  await sup.supervise('skald', async () => 1, fast);
  assert.strictEqual(posted[0].topic, 'supervisor.skald.health');
  assert.strictEqual(posted[0].value.state, 'ok');
  const broken = makeSupervisor({ log: quiet, board: { post() { throw new Error('board gone'); } } });
  const r = await broken.supervise('skald', async () => 1, fast);
  assert.strictEqual(r.ok, true);                         // a dead board never breaks supervision
});
