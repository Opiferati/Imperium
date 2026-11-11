'use strict';
// The Emperor's nightly Intercom line, and the facts behind it.
//
// Amendment 1 made silent withholding the rule, which makes this line the ONLY guard
// against the wrong agent being left out. So the thing it must never do is go quiet on a
// night with something to say - a cheerful silence is what a stovepipe looks like.
//
// This began as a card (cards/icomwatch). A test caught it: the card declared no authority
// while reading the Intercom's whole history, which misrepresents its reach on the very
// line that exists to show reach - and it reopened the Intercom with its own defaults, so
// it printed a reserve figure that was never the one in force. The report now comes from
// the Warden's own configured Intercom, which cannot disagree with itself.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { intercom, reportLine } = require('../runners/intercom.js');
const { makeFacts, AI_AGENTS } = require('../runners/icom-facts.js');

const ROOT = path.join(__dirname, '..');
const CAV = 'cavalier', ECN = 'ecnalanif', RAV = 'ravens-league';

function scratch(registry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icr-'));
  fs.mkdirSync(path.join(root, 'data'));
  if (registry) fs.writeFileSync(path.join(root, 'data', 'imperium-registry.json'), JSON.stringify(registry));
  return root;
}
function openIc(root, opts = {}) {
  return intercom(null, path.join(root, 'data', 'intercom.db'),
    { amended: true, now: () => new Date('2026-11-11T23:00:00Z'), ...opts });
}
function seedHealth(root, agent, lastOkIso, state = 'ok') {
  const bb = require('../runners/blackboard.js').board(root, path.join(root, 'data', 'blackboard.db'));
  bb.post({ topic: `supervisor.${agent}.health`, author: 'supervisor',
            value: { state, failures_in_window: 0, max: 4, last_error: null, last_ok: lastOkIso, disabled_at: null } });
  bb.close();
}

// -- the line ---------------------------------------------------------------
test('a silent night says so in one line, not a wall of zeroes', () => {
  const ic = openIc(scratch());
  assert.match(reportLine(ic.report('2026-11-11')),
    /^\[INTERCOM\] 2026-11-11: silent\. Nothing was said, so nothing went unheard\.$/);
  ic.close();
});

test('it reports what was handed and what came back', () => {
  const ic = openIc(scratch(), { ranToday: () => true });
  const a = ic.send({ from: CAV, parts: [{ to: `agent:${ECN}`, code: 'STALE', cite: 'note:1' }] });
  ic.hand(ECN, a.parts[0]);
  ic.acknowledge(ECN, a.parts[0]);
  assert.match(reportLine(ic.report('2026-11-11')), /1 handed, 1 acknowledged/);
  ic.close();
});

test('both silences are named, and so is the cause of each', () => {
  const ic = openIc(scratch(), { ranToday: a => a !== RAV });
  const a = ic.send({ from: CAV, parts: [{ to: `agent:${ECN}`, code: 'DONE' }] });
  ic.hand(ECN, a.parts[0]);                                                 // handed, no mark back
  ic.send({ from: CAV, parts: [{ to: `agent:${RAV}`, code: 'DONE' }] });    // never handed
  const line = reportLine(ic.report('2026-11-11'));
  assert.match(line, /HANDED, NO MARK BACK \(1\)/);
  assert.match(line, new RegExp(`part \\d+ from ${CAV} -> ${ECN}`));
  assert.match(line, /NEVER HANDED \(1\)/);
  assert.match(line, /did not run: ravens-league/);
  ic.close();
});

test('the stovepipe alarm reaches the Emperor, because nothing else can tell him', () => {
  const ic = openIc(scratch(), { ranToday: () => true });
  ic.send({ from: CAV, parts: [{ to: `agent:${ECN}`, code: 'THIN', topic: 'league.ranking' }] });
  ic.send({ from: RAV, parts: [{ to: `agent:${CAV}`, code: 'NEED SOURCE', topic: 'league.ranking' }] });
  const line = reportLine(ic.report('2026-11-11'));
  assert.match(line, /STOVEPIPE \(1\)/);
  assert.match(line, /ravens-league asked about league\.ranking; cavalier had it/);
  ic.close();
});

