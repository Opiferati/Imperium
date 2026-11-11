'use strict';
// Every hard limit in INTERCOM.md (signed 2026-11-10) gets a test here. If a rule in the
// spec has no test in this file, the rule is a hope and not a limit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { intercom, specCheck, DEFAULTS, AREAS, SIG_MARK } = require('../runners/intercom.js');

const SKALD = 'ministry-of-skald', CHAN = 'imperial-chancellor', TREAS = 'ministry-of-treasury';
const WORKS = 'ministry-of-works';

function fresh(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-'));
  const clock = { t: new Date('2026-11-10T23:00:00Z') };
  const ic = intercom(null, path.join(dir, 'intercom.db'), { now: () => new Date(clock.t), ...opts });
  ic.clock = clock;
  ic.tick = min => { clock.t = new Date(clock.t.getTime() + min * 60000); };
  return ic;
}
const done = (from, to, extra = {}) => ({ from, parts: [{ to, code: 'DONE', ...extra }] });

test('the signed defaults are the ones in the spec', () => {
  assert.deepStrictEqual(DEFAULTS, { base: 5, reserve: 25, drawCap: 10, alarmLimit: 3, lineMax: 200, deadlineMin: 10 });
  assert.deepStrictEqual(AREAS.prices, [TREAS, 'cavalier', 'ecnalanif', 'ravens-league']);
});

test('no author, no delivery; unknown senders are refused; every refusal is logged', () => {
  const ic = fresh();
  assert.strictEqual(ic.send({ parts: [{ to: 'all', code: 'DONE' }] }).why, 'no author');
  assert.match(ic.send(done('stranger', 'all')).why, /unknown sender/);
  assert.match(ic.send({ from: SKALD, parts: [] }).why, /at least one part/);
  assert.strictEqual(ic.events('refused').length, 3);
});

test('parts are cut per recipient, and nobody is told anything was withheld', () => {
  const ic = fresh();
  const r = ic.send({ from: SKALD, parts: [
    { to: 'area:prices', code: 'DONE', number: 42, topic: 'skald.stock_mood' },
    { to: `agent:${CHAN}`, code: 'THIN', topic: 'skald.headlines', untrusted: true },
    { to: 'area:court', code: 'DONE', number: 0.0575, topic: 'skald.cost' },
  ] });
  assert.ok(r.ok);
  assert.strictEqual(r.stamps, 3);
  const copy = ic.collect('cavalier');
  assert.strictEqual(copy.length, 1);
  assert.strictEqual(copy[0].number, 42);
  const text = JSON.stringify(copy);
  assert.ok(!/headlines|withheld|cost/.test(text), 'the cut copy must look complete');
  assert.strictEqual(ic.collect(CHAN).length, 2);          // his own part plus the court's
  assert.strictEqual(ic.collect(WORKS).length, 1);
});

test('only ASK and ANSWER carry a line, one line, within the limit', () => {
  const ic = fresh();
  assert.match(ic.send({ from: SKALD, parts: [{ to: 'all', code: 'STALE', line: 'let me explain' }] }).why, /no free text/);
  assert.match(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'ASK' }] }).why, /one-line question/);
  assert.match(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'ASK', line: 'x'.repeat(201) }] }).why, /limit is 200/);
  assert.match(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'ASK', line: 'a\nb' }] }).why, /single line/);
  assert.match(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'SHOUT' }] }).why, /unknown code/);
  assert.ok(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'ASK', line: 'x'.repeat(200) }] }).ok);
});

test('CONFIRM and DISAGREE must cite, and a citation cannot point at an agent-written file', () => {
  const ic = fresh();
  assert.match(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'DISAGREE' }] }).why, /needs a citation/);
  assert.match(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'CONFIRM', cite: 'file:/tmp/my-long-note.md' }] }).why, /citation/);
  assert.match(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'DONE', cite: 'output/skald/note.md' }] }).why, /citation/);
  assert.ok(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'CONFIRM', cite: 'note:12' }] }).ok);
  assert.ok(ic.send({ from: SKALD, parts: [{ to: `agent:${CHAN}`, code: 'DISAGREE', cite: 'evidence:data/skald-mood.csv' }] }).ok);
  assert.strictEqual(ic.report().watch.refused_citations, 3);
});

