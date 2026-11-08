'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetries, isRetryable } = require('../runners/api-retry.js');

// A fake API: returns the scripted outcomes in order; records every sleep.
function script(...outcomes) {
  let i = 0; const sleeps = [];
  return { once: async () => outcomes[Math.min(i++, outcomes.length - 1)], calls: () => i, sleeps,
           opts: { sleep: async ms => { sleeps.push(ms); }, delays: [5_000, 15_000, 45_000] } };
}
const ok = { status: 200, body: { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }, headers: {} };
const overloaded = { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, headers: {} };

test('a clean call goes straight through, no waiting', async () => {
  const s = script(ok);
  assert.deepEqual(await withRetries(s.once, s.opts), ok.body);
  assert.equal(s.calls(), 1); assert.deepEqual(s.sleeps, []);
});

test('"overloaded" twice, then fine: the reading survives (5 s, then 15 s)', async () => {
  const s = script(overloaded, overloaded, ok);
  assert.deepEqual(await withRetries(s.once, s.opts), ok.body);
  assert.equal(s.calls(), 3); assert.deepEqual(s.sleeps, [5_000, 15_000]);
});

test('a dropped connection or a timeout is retried', async () => {
  const s = script({ error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
                   { error: Object.assign(new Error('API call timed out after 8 min'), { code: 'ETIMEDOUT' }) }, ok);
  assert.deepEqual(await withRetries(s.once, s.opts), ok.body);
  assert.equal(s.calls(), 3);
});

test('rate limit honors retry-after (capped at 60 s)', async () => {
  const s = script({ status: 429, body: { error: { type: 'rate_limit_error' } }, headers: { 'retry-after': '20' } },
                   { status: 429, body: { error: { type: 'rate_limit_error' } }, headers: { 'retry-after': '600' } }, ok);
  await withRetries(s.once, s.opts);
  assert.deepEqual(s.sleeps, [20_000, 60_000]);
});

test('never retried: bad request, bad key, out of credit — returned at once for the caller to report', async () => {
  for (const [status, type] of [[400, 'invalid_request_error'], [401, 'authentication_error'], [403, 'permission_error'], [402, 'billing_error']]) {
    const bad = { status, body: { type: 'error', error: { type, message: 'x' } }, headers: {} };
    const s = script(bad, ok);
    assert.deepEqual(await withRetries(s.once, s.opts), bad.body, type);
    assert.equal(s.calls(), 1, type);
  }
});

test('gives up after 3 retries: last error body returned, or the network error thrown', async () => {
  const s = script(overloaded);
  assert.deepEqual(await withRetries(s.once, s.opts), overloaded.body);
  assert.equal(s.calls(), 4); assert.deepEqual(s.sleeps, [5_000, 15_000, 45_000]);
  const n = script({ error: Object.assign(new Error('getaddrinfo EAI_AGAIN api.anthropic.com'), { code: 'EAI_AGAIN' }) });
  await assert.rejects(withRetries(n.once, n.opts), /EAI_AGAIN/);
  assert.equal(n.calls(), 4);
});

test('isRetryable: an unknown local error is not retried', () => {
  assert.equal(isRetryable({ error: new Error('ANTHROPIC_API_KEY not set') }), false);
  assert.equal(isRetryable({ status: 200, body: { content: [] } }), false);
});