test('held messages, bad seals and reserve draws all surface, at the numbers in force', () => {
  const ic = openIc(scratch(), { config: { base: 1, reserve: 1, drawCap: 1 }, ranToday: () => true });
  const a = ic.send({ from: CAV, parts: [{ to: `agent:${ECN}`, code: 'DONE' }] });
  ic.send({ from: CAV, parts: [{ to: `agent:${ECN}`, code: 'DONE' }] });          // draws from the reserve
  assert.ok(ic.send({ from: CAV, parts: [{ to: `agent:${ECN}`, code: 'DONE' }] }).held);
  ic.hand(RAV, a.parts[0]);                                                       // wrong party: Bad
  const line = reportLine(ic.report('2026-11-11'));
  assert.match(line, /BAD SEALS \(1\)/);
  assert.match(line, /HELD \(1\)/);
  assert.match(line, /RESERVE: cavalier drew 1; 0 left/);
  ic.close();
});

test('the watched counts are reported without blocking anything', () => {
  const ic = openIc(scratch(), { ranToday: () => true });
  ic.send({ from: CAV, parts: [{ to: 'agent:panel', code: 'DONE' }] });             // no ears
  ic.send({ from: 'supervisor', parts: [{ to: `agent:${CAV}`, code: 'DONE' }] });   // no voice
  ic.send({ from: CAV, parts: [{ to: `agent:${ECN}`, code: 'CONFIRM', cite: 'bad' }] });
  const line = reportLine(ic.report('2026-11-11'));
  assert.match(line, /1 to an agent with no ears/);
  assert.match(line, /1 from an agent with no voice/);
  assert.match(line, /1 with a bad citation/);
  assert.match(line, /3 refusal\(s\) in all/);
  ic.close();
});

test('a gap is reported as a gap, not as a fault', () => {
  // Found in a dry run on 2026-11-11: the initialed roster gives the plain-code runners
  // ears, but nothing calls collect() for them yet, so every alarm produced three
  // 'did not run' rows a night. A gap reported as a fault trains the Emperor to ignore
  // the report, which is the one thing it cannot survive.
  const wired = ['imperial-chancellor', 'ministry-of-works', 'ministry-of-intelligence', 'ministry-of-engineering'];
  const ic = openIc(scratch(), { collectsFor: wired, ranToday: () => false });
  ic.send({ from: CAV, parts: [{ code: 'ALARM', condition: 'source_failed' }] });
  const line = reportLine(ic.report('2026-11-11'));
  assert.match(line, /no reading step wired yet: /);
  assert.ok(!/did not run/.test(line), 'an unwired ear is not a sleeping agent');
  ic.close();
});

test('once an ear is wired, the cause goes back to telling asleep from ignoring', () => {
  const ic = openIc(scratch(), { collectsFor: [ECN, RAV], ranToday: a => a === ECN });
  ic.send({ from: CAV, parts: [{ to: `agent:${ECN}`, code: 'DONE' }] });
  ic.send({ from: CAV, parts: [{ to: `agent:${RAV}`, code: 'DONE' }] });
  const causes = ic.unheard('2026-11-11').unhanded.map(u => [u.agent, u.cause]);
  assert.deepStrictEqual(causes.sort(), [[ECN, 'ran, nothing handed'], [RAV, 'did not run']].sort());
  ic.close();
});

test('the Warden tells it which ears are actually wired', () => {
  const warden = fs.readFileSync(path.join(ROOT, 'warden.js'), 'utf8');
  assert.match(warden, /collectsFor: \['imperial-chancellor', \.\.\.MINISTRY_AGENTS\]/);
  // and the Skald and the Treasury are deliberately not on it: own branches, no mail
  assert.ok(!/collectsFor:[^\]]*ministry-of-skald/.test(warden));
});

// -- the facts behind it -----------------------------------------------------
test('an alarm condition nobody can prove is false, never "probably"', () => {
  const f = makeFacts(scratch({ budget: { daily_limit_usd: 2, warn_at_pct: 80 } }));
  for (const c of ['source_failed', 'budget_breach', 'integrity_flag', 'missed_run', 'backup_failed'])
    assert.strictEqual(f.verifyAlarm(c), false, `${c} with nothing on disk to read`);
  assert.strictEqual(f.verifyAlarm('i_feel_urgent'), false, 'an invented condition buys nothing');
});