test('a broken seal is Bad: the part is not delivered and the Emperor is told', () => {
  const ic = fresh();
  const r = ic.send(done(SKALD, `agent:${CHAN}`, { number: 42 }));
  ic._db.prepare('UPDATE parts SET number = 99 WHERE id = ?').run(r.parts[0]);   // tampering, from outside
  const o = ic.open(CHAN, r.parts[0]);
  assert.strictEqual(o.ok, false);
  assert.strictEqual(o.bad, true);
  assert.match(o.why, /fingerprint/);
  assert.strictEqual(ic.pending(CHAN).length, 0);
  assert.match(ic.open(CHAN, r.parts[0]).why, /marked Bad/);
  assert.strictEqual(ic.report().bad.length, 1);
  assert.ok(ic.report().tells.some(t => /BAD/.test(t)));
});

test('the stamp is inside the seal: peeling Untrusted off breaks it', () => {
  const ic = fresh();
  const r = ic.send(done(SKALD, `agent:${CHAN}`, { untrusted: true }));
  ic._db.prepare('UPDATE parts SET untrusted = 0 WHERE id = ?').run(r.parts[0]);
  assert.strictEqual(ic.open(CHAN, r.parts[0]).bad, true);
});

test('opened by the wrong party is Bad', () => {
  const ic = fresh();
  const r = ic.send(done(SKALD, `agent:${CHAN}`));
  const o = ic.open('cavalier', r.parts[0]);
  assert.strictEqual(o.bad, true);
  assert.match(o.why, /wrong party/);
});

test('a part is opened once: seen again after opening is Bad', () => {
  const ic = fresh();
  const r = ic.send(done(SKALD, `agent:${CHAN}`));
  assert.ok(ic.open(CHAN, r.parts[0]).ok);
  const again = ic.open(CHAN, r.parts[0]);
  assert.strictEqual(again.bad, true);
  assert.match(again.why, /seen again/);
});

test('no forwarding: only the Warden cuts a fresh copy, and it keeps the original author', () => {
  const ic = fresh();
  const q = 'what is the frozen close for 2026-11-10?';
  const r = ic.send({ from: 'cavalier', parts: [{ to: 'agent:ecnalanif', code: 'ASK', line: q }] });
  ic.collect('ecnalanif');
  const fwd = ic.send({ from: 'ecnalanif', parts: [{ to: 'agent:ravens-league', code: 'ASK', line: q }] });
  assert.match(fwd.why, /forwarding is not allowed/);
  assert.match(ic.recopy(r.parts[0], 'ravens-league', 'ecnalanif').why, /only the Warden/);
  assert.ok(ic.recopy(r.parts[0], 'ravens-league', 'warden').ok);
  const got = ic.collect('ravens-league');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].from, 'cavalier');
  assert.strictEqual(got[0].line, q);
  assert.strictEqual(ic.report().watch.refused_forwarding, 1);
});

test('the stamp follows the reader, for the rest of that task only', () => {
  const ic = fresh();
  ic.send(done(SKALD, `agent:${CHAN}`, { untrusted: true }));
  const got = ic.collect(CHAN, { task: 'T1' });
  assert.strictEqual(got[0].untrusted, true);
  assert.strictEqual(got[0].instruction, false);
  ic.send({ from: CHAN, task: 'T1', parts: [{ to: `agent:${WORKS}`, code: 'DONE' }] });
  assert.strictEqual(ic.collect(WORKS)[0].untrusted, true, 'same task: stamped whatever the wording');
  ic.send({ from: CHAN, task: 'T2', parts: [{ to: `agent:${WORKS}`, code: 'DONE' }] });
  assert.strictEqual(ic.collect(WORKS)[0].untrusted, false, 'a different task is clean');
});

