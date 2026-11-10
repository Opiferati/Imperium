'use strict';
// A bell on a child's work. The tests that matter here are the honest ones:
// the message has to say the work may still be running, and real work must
// never be mistaken for a hang.

const { test } = require('node:test');
const assert   = require('node:assert');
const { withDeadline, limitMs, DEFAULT_MIN } = require('../runners/deadline.js');

const sleep = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));

test('the supervision policy outranks the station block, which outranks the default', () => {
  const reg = { cavalier: { timeout_min: 5 } };
  assert.strictEqual(limitMs('cavalier', { timeout_min: 2 }, reg), 2 * 60_000);
  assert.strictEqual(limitMs('cavalier', {}, reg), 5 * 60_000);
  assert.strictEqual(limitMs('nobody', {}, reg), DEFAULT_MIN * 60_000);
});

test('a hyphenated card finds its underscored registry block', () => {
  const reg = { ravens_league: { timeout_min: 3 } };
  assert.strictEqual(limitMs('ravens-league', {}, reg), 3 * 60_000);
});

test('there is no way to opt out of a deadline', () => {
  const reg = { sneaky: { timeout_min: 0 } };
  assert.strictEqual(limitMs('sneaky', { timeout_min: -1 }, reg), DEFAULT_MIN * 60_000);
  assert.strictEqual(limitMs('sneaky', { timeout_min: null }, {}), DEFAULT_MIN * 60_000);
});

test('work that finishes in time comes back untouched', async () => {
  const v = await withDeadline(sleep(5, { status: 'ok', n: 1 }), 60_000, 'quick');
  assert.deepStrictEqual(v, { status: 'ok', n: 1 });
});

test('a value that is not a promise is fine', async () => {
  assert.strictEqual(await withDeadline({ status: 'ok' }, 60_000, 'plain').then(v => v.status), 'ok');
});

test('a hang rings the bell, names the child, and admits the work may still be running', async () => {
  await assert.rejects(
    () => withDeadline(sleep(200, 'never arrives'), 20, 'stuck'),
    (e) => {
      assert.strictEqual(e.deadline, true, 'marked as a deadline, so the court can tell it apart');
      assert.match(e.message, /stuck/);
      assert.match(e.message, /deadline/);
      assert.match(e.message, /may still be running/);
      return true;
    },
  );
});

test('a child that fails on its own keeps its own error, not the bell', async () => {
  await assert.rejects(
    () => withDeadline(Promise.reject(new Error('source down')), 60_000, 'honest'),
    (e) => e.message === 'source down' && e.deadline === undefined,
  );
});

test('a non-positive deadline means no bell at all', async () => {
  assert.strictEqual(await withDeadline(sleep(5, 'done'), 0, 'unbelled'), 'done');
});

test('the bell is cleared when work wins, so nothing is left ticking', async () => {
  // If the timer survived, node --test would not be able to exit cleanly.
  for (let i = 0; i < 5; i++) {
    await withDeadline(sleep(1, i), 30_000, `fast-${i}`);
  }
  assert.ok(true);
});
