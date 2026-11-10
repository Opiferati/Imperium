'use strict';
// Lessons taken from Theraulaz & Bonabeau, "A Brief History of Stigmergy", Artificial Life 5(2), 1999.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { board } = require('../runners/blackboard.js');
const { makeSupervisor } = require('../runners/supervisor.js');

const fresh = () => board(null, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stig-')), 'blackboard.db'));
const quiet = { log() {}, warn() {} };

// ── Quantitative stigmergy: a trail fades, and a faded trail changes whether you act on it ──
test('freshness halves every half-life, and a reader can refuse a faded trace', () => {
  const bb = fresh();
  bb.post({ topic: 'skald.stock_mood', author: 'skald', value: 60, half_life_days: 1 });
  const n = bb.read('skald.stock_mood');
  assert.strictEqual(n.freshness, 1);                       // just written
  const inOneDay = new Date(Date.now() + 86_400_000).toISOString();
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
  assert.ok(Math.abs(bb.read('skald.stock_mood', { now: inOneDay }).freshness - 0.5) < 0.01);
  assert.ok(Math.abs(bb.read('skald.stock_mood', { now: inTwoDays }).freshness - 0.25) < 0.01);
  // The reader sets the bar, not the writer.
  assert.strictEqual(bb.read('skald.stock_mood', { now: inTwoDays, min_freshness: 0.5 }), null);
  assert.ok(bb.read('skald.stock_mood', { now: inTwoDays, min_freshness: 0.1 }));
  assert.ok(bb.read('skald.stock_mood', { now: inTwoDays }));      // no bar asked, no bar applied
});

test('a note with no half-life never fades, which is right for a fact about a fixed day', () => {
  const bb = fresh();
  bb.post({ topic: 'vix.close', author: 'cavalier', value: 19.92, as_of: '2026-11-09' });
  const far = new Date(Date.now() + 400 * 86_400_000).toISOString();
  const n = bb.read('vix.close', { now: far, min_freshness: 0.99 });
  assert.strictEqual(n.freshness, 1);                       // the VIX on 11-09 is still the VIX on 11-09
  assert.ok(n.age_hours > 9000);                            // but we can still see how old the note is
});

// ── The Paralastor lesson: a stray trace causes confident, competent, wasted work ──
test('suspect() names the downstream work a bad note tainted, transitively', () => {
  const bb = fresh();
  const bad = bb.post({ topic: 'skald.stock_mood', author: 'skald', value: 5 });
  const good = bb.post({ topic: 'vix.close', author: 'cavalier', value: 19.9 });
  const mid = bb.post({ topic: 'cavalier2.alarming', author: 'cavalier2', value: 2, based_on: [bad.id, good.id] });
  const far = bb.post({ topic: 'cavalier2.exposure', author: 'cavalier2', value: 0.5, based_on: [mid.id] });
  const clean = bb.post({ topic: 'ravens.league', author: 'ravens', value: 'fine', based_on: [good.id] });
  bb.retract(bad.id, { author: 'opie', reason: 'the Skald misread a satire site' });
  const tainted = bb.suspect(bad.id).map(n => n.id);
  assert.deepStrictEqual(tainted, [mid.id, far.id]);        // the whole funnel, not just the first brick
  assert.ok(!tainted.includes(clean.id));                   // work that never touched it is untouched
});

test('a citation must point at a note that exists', () => {
  const bb = fresh();
  assert.throws(() => bb.post({ topic: 'a.b', author: 'x', value: 1, based_on: [999] }), /cannot cite note 999/);
  assert.throws(() => bb.post({ topic: 'a.b', author: 'x', value: 1, based_on: 'nope' }), /must be an array/);
});

// ── Stigmergy applied to the machine itself: a trace read back by a later instance of the same agent ──
test('a disabled child stays disabled across a restart, because the trace outlives the process', async () => {
  const bb = fresh();
  const shim = { post: n => bb.post(n), query: f => bb.query(f) };
  const first = makeSupervisor({ log: quiet, board: shim });
  const policy = { backoff_s: [0], attempts: 1, max_failures: 1 };
  await first.supervise('weatherwise', async () => { throw new Error('dead source'); }, policy);
  assert.strictEqual(first.health('weatherwise').state, 'disabled');

  // The Warden restarts: a brand-new supervisor with no memory at all.
  const reborn = makeSupervisor({ log: quiet, board: shim });
  assert.strictEqual(reborn.health('weatherwise').state, 'unknown');   // before reading the floor
  assert.deepStrictEqual(reborn.rehydrate(), ['weatherwise']);
  assert.strictEqual(reborn.health('weatherwise').state, 'disabled');  // after reading the floor
  let ran = false;
  const r = await reborn.supervise('weatherwise', async () => { ran = true; }, policy);
  assert.strictEqual(ran, false);                                      // and it really refuses to run
  assert.strictEqual(r.state, 'disabled');
});

test('only the latch is rehydrated: a merely shaky child is forgiven by a restart', async () => {
  const bb = fresh();
  const shim = { post: n => bb.post(n), query: f => bb.query(f) };
  const first = makeSupervisor({ log: quiet, board: shim });
  await first.supervise('cavalier', async () => { throw new Error('blip'); },
                        { backoff_s: [0], attempts: 1, max_failures: 5 });
  assert.strictEqual(first.health('cavalier').state, 'shaky');
  const reborn = makeSupervisor({ log: quiet, board: shim });
  assert.deepStrictEqual(reborn.rehydrate(), []);
  assert.strictEqual(reborn.health('cavalier').state, 'unknown');
});

test('health traces carry no half-life: a safety latch must not fade into silence', () => {
  const bb = fresh();
  const shim = { post: n => bb.post(n), query: f => bb.query(f) };
  makeSupervisor({ log: quiet, board: shim });
  const sup = makeSupervisor({ log: quiet, board: shim });
  return sup.supervise('x', async () => { throw new Error('e'); }, { backoff_s: [0], attempts: 1, max_failures: 1 })
    .then(() => {
      const note = bb.read('supervisor.x.health');
      assert.strictEqual(note.half_life_days, null);
      const farFuture = new Date(Date.now() + 365 * 86_400_000).toISOString();
      assert.strictEqual(bb.read('supervisor.x.health', { now: farFuture, min_freshness: 0.99 }).value.state,
                         'disabled');                  // a year later it still says broken
    });
});

test('rehydrate is survivable when there is no board at all', () => {
  const sup = makeSupervisor({ log: quiet });
  assert.deepStrictEqual(sup.rehydrate(), []);
  const broken = makeSupervisor({ log: quiet, board: { post() {}, query() { throw new Error('gone'); } } });
  assert.deepStrictEqual(broken.rehydrate(), []);
});

test('if_changed notices a change in how to read the value, not only the value', () => {
  const bb = fresh();
  const a = bb.post({ topic: 'skald.stock_mood', author: 'skald', value: 60, as_of: '2026-11-09', if_changed: true });
  // Same number, but the producer now says it should fade: that is new information about the trace.
  const b = bb.post({ topic: 'skald.stock_mood', author: 'skald', value: 60, as_of: '2026-11-09',
                      half_life_days: 1.5, if_changed: true });
  assert.notStrictEqual(b.id, a.id);
  assert.strictEqual(bb.read('skald.stock_mood').half_life_days, 1.5);
  // And a change in confidence counts too — a thin reading is not the same claim as a clean one.
  const c = bb.post({ topic: 'skald.stock_mood', author: 'skald', value: 60, as_of: '2026-11-09',
                      half_life_days: 1.5, confidence: 0.5, if_changed: true });
  assert.notStrictEqual(c.id, b.id);
  // Truly identical, though, still writes nothing.
  const d = bb.post({ topic: 'skald.stock_mood', author: 'skald', value: 60, as_of: '2026-11-09',
                      half_life_days: 1.5, confidence: 0.5, if_changed: true });
  assert.strictEqual(d.unchanged, true);
  assert.strictEqual(bb.history('skald.stock_mood').length, 3);
});

test('freshness is sane on every path, not just read() — the .map(fn) arity trap', () => {
  const bb = fresh();
  bb.post({ topic: 'a.one', author: 'x', value: 1, half_life_days: 2 });
  bb.post({ topic: 'a.two', author: 'x', value: 2, half_life_days: 2 });
  bb.post({ topic: 'a.three', author: 'x', value: 3, half_life_days: 2 });
  for (const path of [bb.query({ prefix: 'a' }), bb.history('a.one'), bb.query({})])
    for (const n of path) {
      assert.ok(Number.isFinite(n.freshness), `freshness must be finite, got ${n.freshness}`);
      assert.ok(n.freshness > 0.99 && n.freshness <= 1, `a note just written must read as fresh, got ${n.freshness}`);
      assert.ok(Number.isFinite(n.age_hours) && n.age_hours >= 0);
    }
});