test('one question, one answer, then the line closes', () => {
  const ic = fresh();
  const q = ic.send({ from: 'cavalier', parts: [{ to: 'agent:ecnalanif', code: 'ASK', line: 'kp today?' }] });
  assert.ok(q.call > 0);
  assert.match(ic.send({ from: 'ravens-league', call: q.call, parts: [{ code: 'ANSWER', number: 3 }] }).why, /not asked of this agent/);
  assert.match(ic.send({ from: 'ecnalanif', parts: [{ code: 'ANSWER', number: 3 }] }).why, /must name the call/);
  assert.ok(ic.send({ from: 'ecnalanif', call: q.call, parts: [{ code: 'ANSWER', number: 3 }] }).ok);
  assert.match(ic.send({ from: 'ecnalanif', call: q.call, parts: [{ code: 'ANSWER', number: 4 }] }).why, /line is closed/);
  const got = ic.collect('cavalier');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].number, 3);
  assert.match(ic.send({ from: 'cavalier', parts: [
    { to: 'agent:ecnalanif', code: 'ASK', line: 'a?' }, { to: 'agent:ecnalanif', code: 'ASK', line: 'b?' }] }).why, /one question/);
});

test('asked of several: answers stay sealed until all are in', () => {
  const ic = fresh();
  const q = ic.send({ from: CHAN, parts: [{ to: 'area:prices', code: 'ASK', line: 'is spy.close stale?' }] });
  const members = AREAS.prices;
  for (const [i, a] of members.entries()) {
    assert.strictEqual(ic.pending(CHAN).length, 0, 'nothing is heard until everyone has answered');
    assert.ok(ic.send({ from: a, call: q.call, parts: [{ code: 'ANSWER', number: i }] }).ok);
  }
  assert.strictEqual(ic.collect(CHAN).length, members.length);
});

test('a late answer is refused and the bell rings; the deadline also unseals what did arrive', () => {
  const ic = fresh();
  const q = ic.send({ from: CHAN, deadlineMin: 2, parts: [{ to: 'area:prices', code: 'ASK', line: 'close?' }] });
  assert.ok(ic.send({ from: 'cavalier', call: q.call, parts: [{ code: 'ANSWER', number: 1 }] }).ok);
  assert.strictEqual(ic.pending(CHAN).length, 0);
  ic.tick(3);
  assert.strictEqual(ic.send({ from: 'ecnalanif', call: q.call, parts: [{ code: 'ANSWER', number: 2 }] }).why, 'deadline passed');
  assert.strictEqual(ic.events('bell').length, 1);
  assert.strictEqual(ic.collect(CHAN).length, 1);
});

test('postage: 5 stamps, then the reserve, then the draw cap holds the message and tells the Emperor', () => {
  const ic = fresh();
  const out = [];
  for (let i = 0; i < 16; i++) out.push(ic.send(done('cavalier', 'agent:ecnalanif')));
  assert.deepStrictEqual(out.slice(0, 5).map(r => [r.stamps, r.draws]), Array(5).fill([1, 0]));
  assert.deepStrictEqual(out.slice(5, 15).map(r => [r.stamps, r.draws]), Array(10).fill([0, 1]));
  const last = out[15];
  assert.ok(last.ok && last.held, 'held, not lost');
  assert.match(last.why, /draw cap of 10/);
  assert.strictEqual(ic.pending('ecnalanif').length, 15);
  const rep = ic.report();
  assert.strictEqual(rep.draws.cavalier, 10);
  assert.strictEqual(rep.reserve_left, 15);
  assert.strictEqual(rep.held.length, 1);
  assert.ok(rep.tells.some(t => /is held/.test(t)));
  assert.match(ic.release(last.id, 'cavalier').why, /only the Emperor/);
  assert.ok(ic.release(last.id, 'emperor').ok);
  assert.strictEqual(ic.pending('ecnalanif').length, 16);
});

test('an empty reserve holds the message; the Emperor can refill it or an agent', () => {
  const ic = fresh({ config: { reserve: 2 } });
  for (let i = 0; i < 7; i++) assert.strictEqual(ic.send(done('cavalier', 'agent:ecnalanif')).held, false);
  const h = ic.send(done('cavalier', 'agent:ecnalanif'));
  assert.ok(h.held);
  assert.match(h.why, /reserve is empty/);
  assert.match(ic.grant('reserve', 5, 'cavalier').why, /only the Emperor/);
  assert.ok(ic.grant('reserve', 5, 'emperor').ok);
  assert.strictEqual(ic.send(done('cavalier', 'agent:ecnalanif')).draws, 1);
  assert.ok(ic.grant('cavalier', 3, 'emperor').ok);
  assert.strictEqual(ic.send(done('cavalier', 'agent:ecnalanif')).stamps, 1);
});