test('a station that reports a missed scan makes missed_run provable', () => {
  const root = scratch({});
  fs.mkdirSync(path.join(root, '..', path.basename(root) + '-Cavalier', 'state'), { recursive: true });
  // the facts module looks for ../Cavalier/state/state.json relative to the root it is given
  const sib = path.join(root, '..', 'Cavalier', 'state');
  fs.mkdirSync(sib, { recursive: true });
  fs.writeFileSync(path.join(sib, 'state.json'), JSON.stringify({ missed_scans: 1, scans: 3, warnings: [] }));
  const f = makeFacts(root, {});
  assert.strictEqual(f.verifyAlarm('missed_run'), true);
  assert.strictEqual(f.verifyAlarm('integrity_flag'), true, '1 of 4 is over a tenth');
  fs.rmSync(path.join(root, '..', 'Cavalier'), { recursive: true, force: true });
});

test('a failed backup is read from the supervisor\'s own health note', () => {
  const root = scratch({});
  seedHealth(root, 'backup', '2026-11-11T03:02:16.045Z', 'disabled');
  assert.strictEqual(makeFacts(root, {}).verifyAlarm('backup_failed'), true);
  const ok = scratch({});
  seedHealth(ok, 'backup', '2026-11-11T03:02:16.045Z', 'ok');
  assert.strictEqual(makeFacts(ok, {}).verifyAlarm('backup_failed'), false);
});

test('"did it run" is worked out from the records, and admits when it cannot tell', () => {
  const root = scratch({});
  seedHealth(root, CAV, '2026-11-11T23:02:04.928Z');          // 6:02 PM New York on the 11th
  const f = makeFacts(root, {});
  assert.strictEqual(f.ranToday(CAV, '2026-11-11'), true);
  assert.strictEqual(f.ranToday(CAV, '2026-11-10'), false);
  assert.strictEqual(f.ranToday('nobody-wrote-about-this', '2026-11-11'), undefined);
});

test('the late look is still the same New York day, not the next UTC one', () => {
  const root = scratch({});
  seedHealth(root, CAV, '2026-11-12T03:01:05.000Z');          // 10:01 PM New York on the 11th
  assert.strictEqual(makeFacts(root, {}).ranToday(CAV, '2026-11-11'), true,
    'a UTC date comparison would have called this the 12th');
});

test('the AI agents are the ones the bus can answer for', () => {
  for (const a of ['imperial-chancellor', 'ministry-of-works', 'ministry-of-skald'])
    assert.ok(AI_AGENTS.has(a), a);
  assert.ok(!AI_AGENTS.has(CAV), 'a plain-code runner is a health-note question, not a bus one');
});

// -- the wiring --------------------------------------------------------------
test('the Warden reports from its own Intercom, behind the switch', () => {
  const warden = fs.readFileSync(path.join(ROOT, 'warden.js'), 'utf8');
  const i = warden.indexOf('intercomMod.reportLine(icom.report(etDay))');
  assert.ok(i > 0, 'the report is emitted');
  const guard = warden.lastIndexOf('if (icom && intercomMod) {', i);
  assert.ok(guard > 0 && i - guard < 600, 'and it is behind the switch');
  assert.match(warden.slice(guard, i + 600), /catch \(e\) \{ console\.warn/);
  assert.match(warden.slice(guard, i + 600), /stmtInsertMessage\.run\(msg\.task_id, 'warden', 'emperor', line/);
});

test('one source of truth: the Warden and the facts module agree by construction', () => {
  const warden = fs.readFileSync(path.join(ROOT, 'warden.js'), 'utf8');
  // The Warden must not carry its own copy of the verifier logic.
  assert.ok(!warden.includes("case 'integrity_flag'"), 'the rule lives in icom-facts, not here');
  assert.match(warden, /icomFactsMod\.makeFacts\(ROOT, registry\)/);
  for (const hook of ['verifyAlarm: icomVerify', 'budgetOk: icomBudgetOk', 'ranToday: icomRanToday'])
    assert.ok(warden.includes(hook), hook);
});

test('the card that used to do this is gone, not left half-wired', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'cards', 'icomwatch')),
    'a card declaring no authority while reading everything misrepresents its reach');
});
