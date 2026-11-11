'use strict';
// AMENDMENT 1 to INTERCOM.md, initialed by Opie 2026-11-11.
// One rule, one test. A rule in the amendment with no test here is a hope, not a limit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { intercom, specCheck, ROSTER } = require('../runners/intercom.js');

const SKALD = 'ministry-of-skald', CHAN = 'imperial-chancellor';
const CAV = 'cavalier', ECN = 'ecnalanif', RAV = 'ravens-league';

function fresh(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic1-'));
  const clock = { t: new Date('2026-11-11T23:00:00Z') };
  const ic = intercom(null, path.join(dir, 'intercom.db'),
    { now: () => new Date(clock.t), amended: true, ...opts });
  ic.tick = min => { clock.t = new Date(clock.t.getTime() + min * 60000); };
  return ic;
}
const done = (from, to) => ({ from, parts: [{ to, code: 'DONE' }] });

// -- §8 item 6: the amendment gate -------------------------------------------
test('the live spec is signed and Amendment 1 is initialed', () => {
  const s = specCheck(path.join(__dirname, '..'));
  assert.deepStrictEqual([s.ok, s.who, s.hash, s.amended], [true, 'Opie', '42a848a0333f8b5f', true]);
});

test('uninitialed means the signed behaviour runs, not the amended one', () => {
  const plain = fresh({ amended: false });
  assert.strictEqual(plain.amended, false);
  // Under the signed spec nobody had declared ears, so a ministry could still be addressed.
  assert.ok(plain.send(done(SKALD, `agent:${CHAN}`)).ok);
  const amd = fresh();
  assert.strictEqual(amd.amended, true);
  assert.match(amd.send(done(SKALD, `agent:${CHAN}`)).why, /has no voice yet/);
});

// -- §3: declared voice and ears ---------------------------------------------
test('the roster matches the amendment table', () => {
  assert.deepStrictEqual(ROSTER.emperor, { voice: true, ears: true, free: true });
  for (const a of [CAV, ECN, RAV, 'evidence', 'backup'])
    assert.deepStrictEqual(ROSTER[a], { voice: true, ears: true }, a);
  assert.deepStrictEqual(ROSTER.supervisor, { voice: false, ears: true }, 'watches, does not speak');
  for (const a of ['attempts', 'panel', 'testcard'])
    assert.deepStrictEqual(ROSTER[a], { voice: false, ears: false }, a);
  for (const a of [CHAN, SKALD, 'ministry-of-treasury', 'ministry-of-works',
                   'ministry-of-intelligence', 'ministry-of-engineering'])
    assert.deepStrictEqual(ROSTER[a], { voice: false, ears: false }, `${a} waits for step 2`);
});

test('an earless address is refused at send, by name, and counted', () => {
  const ic = fresh();
  assert.strictEqual(ic.send(done(CAV, 'agent:panel')).why, 'part 1: panel has no ears yet');
  assert.match(ic.send(done(CAV, `agent:${SKALD}`)).why, /ministry-of-skald has no ears yet/);
  assert.strictEqual(ic.report().watch.refused_no_ears, 2);
});

test('a mute agent cannot speak, and that is a different refusal', () => {
  const ic = fresh();
  assert.match(ic.send(done('supervisor', `agent:${CAV}`)).why, /supervisor has no voice yet/);
  assert.strictEqual(ic.report().watch.refused_no_voice, 1);
});

test('an area goes to the members with ears, and is refused only if none have any', () => {
  const ic = fresh();
  // prices = treasury (deaf for now), cavalier, ecnalanif, ravens-league
  const r = ic.send({ from: CAV, parts: [{ to: 'area:prices', code: 'STALE', cite: 'note:1' }] });
  assert.ok(r.ok);
  assert.deepStrictEqual([ic.pending(ECN).length, ic.pending(RAV).length], [1, 1]);
  assert.strictEqual(ic.pending('ministry-of-treasury').length, 0, 'no ears, so not a recipient');
  // measurement = attempts + panel, both earless
  assert.match(ic.send(done(CAV, 'area:measurement')).why, /nobody in area measurement has ears yet/);
});

// -- §4: the Emperor's voice --------------------------------------------------
test('the Emperor speaks to any agent, free, and is never held', () => {
  const ic = fresh({ budgetOk: () => false });            // budget spent: everyone else is refused
  assert.strictEqual(ic.send(done(CAV, `agent:${ECN}`)).why, 'daily budget spent');
  for (let i = 0; i < 40; i++) {
    const r = ic.send({ from: 'emperor', parts: [{ to: `agent:${CAV}`, code: 'ASK', line: `status ${i}?` }] });
    assert.ok(r.ok && !r.held, `emperor message ${i}`);
    assert.deepStrictEqual([r.stamps, r.draws], [0, 0], 'the Emperor pays no postage');
  }
  assert.strictEqual(ic.pending(CAV).length, 40);
  assert.strictEqual(ic.report().held.length, 0);
});