test('stamps are per day, and reports to the Emperor are free', () => {
  const ic = fresh();
  for (let i = 0; i < 5; i++) ic.send(done('cavalier', 'agent:ecnalanif'));
  assert.deepStrictEqual([ic.send(done('cavalier', 'emperor'))].map(r => [r.stamps, r.draws]), [[0, 0]]);
  ic.tick(24 * 60);
  assert.strictEqual(ic.send(done('cavalier', 'agent:ecnalanif')).stamps, 1);
});

test('an alarm must name a listed condition and carries no free text', () => {
  const ic = fresh();
  assert.match(ic.send({ from: 'backup', parts: [{ code: 'ALARM', condition: 'i_feel_urgent' }] }).why, /listed condition/);
  assert.match(ic.send({ from: 'backup', parts: [{ code: 'ALARM' }] }).why, /listed condition/);
  assert.match(ic.send({ from: 'backup', parts: [{ code: 'ALARM', condition: 'missed_run', line: 'please read' }] }).why, /no free text/);
});

test('a verified alarm is free; an unverified one costs a stamp and still arrives, marked', () => {
  const ic = fresh({ verifyAlarm: c => c === 'source_failed' });
  const v = ic.send({ from: 'ecnalanif', parts: [{ code: 'ALARM', condition: 'source_failed' }] });
  assert.deepStrictEqual([v.stamps, v.draws, v.held], [0, 0, false]);
  const u = ic.send({ from: 'ecnalanif', parts: [{ code: 'ALARM', condition: 'missed_run' }] });
  assert.strictEqual(u.stamps, 1);
  const got = ic.collect('emperor');
  assert.deepStrictEqual(got.map(p => [p.condition, p.verified]), [['source_failed', true], ['missed_run', false]]);
  assert.deepStrictEqual(ic.report().alarms.ecnalanif, { verified: 1, unverified: 1 });
});

test('alarms go up, never sideways', () => {
  const ic = fresh();
  const a = ic.send({ from: 'ecnalanif', parts: [{ code: 'ALARM', condition: 'source_failed', to: 'agent:cavalier' }] });
  assert.strictEqual(ic.pending('cavalier').length, 0);
  assert.strictEqual(ic.pending('supervisor').length, 1);
  assert.strictEqual(ic.pending('emperor').length, 1);
  assert.strictEqual(ic.open('cavalier', a.parts[0]).bad, true);
});

test('one alarm per condition per day, and the circuit breaker holds the fourth', () => {
  const ic = fresh();
  const alarm = c => ic.send({ from: 'backup', parts: [{ code: 'ALARM', condition: c }] });
  assert.ok(alarm('backup_failed').ok);
  assert.match(alarm('backup_failed').why, /one alarm per condition per day/);
  assert.ok(alarm('source_failed').ok);
  assert.strictEqual(alarm('missed_run').held, false);
  const fourth = alarm('integrity_flag');
  assert.ok(fourth.held);
  assert.match(fourth.why, /alarm limit of 3/);
  assert.strictEqual(ic.pending('emperor').length, 3);
});

test('the daily dollar budget is the last wall', () => {
  const ic = fresh({ budgetOk: () => false });
  assert.strictEqual(ic.send(done('cavalier', 'agent:ecnalanif')).why, 'daily budget spent');
});

test('Open parts are heard only as a tally: no names, one voice per agent', () => {
  const ic = fresh();
  const open = (from, code) => ic.send({ from, parts: [{ to: 'area:prices', level: 'open', code, topic: 'spy.close' }] });
  open('cavalier', 'STALE'); open('ecnalanif', 'STALE'); open('ravens-league', 'THIN'); open('ravens-league', 'STALE');
  assert.strictEqual(ic.pending(TREAS).length, 0, 'the raw words are never delivered');
  const t = ic.tally();
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].text, '3 of 4 in area prices flagged STALE on spy.close');
  assert.ok(!/cavalier|ecnalanif|ravens/.test(JSON.stringify(t)));
  assert.match(ic.send({ from: 'cavalier', parts: [{ to: `agent:${TREAS}`, level: 'open', code: 'STALE' }] }).why, /area or to all/);
});

