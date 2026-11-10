'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { board } = require('../runners/blackboard.js');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  return board(null, path.join(dir, 'blackboard.db'));
}

test('a note goes on and comes back off', () => {
  const bb = fresh();
  const { id } = bb.post({ topic: 'skald.stock_mood', author: 'skald', value: 32, as_of: '2026-11-09' });
  assert.ok(id > 0);
  const n = bb.read('skald.stock_mood');
  assert.strictEqual(n.value, 32);
  assert.strictEqual(n.as_of, '2026-11-09');
  assert.strictEqual(n.author, 'skald');
  assert.strictEqual(bb.value('skald.stock_mood'), 32);
  assert.strictEqual(bb.value('nobody.said.anything', 'fallback'), 'fallback');
});

test('structured values survive the round trip', () => {
  const bb = fresh();
  const v = { exposure: 0.75, thermometers: { wiki: true, skald: false, vix: null }, changes: [1, 2] };
  bb.post({ topic: 'cavalier.state', author: 'cavalier', value: v });
  assert.deepStrictEqual(bb.read('cavalier.state').value, v);
});

test('nothing is ever overwritten: a correction supersedes', () => {
  const bb = fresh();
  const first = bb.post({ topic: 'market.spy.close', author: 'treasury', value: 752.00, as_of: '2026-11-09' });
  bb.post({ topic: 'market.spy.close', author: 'treasury', value: 752.69, as_of: '2026-11-09',
            supersedes: first.id, source: 'corrected feed' });
  assert.strictEqual(bb.read('market.spy.close').value, 752.69);
  const h = bb.history('market.spy.close');
  assert.strictEqual(h.length, 2);                       // the old belief is still on the record
  assert.strictEqual(h[0].value, 752.00);
});

test('a retraction hides the note but deletes nothing', () => {
  const bb = fresh();
  const { id } = bb.post({ topic: 'ravens.rumour', author: 'ravens', value: 'the sky is falling' });
  bb.retract(id, { author: 'opie', reason: 'bad source' });
  assert.strictEqual(bb.read('ravens.rumour'), null);
  const h = bb.history('ravens.rumour');
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[1].kind, 'retraction');
  assert.strictEqual(h[1].reason, 'bad source');
});

test('expiry makes a note stop speaking without removing it', () => {
  const bb = fresh();
  bb.post({ topic: 'weather.today', author: 'weatherwise', value: 'rain', expires: '2026-11-09T00:00:00Z' });
  assert.strictEqual(bb.read('weather.today', { now: '2026-11-08T00:00:00Z' }).value, 'rain');
  assert.strictEqual(bb.read('weather.today', { now: '2026-11-10T00:00:00Z' }), null);
  assert.strictEqual(bb.query({ topic: 'weather.today', includeExpired: true, now: '2026-11-10T00:00:00Z' }).length, 1);
});

test('a prefix reads a whole branch, and a branch never leaks into its neighbour', () => {
  const bb = fresh();
  bb.post({ topic: 'cavalier', author: 'a', value: 1 });
  bb.post({ topic: 'cavalier.exposure', author: 'a', value: 2 });
  bb.post({ topic: 'cavalier.thermometers.vix', author: 'a', value: 3 });
  bb.post({ topic: 'cavalierish.other', author: 'b', value: 4 });   // must NOT match
  const got = bb.query({ prefix: 'cavalier' }).map(n => n.value).sort();
  assert.deepStrictEqual(got, [1, 2, 3]);
});

test('malformed notes are refused loudly', () => {
  const bb = fresh();
  assert.throws(() => bb.post({ topic: 'Bad Topic', author: 'a', value: 1 }), /dotted lowercase/);
  assert.throws(() => bb.post({ topic: 'ok.topic', value: 1 }), /needs an author/);
  assert.throws(() => bb.post({ topic: 'ok.topic', author: 'a' }), /value is required/);
  assert.throws(() => bb.post({ topic: 'ok.topic', author: 'a', value: 1, confidence: 2 }), /between 0 and 1/);
  assert.throws(() => bb.post({ topic: 'ok.topic', author: 'a', value: 1, supersedes: 999 }), /does not exist/);
  assert.throws(() => bb.retract(999, { author: 'a' }), /no note 999/);
  bb.post({ topic: 'ok.topic', author: 'a', value: null });         // null means "looked, knew nothing"
  assert.strictEqual(bb.read('ok.topic').value, null);
});

test('at and as_of are different things and both survive', () => {
  const bb = fresh();
  const { at } = bb.post({ topic: 'vix.close', author: 'cavalier', value: 25.64, as_of: '2026-11-06' });
  const n = bb.read('vix.close');
  assert.strictEqual(n.as_of, '2026-11-06');             // the day the fact is about
  assert.strictEqual(n.at, at);                          // the day we learned it
  assert.notStrictEqual(n.as_of, n.at);
});

test('topics lists the floor', () => {
  const bb = fresh();
  bb.post({ topic: 'a.one', author: 'x', value: 1 });
  bb.post({ topic: 'a.one', author: 'x', value: 2 });
  bb.post({ topic: 'b.two', author: 'x', value: 3 });
  const t = bb.topics();
  assert.deepStrictEqual(t.map(r => [r.topic, r.n]), [['a.one', 2], ['b.two', 1]]);
  assert.deepStrictEqual(bb.topics('a').map(r => r.topic), ['a.one']);
});

test('if_changed keeps a nightly re-run from burying the history of real changes', () => {
  const bb = fresh();
  const a = bb.post({ topic: 'cavalier2.exposure', author: 'cavalier2', value: 0.75, as_of: '2026-11-09', if_changed: true });
  const b = bb.post({ topic: 'cavalier2.exposure', author: 'cavalier2', value: 0.75, as_of: '2026-11-09', if_changed: true });
  assert.strictEqual(b.id, a.id);
  assert.strictEqual(b.unchanged, true);
  assert.strictEqual(bb.history('cavalier2.exposure').length, 1);   // one row, not two
  // A real change is written; so is the same value on a different day, because that's a new observation.
  bb.post({ topic: 'cavalier2.exposure', author: 'cavalier2', value: 1.0, as_of: '2026-11-09', if_changed: true });
  bb.post({ topic: 'cavalier2.exposure', author: 'cavalier2', value: 1.0, as_of: '2026-11-10', if_changed: true });
  assert.strictEqual(bb.history('cavalier2.exposure').length, 3);
  assert.deepStrictEqual(bb.history('cavalier2.exposure').map(n => [n.value, n.as_of]),
    [[0.75, '2026-11-09'], [1.0, '2026-11-09'], [1.0, '2026-11-10']]);
  // Without the flag, every post is a new row — the default stays dumb and honest.
  bb.post({ topic: 'plain.topic', author: 'x', value: 1 });
  bb.post({ topic: 'plain.topic', author: 'x', value: 1 });
  assert.strictEqual(bb.history('plain.topic').length, 2);
});