test('even the Emperor is told when an agent has no ears, rather than speaking into a void', () => {
  const ic = fresh();
  assert.match(ic.send({ from: 'emperor', parts: [{ to: 'agent:panel', code: 'ASK', line: 'well?' }] }).why,
    /panel has no ears yet/);
});

// -- §1: handed and acknowledged ---------------------------------------------
test('handed is the carrier\'s act; acknowledged is the agent\'s own', () => {
  const ic = fresh();
  const r = ic.send(done(CAV, `agent:${ECN}`));
  assert.strictEqual(ic.events('handed').length, 0, 'logged is not handed');
  ic.hand(ECN, r.parts[0]);
  assert.strictEqual(ic.events('handed').length, 1);
  assert.strictEqual(ic.events('acknowledged').length, 0, 'handed is not acknowledged');
  assert.deepStrictEqual(ic.acknowledge(ECN, r.parts[0]), { ok: true, marked: [r.parts[0]], ignored: [] });
  assert.strictEqual(ic.events('acknowledged').length, 1);
});

test('law 5 on receipts: an acknowledgement for something never handed over is refused', () => {
  const ic = fresh();
  const r = ic.send(done(CAV, `agent:${ECN}`));
  const out = ic.acknowledge(RAV, r.parts[0]);
  assert.deepStrictEqual([out.marked, out.ignored], [[], [r.parts[0]]]);
  assert.strictEqual(ic.events('acknowledged').length, 0);
  assert.ok(ic.events('refused').some(e => /never handed/.test(e.detail)));
});

test('repeating a SEEN mark is harmless, not Bad', () => {
  const ic = fresh();
  const r = ic.send(done(CAV, `agent:${ECN}`));
  ic.hand(ECN, r.parts[0]);
  ic.acknowledge(ECN, r.parts[0]);
  const again = ic.acknowledge(ECN, r.parts[0]);
  assert.deepStrictEqual([again.marked, again.ignored], [[], [r.parts[0]]]);
  assert.strictEqual(ic.report().bad.length, 0);
});

test('the carrier never branches on content: delivery code touches no content field', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'runners', 'intercom.js'), 'utf8');
  const body = src.slice(src.indexOf('function hand('), src.indexOf('function acknowledge('));
  for (const field of ['.line', '.number', '.topic', '.cite'])
    assert.ok(!body.includes(`p${field}`), `hand() must not read p${field}`);
  assert.ok(body.includes('sealOf(p)') && body.includes('recipients(p)'),
    'it does check the seal and the address');
});

// -- §1-2: unheard, with its cause -------------------------------------------
test('unheard tells a silence that was never handed from one that was never answered', () => {
  const ic = fresh({ ranToday: () => true });
  const a = ic.send(done(CAV, `agent:${ECN}`));
  const b = ic.send(done(CAV, `agent:${RAV}`));
  ic.hand(ECN, a.parts[0]);                       // handed, never acknowledged
  const u = ic.unheard();
  assert.deepStrictEqual(u.unacknowledged.map(x => [x.agent, x.cause]),
    [[ECN, 'handed, no mark came back']]);
  assert.deepStrictEqual(u.unhanded.map(x => [x.agent, x.cause]),
    [[RAV, 'ran, nothing handed']]);
  ic.acknowledge(ECN, a.parts[0]);
  assert.strictEqual(ic.unheard().unacknowledged.length, 0);
  assert.strictEqual(b.parts.length, 1);
});

test('the five causes are named, not guessed', () => {
  const seen = {};
  // did not run
  let ic = fresh({ ranToday: () => false });
  ic.send(done(CAV, `agent:${ECN}`));
  seen.didNotRun = ic.unheard().unhanded[0].cause;
  // no run record at all
  ic = fresh();
  ic.send(done(CAV, `agent:${ECN}`));
  seen.unknown = ic.unheard().unhanded[0].cause;
  // condition unmet: held
  ic = fresh({ config: { base: 0, reserve: 0 } });
  ic.send(done(CAV, `agent:${ECN}`));
  seen.held = ic.unheard().unhanded[0].cause;
  // condition unmet: sealed
  ic = fresh();
  ic.send({ from: CAV, parts: [{ to: `agent:${ECN}`, level: 'sealed', until: 'verdict.x', code: 'DONE' }] });
  seen.sealed = ic.unheard().unhanded[0].cause;
  // Bad
  ic = fresh({ ranToday: () => true });
  const r = ic.send(done(CAV, `agent:${ECN}`));
  ic.hand(RAV, r.parts[0]);                        // wrong party spoils it
  seen.bad = ic.unheard().unhanded[0].cause;
  assert.deepStrictEqual(seen, {
    didNotRun: 'did not run',
    unknown: 'unknown: no run record for this agent',
    held: 'condition unmet: the message is held',
    sealed: 'condition unmet: still sealed',
    bad: 'Bad: a wrong-party hand spoiled it',
  });
});

