'use strict';
// The Attempt Register (law 9). The tests that matter: the count is
// trustworthy, the file is append-only, and an unknown turns the denominator
// into an admitted FLOOR instead of a confident number.

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const A = require('../runners/attempts.js');

let seq = 0;
const tmpRoot = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), `attempts-${process.pid}-${seq++}-`));

const idea = (id, extra) =>
  Object.assign({ id, what: `idea ${id}`, station: 'cavalier' }, extra || {});

test('an empty register counts nothing and does not crash', () => {
  const s = A.summary(tmpRoot());
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.is_floor, false);
});

test('an attempt goes in and comes back out', () => {
  const root = tmpRoot();
  assert.strictEqual(A.record(root, idea('a', { outcome: 'KILL', dated: '2026-11-09' })).recorded, true);
  const all = A.read(root);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].outcome, 'KILL');
  assert.ok(all[0].at, 'every attempt is dated when recorded');
  assert.strictEqual(all[0].kind, 'tested_idea', 'the default kind');
});

test('the same attempt cannot be counted twice', () => {
  const root = tmpRoot();
  A.record(root, idea('a'));
  const again = A.record(root, idea('a'));
  assert.strictEqual(again.recorded, false);
  assert.match(again.reason, /already recorded/);
  assert.strictEqual(A.read(root).length, 1, 'the denominator is only worth something if it is exact');
});

test('an attempt with no id or no what is refused', () => {
  const root = tmpRoot();
  assert.match(A.record(root, { what: 'nameless' }).reason, /needs an id/);
  assert.match(A.record(root, { id: 'x' }).reason, /needs a `what`/);
  assert.strictEqual(A.read(root).length, 0);
});

test('an unrecognised kind is refused and told the options', () => {
  const r = A.record(tmpRoot(), idea('a', { kind: 'vibes' }));
  assert.strictEqual(r.recorded, false);
  assert.match(r.reason, /vibes/);
  assert.match(r.reason, /abandoned/);
});

test('the register is append-only: an earlier line is never rewritten', () => {
  const root = tmpRoot();
  A.record(root, idea('first', { outcome: 'KILL' }));
  const after1 = fs.readFileSync(A.file(root), 'utf8');
  A.record(root, idea('second', { outcome: 'PASS' }));
  const after2 = fs.readFileSync(A.file(root), 'utf8');
  assert.ok(after2.startsWith(after1), 'law 14: logs are append-only');
});

test('an unreadable line is reported, not fatal', () => {
  const root = tmpRoot();
  A.record(root, idea('good'));
  fs.appendFileSync(A.file(root), 'this is not json\n');
  const all = A.read(root);
  assert.strictEqual(all.length, 2);
  assert.ok(all.some(e => e.broken), 'the bad line is named rather than swallowed');
  assert.strictEqual(A.summary(root).total, 1, 'and it is not counted');
});

test('the multiplicity math: more attempts, higher bar', () => {
  assert.strictEqual(A.honestThreshold(1), 0.05);
  assert.strictEqual(A.honestThreshold(10), 0.005);
  assert.ok(Math.abs(A.honestThreshold(144) - 0.05 / 144) < 1e-12);
  // The number that makes the point: 144 attempts at p<0.05 is about 7 passes
  // from luck alone, which is why the denominator is not optional.
  assert.ok(Math.abs(A.expectedFalsePasses(144) - 7.2) < 1e-9);
  assert.strictEqual(A.honestThreshold(0), 0.05, 'no attempts yet is not a division by zero');
});

test('an unknown is not counted, but it turns the total into an admitted FLOOR', () => {
  const root = tmpRoot();
  A.record(root, idea('a', { outcome: 'KILL' }));
  A.record(root, idea('b', { outcome: 'RUNNING' }));
  let s = A.summary(root);
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.is_floor, false);

  A.record(root, { id: 'u', kind: 'unknown', what: 'exploration nobody logged', span: ['2026-04', '2026-11'] });
  s = A.summary(root);
  assert.strictEqual(s.total, 2, 'an unknown is not a number, so it is not counted as one');
  assert.strictEqual(s.is_floor, true);
  assert.strictEqual(s.unrecorded.length, 1);
  assert.deepStrictEqual(s.unrecorded[0].span, ['2026-04', '2026-11']);
});

test('the summary line tells you what the denominator does to a p-value', () => {
  const root = tmpRoot();
  for (let i = 0; i < 20; i++) A.record(root, idea(`i${i}`, { outcome: 'KILL' }));
  const line = A.summaryLine(A.summary(root));
  assert.match(line, /20 formal attempt/);
  assert.match(line, /20 decided \(0 PASS, 20 KILL\)/);
  assert.match(line, /1\.00 pass/, 'twenty attempts at p<0.05 is one false pass expected');
  assert.match(line, /p<0\.00250/);
  assert.doesNotMatch(line, /FLOOR/, 'no unknown recorded, so no floor caveat');
});

