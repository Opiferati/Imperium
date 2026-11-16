'use strict';
// The Norns gate in runners/blackboard.js (Trial 0 charter, build list items 2 and 5).
// Every note below is a TEST FIXTURE, made up for these tests only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { board } = require('../runners/blackboard.js');
const { simClock } = require('../runners/norns/clock.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'norns-gate-'));
const RUN = 'sim-test-1';
function sim(start = '2031-03-03T08:00:00Z') {
  const dir = tmp(), file = path.join(dir, 'sim.db'), clk = simClock(start);
  const loom = board(null, file, { clock: clk, run: RUN, loom: true });
  const bb = board(null, file, { clock: clk, run: RUN });
  return { dir, file, clk, loom, bb, done() { loom.close(); bb.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('gate: a future note is hidden one minute before its time and visible at it', () => {
  const s = sim();
  s.loom.post({ topic: 'shop.roads', author: 'test', value: 'TEST FIXTURE future', at: '2031-03-07T08:00:00Z' });
  s.clk.set('2031-03-07T07:59:00Z');
  assert.strictEqual(s.bb.read('shop.roads'), null);
  assert.strictEqual(s.bb.query({}).length, 0);
  assert.strictEqual(s.bb.history('shop.roads').length, 0);
  assert.strictEqual(s.bb.topics().length, 0);
  assert.strictEqual(s.bb.value('shop.roads', 'none'), 'none');
  s.clk.set('2031-03-07T08:00:00Z');
  assert.strictEqual(s.bb.read('shop.roads').value, 'TEST FIXTURE future');
  assert.strictEqual(s.bb.query({}).length, 1);
  assert.strictEqual(s.bb.topics().length, 1);
  s.done();
});

test("gate: another run's note is always hidden, even when its time has passed", () => {
  const s = sim();
  const other = board(null, s.file, { clock: s.clk, run: 'sim-test-2', loom: true });
  other.post({ topic: 'shop.visitors', author: 'test', value: 'TEST FIXTURE stranger', at: '2031-03-03T07:00:00Z' });
  other.close();
  for (const t of ['2031-03-03T08:00:00Z', '2031-03-09T18:00:00Z', '2099-01-01T00:00:00Z']) {
    s.clk.set(t);
    assert.strictEqual(s.bb.read('shop.visitors'), null);
    assert.strictEqual(s.bb.query({ includeSuperseded: true, includeRetractions: true, includeExpired: true }).length, 0);
    assert.strictEqual(s.bb.history('shop.visitors').length, 0);
    assert.strictEqual(s.bb.topics().length, 0);
  }
  s.done();
});

test("gate: the caller's own `now` is ignored, so nobody can peek ahead", () => {
  const s = sim();
  s.loom.post({ topic: 'shop.roads', author: 'test', value: 'TEST FIXTURE future', at: '2031-03-07T08:00:00Z' });
  assert.strictEqual(s.bb.read('shop.roads', { now: '2099-01-01T00:00:00Z' }), null);
  assert.strictEqual(s.bb.query({ now: '2099-01-01T00:00:00Z', until: '2099-01-01T00:00:00Z' }).length, 0);
  assert.strictEqual(s.bb.history('shop.roads', { now: '2099-01-01T00:00:00Z' }).length, 0);
  s.done();
});

test('gate: a correction stamped in the future does not hide today\'s note', () => {
  const s = sim();
  const a = s.loom.post({ topic: 'shop.stock', author: 'test', value: 'TEST FIXTURE 40', at: '2031-03-03T08:00:00Z' });
  s.loom.post({ topic: 'shop.stock', author: 'test', value: 'TEST FIXTURE 28', at: '2031-03-05T08:00:00Z', supersedes: a.id });
  s.clk.set('2031-03-04T08:00:00Z');
  assert.strictEqual(s.bb.read('shop.stock').value, 'TEST FIXTURE 40');
  assert.strictEqual(s.bb.query({ topic: 'shop.stock' }).length, 1);
  s.clk.set('2031-03-05T08:00:00Z');
  assert.strictEqual(s.bb.read('shop.stock').value, 'TEST FIXTURE 28');
  s.done();
});

test('gate: "latest" means latest in sim time, not the last row written', () => {
  const s = sim();
  s.loom.post({ topic: 'shop.stock', author: 'test', value: 'TEST FIXTURE later', at: '2031-03-04T08:00:00Z' });
  s.loom.post({ topic: 'shop.stock', author: 'test', value: 'TEST FIXTURE earlier', at: '2031-03-03T08:00:00Z' });
  s.clk.set('2031-03-03T09:00:00Z');
  assert.strictEqual(s.bb.read('shop.stock').value, 'TEST FIXTURE earlier');
  s.clk.set('2031-03-04T09:00:00Z');
  assert.strictEqual(s.bb.read('shop.stock').value, 'TEST FIXTURE later');
  s.done();
});

test('gate: a plain (non-loom) handle stamps sim NOW and cannot choose its own time', () => {
  const s = sim();
  s.clk.set('2031-03-04T13:00:00Z');
  const r = s.bb.post({ topic: 'shop.log', author: 'test', value: 'TEST FIXTURE' });
  assert.strictEqual(r.at, '2031-03-04T13:00:00Z');
  assert.throws(() => s.bb.post({ topic: 'shop.log', author: 'test', value: 'x', at: '2031-03-09T08:00:00Z' }), /loom/);
  const row = new DatabaseSync(s.file, { readOnly: true }).prepare('SELECT run, at FROM notes WHERE id = ?').get(r.id);
  assert.deepStrictEqual({ ...row }, { run: RUN, at: '2031-03-04T13:00:00Z' });
  s.done();
});

test('gate: cannot supersede, cite or retract a note this run cannot see yet', () => {
  const s = sim();
  const f = s.loom.post({ topic: 'shop.roads', author: 'test', value: 'TEST FIXTURE', at: '2031-03-07T08:00:00Z' });
  assert.throws(() => s.bb.post({ topic: 'shop.roads', author: 'test', value: 'x', supersedes: f.id }), /does not exist/);
  assert.throws(() => s.bb.post({ topic: 'shop.log', author: 'test', value: 'x', based_on: [f.id] }), /does not exist/);
  assert.throws(() => s.bb.retract(f.id, { author: 'test' }), /no note/);
  assert.deepStrictEqual(s.bb.suspect(f.id), []);
  s.done();
});

test('gate: refuses the live file, a LIVE run tag, a missing clock and a bad clock reading', () => {
  const dir = tmp(), clk = simClock('2031-03-03T08:00:00Z');
  assert.throws(() => board(null, path.join(dir, 'blackboard.db'), { clock: clk, run: RUN }), /live blackboard/);
  assert.throws(() => board(null, undefined, { clock: clk, run: RUN }), /own file/);
  assert.throws(() => board(null, path.join(dir, 's.db'), { clock: clk, run: 'LIVE' }), /SIM run/);
  assert.throws(() => board(null, path.join(dir, 's.db'), { run: RUN }), /clock/);
  assert.throws(() => board(null, path.join(dir, 's.db'), {}), /clock/);          // a half-made option fails closed
  const bad = board(null, path.join(dir, 's2.db'), { clock: { now: () => 'tuesday' }, run: RUN });
  assert.throws(() => bad.read('a.b'), /YYYY-MM-DD/);
  bad.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live board unchanged with no options: same answers, no run column added', () => {
  const dir = tmp(), file = path.join(dir, 'blackboard.db');
  const bb = board(null, file);
  const a = bb.post({ topic: 'skald.mood', author: 'test', value: 'TEST FIXTURE calm' });
  bb.post({ topic: 'skald.mood', author: 'test', value: 'TEST FIXTURE calmer', supersedes: a.id });
  assert.strictEqual(bb.read('skald.mood').value, 'TEST FIXTURE calmer');
  assert.strictEqual(bb.history('skald.mood').length, 2);
  assert.strictEqual(bb.query({ prefix: 'skald' }).length, 1);
  assert.strictEqual(bb.gated, undefined);
  bb.close();
  const cols = new DatabaseSync(file, { readOnly: true }).prepare('PRAGMA table_info(notes)').all().map(c => c.name);
  assert.ok(!cols.includes('run'), 'the live board must not gain a run column');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sim clock never runs backwards', () => {
  const clk = simClock('2031-03-03T08:00:00Z');
  clk.set('2031-03-03T13:00:00Z');
  assert.throws(() => clk.set('2031-03-03T08:00:00Z'), /backwards/);
  assert.throws(() => clk.set('March 3'), /sim time/);
  assert.strictEqual(clk.now(), '2031-03-03T13:00:00Z');
});