test("the Emperor's report carries the silence and the counts", () => {
  const ic = fresh({ ranToday: () => true });
  const r = ic.send(done(CAV, `agent:${ECN}`));
  ic.hand(ECN, r.parts[0]);
  ic.send(done(CAV, `agent:${RAV}`));
  const rep = ic.report();
  assert.strictEqual(rep.amended, true);
  assert.deepStrictEqual([rep.handed, rep.acknowledged], [1, 0]);
  assert.strictEqual(rep.unacknowledged.length, 1);
  assert.strictEqual(rep.unhanded.length, 1);
});

// -- §7: deadlines in turns --------------------------------------------------
test('a turn call survives the clock and dies when the run ends', () => {
  const ic = fresh();
  const q = ic.send({ from: CAV, dueNextRun: true,
    parts: [{ to: `agent:${ECN}`, code: 'ASK', line: 'is kp frozen?' }] });
  assert.strictEqual(q.mode, 'turn');
  ic.tick(60 * 3);                                  // three hours: a clock deadline would be long gone
  assert.ok(ic.send({ from: ECN, call: q.call, parts: [{ code: 'ANSWER', number: 3 }] }).ok,
    'still answerable, because the asked agent has not run yet');

  const q2 = ic.send({ from: CAV, dueNextRun: true,
    parts: [{ to: `agent:${ECN}`, code: 'ASK', line: 'and today?' }] });
  assert.match(ic.runEnded(ECN, ECN).why, /only the Warden/);
  assert.deepStrictEqual(ic.runEnded(ECN, 'warden'), { ok: true, rung: 1 });
  assert.strictEqual(ic.send({ from: ECN, call: q2.call, parts: [{ code: 'ANSWER', number: 4 }] }).why,
    'deadline passed');
  assert.deepStrictEqual(ic.runEnded(ECN, 'warden'), { ok: true, rung: 0 }, 'the bell rings once');
});

test('the 26-hour backstop ends a turn call that nobody ever closes', () => {
  const ic = fresh();
  const q = ic.send({ from: CAV, dueNextRun: true,
    parts: [{ to: `agent:${ECN}`, code: 'ASK', line: 'still there?' }] });
  ic.tick(60 * 27);
  assert.strictEqual(ic.send({ from: ECN, call: q.call, parts: [{ code: 'ANSWER', number: 1 }] }).why,
    'deadline passed');
});

test('a clock call is still a clock call when nobody asks for turns', () => {
  const ic = fresh();
  const q = ic.send({ from: CAV, deadlineMin: 2,
    parts: [{ to: `agent:${ECN}`, code: 'ASK', line: 'quick one?' }] });
  assert.strictEqual(q.mode, 'clock');
  ic.tick(3);
  assert.strictEqual(ic.send({ from: ECN, call: q.call, parts: [{ code: 'ANSWER', number: 1 }] }).why,
    'deadline passed');
});

test('dueNextRun is ignored while the amendment is only a proposal', () => {
  const ic = fresh({ amended: false });
  const q = ic.send({ from: CAV, dueNextRun: true,
    parts: [{ to: `agent:${ECN}`, code: 'ASK', line: 'turns?' }] });
  assert.strictEqual(q.mode, 'clock');
});

test('turn-mode blind answers unseal when every asked agent has answered or had its bell', () => {
  const ic = fresh();
  const q = ic.send({ from: CAV, dueNextRun: true,
    parts: [{ to: 'area:prices', code: 'ASK', line: 'is spy.close stale?' }] });
  assert.ok(ic.send({ from: ECN, call: q.call, parts: [{ code: 'ANSWER', number: 1 }] }).ok);
  assert.strictEqual(ic.pending(CAV).length, 0, 'sealed until the rest are in');
  ic.runEnded(RAV, 'warden');                       // the other asked agent ran without answering
  assert.strictEqual(ic.collect(CAV).length, 1, 'the one real answer is released');
});

// -- the module still refuses to rewrite history -----------------------------
test('append-only: the module never rewrites or removes a row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'runners', 'intercom.js'), 'utf8');
  const sql = src.replace(/ALTER TABLE calls ADD COLUMN[^;]*/g, '');   // one additive migration
  assert.ok(!/\b(UPDATE|DELETE|DROP)\b/.test(sql));
});