test('the floor caveat appears the moment an unknown exists', () => {
  const root = tmpRoot();
  A.record(root, idea('a', { outcome: 'KILL' }));
  A.record(root, { id: 'u', kind: 'unknown', what: 'never logged' });
  assert.match(A.summaryLine(A.summary(root)), /FLOOR ONLY/);
});

test('passes and kills are counted separately from running', () => {
  const root = tmpRoot();
  A.record(root, idea('p', { outcome: 'PASS' }));
  A.record(root, idea('k', { outcome: 'KILL' }));
  A.record(root, idea('r', { outcome: 'RUNNING' }));
  const s = A.summary(root);
  assert.strictEqual(s.decided, 2, 'a running test has not been decided');
  assert.strictEqual(s.passes, 1);
  assert.strictEqual(s.kills, 1);
  assert.strictEqual(s.running, 1);
});

// ── `build`: on the record, outside the denominator (2026-11-11) ─────────

test('a build decision is recorded but never counted in the denominator', () => {
  const root = tmpRoot();
  A.record(root, idea('a', { outcome: 'KILL' }));
  A.record(root, idea('b', { outcome: 'RUNNING' }));
  A.record(root, { id: 'B1', kind: 'build', what: 'adopted an outside design', outcome: 'ADOPTED' });
  const s = A.summary(root);
  assert.strictEqual(s.total, 2, 'architecture is not an attempt at an edge');
  assert.strictEqual(s.builds, 1, 'but it is on the record');
  assert.strictEqual(A.read(root).length, 3, 'all three lines are in the file');
  assert.strictEqual(s.honest_threshold, 0.05 / 2,
    'the p-bar for the theses must not move because a part was renamed');
});

test('a build does not turn the register into a floor', () => {
  const root = tmpRoot();
  A.record(root, idea('a', { outcome: 'KILL' }));
  A.record(root, { id: 'B1', kind: 'build', what: 'a decision' });
  const s = A.summary(root);
  assert.strictEqual(s.is_floor, false, 'a build is written down, so nothing is missing');
  assert.strictEqual(s.unrecorded.length, 0);
});

test('a build carrying an outcome is not counted as decided', () => {
  const root = tmpRoot();
  A.record(root, idea('a', { outcome: 'KILL' }));
  A.record(root, { id: 'B1', kind: 'build', what: 'retired a post', outcome: 'KILL' });
  const s = A.summary(root);
  assert.strictEqual(s.total, 1);
  assert.strictEqual(s.decided, 1, 'out of the denominator means out of the numerator too');
  assert.strictEqual(s.kills, 1);
});

test('the court is told about builds separately, in words that cannot be misread', () => {
  const root = tmpRoot();
  A.record(root, idea('a', { outcome: 'KILL' }));
  A.record(root, { id: 'B1', kind: 'build', what: 'a decision' });
  const line = A.summaryLine(A.summary(root));
  assert.match(line, /1 formal attempt/);
  assert.match(line, /1 build decision/);
  assert.match(line, /outside the denominator/);
});

// ── The real register ────────────────────────────────────────────────────
test('the live register admits it is a floor', () => {
  const s = A.summary(path.join(__dirname, '..'));
  assert.ok(s.total > 0, 'the register has been seeded');
  assert.strictEqual(s.is_floor, true,
    'the pre-register exploration was never logged, and the register must say so '
    + 'rather than present its count as complete');
  assert.ok(s.unrecorded.some(u => /144/.test(u.what)),
    'the 144 figure is recorded as spoken-of-but-unevidenced, not entered as fact');
});

test('the live register holds the two corrections logged 2026-11-11', () => {
  const root = path.join(__dirname, '..');
  const all = A.read(root);
  const forseti = all.find(e => e.id === 'BUILD-2026-11-01-critic-to-forseti');
  const protocol = all.find(e => e.id === 'BUILD-2026-11-01-protocol-retired');

  assert.ok(forseti, 'the Critic came from an outside design and was renamed, not dropped');
  assert.strictEqual(forseti.kind, 'build');
  assert.strictEqual(forseti.outcome, 'ADOPTED');
  assert.match(forseti.correction, /renamed/i, 'and the mis-reading is recorded with the fact');

  assert.ok(protocol, 'a post that was never used is still part of the record');
  assert.strictEqual(protocol.outcome, 'RETIRED');
  assert.match(protocol.correction, /0 calls EVER|never sat in/i);

  // The whole reason these are `build` and not `tested_idea`.
  const s = A.summary(root);
  assert.strictEqual(s.builds, 2);
  assert.ok(!/BUILD-/.test(JSON.stringify(s.by_station)),
    'a build never reaches the per-station attempt counts');
});
