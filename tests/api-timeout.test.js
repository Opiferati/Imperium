'use strict';
// Offline: no call leaves this machine. A stalled DNS lookup and a local server that never answers
// stand in for the two ways a socket can time out.
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const net = require('node:net');
const { timeoutError, requestOnce, fmt } = require('../runners/api-timeout.js');

const OPTS = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } };

test('the cause, on record: Node\'s default https agent gives connecting sockets a 5 s timeout', () => {
  assert.equal(https.globalAgent.options.keepAlive, true);
  assert.equal(https.globalAgent.options.timeout, 5000);
});

test('a stalled DNS lookup is labelled a connect timeout, not "8 min"', async () => {
  const agent = new https.Agent({ keepAlive: true, timeout: 200 });   // same mechanism as the 5 s default, faster
  let stall;                                                          // a lookup that answers far too late
  const stalledLookup = (host, o, cb) => { stall = setTimeout(() => cb(new Error('lookup never answered')), 3_000); };
  const t0 = Date.now();
  const out = await requestOnce(https, { ...OPTS, lookup: stalledLookup }, '{}', { idleMs: 8 * 60_000, agent });
  assert.ok(Date.now() - t0 < 2_000, 'gave up at the agent\'s connect timer');
  assert.equal(out.error.kind, 'connect-timeout');
  assert.equal(out.error.code, 'ETIMEDOUT');                          // still retried by api-retry
  assert.match(out.error.message, /^API connect timed out after 0\.\d s \(DNS or network/);
  assert.doesNotMatch(out.error.message, /8 min/);
  clearTimeout(stall); agent.destroy();
});

test('a server that connects but never replies hits our own limit, and says so', async () => {
  const sockets = [];
  const srv = net.createServer(s => sockets.push(s));                 // accepts TCP, never answers TLS
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const agent = new https.Agent({ keepAlive: true, timeout: 5_000 });
  const out = await requestOnce(https, { ...OPTS, hostname: '127.0.0.1', port: srv.address().port, rejectUnauthorized: false },
                                '{}', { idleMs: 300, agent });
  assert.equal(out.error.kind, 'idle-timeout');
  assert.equal(out.error.message, 'API call timed out after 0.3 s with no reply');
  agent.destroy(); sockets.forEach(s => s.destroy()); srv.close();
});

test('labels: the three cases, from the socket and the clock', () => {
  const idleMs = 8 * 60_000, startedAt = 0;
  assert.equal(timeoutError({ socket: { connecting: true } }, { startedAt, idleMs, now: 5_000 }).kind, 'connect-timeout');
  assert.equal(timeoutError({}, { startedAt, idleMs, now: 5_000 }).kind, 'connect-timeout');
  const idle = timeoutError({ socket: { connecting: false } }, { startedAt, idleMs, now: idleMs + 20 });
  assert.equal(idle.kind, 'idle-timeout');
  assert.equal(idle.message, 'API call timed out after 8 min with no reply');
  const early = timeoutError({ socket: { connecting: false } }, { startedAt, idleMs, now: 90_000 });
  assert.equal(early.kind, 'socket-timeout');
  assert.match(early.message, /after 1\.5 min \(an earlier timer than the 8 min limit fired\)/);
});

test('fmt', () => {
  assert.equal(fmt(5_000), '5 s'); assert.equal(fmt(480_000), '8 min'); assert.equal(fmt(90_000), '1.5 min');
});