test('Sealed-until: nobody receives it until the Warden meets the condition', () => {
  const ic = fresh();
  assert.match(ic.send({ from: 'panel', parts: [{ to: `agent:${CHAN}`, level: 'sealed', code: 'DONE' }] }).why, /must name its condition/);
  ic.send({ from: 'panel', parts: [{ to: `agent:${CHAN}`, level: 'sealed', until: 'verdict.g', code: 'DONE', number: 1 }] });
  assert.strictEqual(ic.pending(CHAN).length, 0);
  assert.match(ic.unseal('verdict.g', 'panel').why, /only the Warden or the Emperor/);
  assert.ok(ic.unseal('verdict.g', 'warden').ok);
  assert.strictEqual(ic.collect(CHAN).length, 1);
});

test("the Emperor's report: parts cut from whom, and the stovepipe alarm", () => {
  const ic = fresh();
  ic.send({ from: SKALD, parts: [
    { to: `agent:${CHAN}`, code: 'THIN', topic: 'skald.headlines', untrusted: true },
    { to: 'area:prices', code: 'DONE', number: 42, topic: 'skald.stock_mood' },
  ] });
  ic.send({ from: 'cavalier', parts: [{ to: 'area:news', code: 'NEED SOURCE', topic: 'skald.headlines' }] });
  const rep = ic.report();
  assert.strictEqual(rep.cuts[CHAN], 1);
  assert.strictEqual(rep.cuts.cavalier, 1);
  assert.strictEqual(rep.stovepipe.length, 1);
  assert.deepStrictEqual([rep.stovepipe[0].agent, rep.stovepipe[0].held_by], ['cavalier', SKALD]);
  assert.strictEqual(rep.watch.need_source.cavalier, 1);
});

test('mutual confirmations are counted for the Emperor', () => {
  const ic = fresh();
  ic.send({ from: 'cavalier', parts: [{ to: 'agent:ecnalanif', code: 'CONFIRM', cite: 'note:1' }] });
  ic.send({ from: 'ecnalanif', parts: [{ to: 'agent:cavalier', code: 'CONFIRM', cite: 'note:2' }] });
  assert.deepStrictEqual(ic.report().watch.mutual_confirms, [['cavalier', 'ecnalanif']]);
});

test('log before deliver: the logged row always precedes the open', () => {
  const ic = fresh();
  const r = ic.send(done(SKALD, `agent:${CHAN}`));
  ic.open(CHAN, r.parts[0]);
  const logged = ic.events('logged').find(e => e.msg_id === r.id);
  const opened = ic.events('opened').find(e => e.part_id === r.parts[0]);
  assert.ok(logged && opened && logged.id < opened.id);
});

test('append-only: the module never rewrites or removes a row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'runners', 'intercom.js'), 'utf8');
  assert.ok(!/\b(UPDATE|DELETE|DROP)\b/.test(src));
});

test('the spec check: unsigned is refused, signed gives who, when and the body hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-spec-'));
  const bodyText = '# Spec\nrules\n\n---\n';
  fs.writeFileSync(path.join(dir, 'INTERCOM.md'), `${bodyText}${SIG_MARK} ______________  **Date:** ________\n`);
  const u = specCheck(dir);
  assert.strictEqual(u.ok, false);
  assert.match(u.why, /unsigned/);
  fs.writeFileSync(path.join(dir, 'INTERCOM.md'), `${bodyText}${SIG_MARK} ___Opie___  **Date:** _11/10/2026_\n`);
  const s = specCheck(dir);
  assert.deepStrictEqual([s.ok, s.who, s.date], [true, 'Opie', '11/10/2026']);
  assert.strictEqual(s.hash, u.hash, 'signing does not change the hash of what was signed');
  assert.strictEqual(specCheck(path.join(dir, 'nowhere')).ok, false);
});

test('the real INTERCOM.md is signed and its body hash is the one committed', () => {
  const s = specCheck(path.join(__dirname, '..'));
  assert.strictEqual(s.ok, true, s.why);
  assert.strictEqual(s.hash, '42a848a0333f8b5f');
});
