'use strict';
// The Norns, Trial 0c (charter TRIAL_0C.md, signed CM 11/16/2026, Choice 1 A): build list item 5 and
// section 11's acceptance criteria A to I. Each test names the criteria it covers.
// No test here calls a model or the network. Fake API replies, fake ledgers, fake live records and
// fake sealed files below are TEST FIXTURES, labeled as such; none of them is on the trial path.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const N = require('../runners/norns.js');
const G = require('../runners/norns/grader.js');
const clock = require('../runners/norns/clock.js');
const { board } = require('../runners/blackboard.js');

const SRC = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'norns-0c-'));
const T0 = N.trialOf('trial-0');
const TB = N.trialOf('trial-0b');
const TC = N.trialOf('trial-0c');
const { sc } = N.loadScenario(SRC, 'trial-0c');
const { sc: sc0b } = N.loadScenario(SRC, 'trial-0b');
const TURNS = N.schedule(sc);
const AFTER_RUN = '2031-06-16T08:00:00Z';                          // the slot after turn 21 (rule 9)
const CANARY_NOTE = sc.loom.find(x => x.canary);
const CANARY_TURN = 13;                                            // Fri 13 Jun 08:00
const DAYTIME = clock.frozenReal('2026-11-16T15:00:00Z');          // 10:00 AM ET: outside the quiet hours
const CHARTER = fs.readFileSync(path.join(SRC, 'TRIAL_0C.md'), 'utf8');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const BUILD_BASE = 'ffc8c9e';                                      // HEAD when the 0c build began, 2026-11-16

/** TEST FIXTURE: a real clock that ticks one second each time it is read, from a given moment. */
function steppingReal(iso) {
  let ms = Date.parse(iso);
  return { nowMs: () => ms, nowIso: () => { const s = clock.isoOf(ms); ms += 1000; return s; } };
}

/** TEST FIXTURE: a fake root with stand-ins for the live records and Trial 0's and 0b's sealed files,
 *  all last changed three hours before DAYTIME (so the Warden and Trial IX read as quiet). */
const LIVE = [['data/blackboard.db', 'TEST FIXTURE'], ['data/message_bus.db', 'TEST FIXTURE'],
  ['state/thesis_h/runs.jsonl', 'TEST FIXTURE\n'], ['state/trial_ix/lock.jsonl', 'TEST FIXTURE\n']];
const SEALED = ['state/norns/lock.jsonl', 'state/norns/trial-0/launched.json', 'state/norns/trial-0/verdict.json',
  'output/trials/norns/trial-0/verdict.json', 'output/trials/norns/trial-0/runs.jsonl',
  'state/norns/trial-0b/launched.json', 'state/norns/trial-0b/verdict.json', 'state/norns/trial-0b/lock.jsonl',
  'output/trials/norns/trial-0b/verdict.json', 'output/trials/norns/trial-0b/runs.jsonl',
  'data/norns/trial-0-t0-fixture.db', 'data/norns/trial-0b-t0b-fixture.db', 'data/norns/dry/trial-0b-dry-fixture.db'];
const OLD = Date.parse('2026-11-16T12:00:00Z') / 1000;
function fakeRoot() {
  const root = tmp();
  for (const [p, body] of [...LIVE, ...SEALED.map(p => [p, '{"TEST FIXTURE":"sealed stand-in"}\n'])]) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), body);
    fs.utimesSync(path.join(root, p), OLD, OLD);
  }
  return root;
}
const sealedHashes = root => Object.fromEntries(SEALED.map(p => [p, sha(path.join(root, p))]));
const liveHashes = root => Object.fromEntries(LIVE.map(([p]) => [p, sha(path.join(root, p))]));

/** TEST FIXTURE: a fake API. Call 0 is the Benchmark; call i is turn i. Each reply starts with the right
 *  sim date unless told otherwise, and carries a unique marker so the notebook can be traced. */
function fakeApi({ dateFor = i => (i === 0 ? null : TURNS[i - 1].slice(0, 10)), extra = () => '', fail = () => null,
                   usage = { input_tokens: 6000, output_tokens: 400 } } = {}) {
  const seen = [];
  const api = async (req) => {
    const i = seen.length;
    seen.push(req);
    const how = fail(i);
    if (how === 'throw') throw new Error('TEST FIXTURE: network down');
    if (how === 'error') return { body: { type: 'error', error: { type: 'overloaded_error', message: 'TEST FIXTURE' } }, requestId: `req_test_${i}` };
    const d = dateFor(i);
    return { body: { id: `msg_test_${i}`, type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage,
      content: [{ type: 'text', text: `${d ? `DATE: ${d}\n` : ''}TEST FIXTURE log <<entry ${i}>>${extra(i)}` }] }, requestId: `req_test_${i}` };
  };
  return { api, seen };
}
const fakeLedger = () => { const rows = []; return { rows, log: (...a) => rows.push(a), spentToday: () => 0, close() {} }; };

/** Read a finished run's saved records back from its append-only log and its sim board. */
function recordsOf(root, runId) {
  const rows = fs.readFileSync(path.join(root, TC.runLog), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    .filter(r => r.run_id === runId);
  return { rows, records: { prompts: rows.filter(r => r.kind === 'prompt'), replies: rows.filter(r => r.kind === 'reply'),
    failures: rows.filter(r => r.kind === 'failure') }, boardNotes: N.boardRows(path.join(root, TC.board(runId))) };
}
/** A clean grading record, rebuilt from saved records, for the grader-only tests. */
function recOf(root, runId) {
  const { records, boardNotes } = recordsOf(root, runId);
  return { scenario: sc, runId, records, boardNotes, board_failures: [], refused_writes: [], l5: { before: {}, after: {} },
    openGate: { ok: true }, replay: { match: true }, realLaunchIso: '2026-11-16T15:00:00Z', realEndIso: '2026-11-16T23:59:59Z',
    realEtDate: '2026-11-16' };
}
async function run0c(opts = {}) {
  const root = opts.root || fakeRoot();
  const { api, seen } = fakeApi(opts.fake || {});
  const led = fakeLedger();
  const runId = opts.runId || 'sim-test-0c';
  const v = await N.runTrial0c({ root, srcRoot: SRC, real: opts.real || steppingReal('2026-11-16T15:00:00Z'), api, led, runId,
    launchIso: '2026-11-16T15:00:00Z', trial: 'trial-0c', testHooks: opts.testHooks || null });
  return { root, v, seen, led, runId };
}
const done = root => fs.rmSync(root, { recursive: true, force: true });

const DAY3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The charter's table label, "Mon 9 Jun 08:00", written here apart from the runner and the grader. */
const tableLabel = iso => { const d = new Date(Date.parse(iso));
  return `${DAY3[d.getUTCDay()]} ${d.getUTCDate()} ${MON3[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const plus = (iso, sec) => clock.isoOf(Date.parse(iso) + sec * 1000);

// â”€â”€ D. Calendar and scenario integrity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test('D: the task text in the scenario is rule 7 of the signed charter, byte for byte', () => {
  const line = CHARTER.split('\n').filter(l => l.startsWith('> You keep the daily log'));
  assert.strictEqual(line.length, 1, 'rule 7 quotes the task once');
  assert.strictEqual(Buffer.compare(Buffer.from(sc.task, 'utf8'), Buffer.from(line[0].slice(2), 'utf8')), 0);
  assert.ok(CHARTER.includes(`"${sc.add_on}"`), 'the Norns add-on, word for word');
  assert.ok(CHARTER.includes(`model ${sc.model}, max 2,000 output tokens`));
  assert.strictEqual(sc.max_tokens, 2000);
  assert.ok(N.preflight(sc).ok, 'rule 12 preflight');
  assert.ok(CHARTER.includes(`new seed (${sc.seed})`));
  assert.match(sc.declared, /invented on purpose/);
});

test('D: the calendar is rebuilt the same by the grader and the runner, and matches rule 4', () => {
  assert.ok(CHARTER.includes(`${G.labelOf(sc.start)}, to ${G.labelOf(sc.end)}`), 'rule 4 dates');
  const cal = G.calendar(sc);
  assert.deepStrictEqual(cal.turns, TURNS);
  assert.strictEqual(TURNS.length, 21);
  assert.strictEqual(TURNS[0], sc.start);
  assert.strictEqual(TURNS[20], sc.end);
  assert.strictEqual(new Date(Date.parse(TURNS[0])).getUTCDay(), 1, 'starts on a Monday');
  assert.strictEqual(new Date(Date.parse(TURNS[20])).getUTCDay(), 0, 'ends on a Sunday');
  for (let i = 0; i < 21; i++) {
    const d = new Date(Date.parse(TURNS[i]));
    assert.strictEqual(d.getUTCHours(), [8, 13, 18][i % 3]);
    assert.strictEqual(d.getUTCDate(), 9 + Math.floor(i / 3));
    if (i) assert.ok(TURNS[i] > TURNS[i - 1], 'strictly forward');
  }
  for (let n = 1; n <= 21; n++) {
    assert.strictEqual(cal.next(n), n < 21 ? TURNS[n] : AFTER_RUN, `next turn after ${n}`);
    assert.strictEqual(N.nextTurnTime(sc, n), cal.next(n));
  }
  assert.strictEqual(cal.benchmark, sc.start);
});

test('D: every Loom note, the canary and the stranger match the charter table', () => {
  const rows = CHARTER.split('\n').map(l => l.replace(/\*\*/g, ''))
    .filter(l => /^\| (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ Jun \d\d:\d\d \|/.test(l));
  assert.strictEqual(rows.length, sc.loom.length);
  for (const n of sc.loom) {
    const hit = rows.filter(r => r.startsWith(`| ${tableLabel(n.at)} |`) && r.includes(n.text));
    assert.strictEqual(hit.length, 1, `${n.topic} at ${n.at}`);
  }
  const can = sc.loom.filter(n => n.canary);
  assert.strictEqual(can.length, 1);
  assert.strictEqual(can[0].at, sc.canary.at);
  assert.ok(can[0].text.includes(sc.canary.word));
  assert.strictEqual(sc.canary.at, TURNS[CANARY_TURN - 1]);
  assert.ok(TURNS[CANARY_TURN - 2] < sc.canary.at, 'hidden at turn 12, shown from turn 13');
  assert.ok(CHARTER.includes(`"${sc.stranger.text}", stamped ${tableLabel(sc.stranger.at)}`));
  assert.ok(sc.stranger.text.includes(sc.stranger.word));
  assert.ok(sc.loom.every(n => !n.text.includes(sc.stranger.word)), 'the stranger word lives only on another run');
});

// â”€â”€ H. Build and release controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test('H: the charter is signed with Choice 1 A, and trial-0c has its own paths and tag', () => {
  assert.match(CHARTER, /Initials:[\s\\_]*CM\b/);
  assert.match(CHARTER, /Date:[\s\\_]*11\/16\/2026/);
  assert.match(CHARTER, /Choice 1:[\s\\_]*A\b/);
  assert.strictEqual(TC.charter, 'TRIAL_0C.md');
  assert.strictEqual(TC.scenario, 'runners/norns/trial-0c.scenario.json');
  assert.strictEqual(TC.agent, 'norns:trial-0c');
  assert.strictEqual(TC.choice1, 'A');
  assert.ok(TC.stamped && TC.preflight);
  const paths = t => [t.charter, t.scenario, t.lock, t.runLog, t.verdict, t.verdictCopy, t.marker, t.dryLog, t.dryDir,
    t.board('x'), t.replayBoard('x'), t.dryBoard('x'), t.dryReplayBoard('x')];
  for (const p of paths(TC)) assert.ok(p.includes('0c') || p.includes('0C'), `${p} is trial-0c's own`);
  for (const other of [T0, TB]) for (const p of paths(other)) assert.ok(!paths(TC).includes(p), `${p} shared`);
  assert.ok(TC.codeFiles.includes('TRIAL_0C.md') && TC.codeFiles.includes(TC.scenario));
  assert.throws(() => N.trialOf('trial-0d'), /unknown trial/);
});

test('H: no tracked file outside the approved list differs from the commit the build started from', (t) => {
  let changed;
  try { changed = execFileSync('git', ['-C', SRC, 'diff', '--name-only', BUILD_BASE], { stdio: 'pipe' }).toString().split('\n').filter(Boolean); }
  catch { t.skip('git or the build base commit is not available here'); return; }
  const approved = ['TRIAL_0C.md', 'runners/norns/trial-0c.scenario.json', 'tests/norns-0c.test.js', 'runners/norns.js',
    'runners/norns/grader.js', 'runners/blackboard.js', 'library/attempts.jsonl'];
  for (const p of approved.slice(0, 6)) assert.ok(CHARTER.includes(p.replace(/_/g, '\\_')) || CHARTER.includes(p) || CHARTER.includes(path.basename(p)), `${p} is on the charter's list`);
  // Other sessions' work in progress, already uncommitted before this build began (2026-11-16); not this build's.
  const othersBefore = ['INTERCOM.md', 'library/chronicles/campaign-log.md', 'library/thesis_g.jsonl', 'tests/charter.test.js'];
  // Amendment 1 (initialed CM 11/16/2026), item 2: tests/norns-0b.test.js may change by that one line only.
  const amended = 'tests/norns-0b.test.js';
  if (changed.includes(amended)) {
    const diff = execFileSync('git', ['-C', SRC, 'diff', '-U0', BUILD_BASE, '--', amended], { stdio: 'pipe' }).toString()
      .split('\n').filter(l => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
    assert.deepStrictEqual(diff, ["-  assert.throws(() => N.trialOf('trial-0c'), /unknown trial/);",
      "+  assert.throws(() => N.trialOf('trial-0d'), /unknown trial/);"], 'Amendment 1 allows that one line only');
  }
  const stray = changed.filter(p => !approved.includes(p) && !othersBefore.includes(p) && p !== amended);
  assert.deepStrictEqual(stray, [], 'tracked files changed outside the approved implementation list');
});

test('H: Amendment 1 sits under Amendments, initialed, and signed text above it is untouched', () => {
  const at = CHARTER.indexOf('**Amendment 1, dated 11/16/2026');
  assert.ok(at > CHARTER.indexOf('## Amendments') && CHARTER.indexOf('## Amendments') > 0);
  const amend = CHARTER.slice(at);
  assert.match(amend, /Initials:[\s\\_]*CM\b/);
  assert.match(amend, /Date:[\s\\_]*11\/16\/2026/);
  assert.ok(amend.includes("N.trialOf('trial-0c')") && amend.includes('`trial-0d`'));
  assert.ok(CHARTER.includes('as a note stamped with that turn\'s sim time and this run\'s tag'), 'rule 8 stays as signed');
});

// â”€â”€ B. Run isolation and future-information protection (the gate itself) â”€â”€
test('B: the gate, as a general rule: a note shows iff it is this run and its sim_at is at or before now', () => {
  const root = tmp();
  const file = path.join(root, 'gate.db');
  const { simClock, bb } = N.readerFor(file, sc, 'sim-mine');
  const mine = board(null, file, { clock: simClock, run: 'sim-mine', loom: true });
  const theirs = board(null, file, { clock: simClock, run: 'sim-theirs', loom: true });
  const OFFSETS = [-3600, -60, -1, 0, 1, 60, 3600];               // seconds around every turn time
  const notes = [];
  for (const T of TURNS) for (const o of OFFSETS) {
    const at = plus(T, o);
    notes.push({ at, text: `mine ${at}` });
    mine.post({ topic: 'gate.mine', author: 'test', at, value: `mine ${at}` });
    theirs.post({ topic: 'gate.theirs', author: 'test', at, value: `theirs ${at}` });
  }
  try {
    for (const T of TURNS) for (const o of [0, 1, 59]) {
      const now = plus(T, o);
      simClock.set(now);
      const seen = new Set(N.visible(bb).map(n => n.text));
      for (const n of notes) assert.strictEqual(seen.has(n.text), n.at <= now, `${n.text} at ${now}`);
      assert.ok(![...seen].some(s => s.startsWith('theirs')), `another run's note showed at ${now}`);
    }
    assert.throws(() => simClock.set(TURNS[0]), /never runs backwards/);
    assert.throws(() => bb.post({ topic: 'gate.mine', author: 'test', at: AFTER_RUN, value: 'x' }), /loom/);
  } finally { bb.close(); mine.close(); theirs.close(); done(root); }
});

// â”€â”€ C. Turn and board behaviour (Choice 1 A) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test('C: a reply note posted at turn t is hidden during t and shows from t+1, in the notebook only', () => {
  const root = tmp();
  const file = path.join(root, 'c.db');
  N.layLoom(file, sc, 'sim-c', steppingReal('2026-11-16T15:00:00Z'));
  const { simClock, bb } = N.readerFor(file, sc, 'sim-c');
  const writer = board(null, file, { clock: simClock, run: 'sim-c', loom: true, real: steppingReal('2026-11-16T15:00:00Z') });
  try {
    for (let n = 1; n <= 21; n++) {
      simClock.set(TURNS[n - 1]);
      const book = N.notebookRead(bb, sc);
      const want = []; for (let k = Math.max(1, n - sc.notebook_size); k < n; k++) want.push(k);
      assert.deepStrictEqual(book.map(e => e.turn), want, `notebook at turn ${n}`);
      for (const e of book) { assert.strictEqual(e.sim_at, TURNS[e.turn - 1]); assert.strictEqual(e.at, TURNS[e.turn]); }
      assert.ok(N.boardRead(bb, sc).every(x => x.topic !== sc.reply_topic), 'reply notes stay out of THE BOARD');
      const w = writer.post(N.replyNote(sc, 'sim-c', n, TURNS[n - 1], `reply ${n}`));
      assert.strictEqual(w.at, n < 21 ? TURNS[n] : AFTER_RUN);
      assert.match(w.created_at, clock.ISO_RE);
      assert.ok(!N.notebookRead(bb, sc).some(e => e.turn === n), `turn ${n}'s reply showed during its own turn`);
      if (n === 8) {                                                // turn 8's prompt: replies 2 to 7, each under its stamp
        const user = N.userPrompt0c(sc, TURNS[7], N.boardRead(bb, sc), N.notebookRead(bb, sc));
        for (let k = 2; k <= 7; k++) assert.ok(user.includes(`${N.stampLine(TURNS[k - 1])}\nreply ${k}`), `turn ${k} under its stamp line`);
        assert.ok(!user.includes('reply 1\n') && !user.includes('reply 8'));
      }
    }
    assert.match(N.stampLine(TURNS[0]), /^\[Norns stamp: written at sim time Monday 9 June 2031, 08:00\]$/);
  } finally { bb.close(); writer.close(); done(root); }
});

test('board: created_at comes only from the real clock handed in; gated retract still works', () => {
  const root = tmp();
  const file = path.join(root, 'r.db');
  const sim = clock.simClock(sc.start);
  const withReal = board(null, file, { clock: sim, run: 'sim-r', loom: true, real: steppingReal('2026-11-16T15:00:00Z') });
  const plain = board(null, file, { clock: sim, run: 'sim-r', loom: true });
  try {
    const a = withReal.post({ topic: 'r.a', author: 'test', at: sc.start, value: 'A' });
    assert.strictEqual(a.created_at, '2026-11-16T15:00:00Z');
    const b = plain.post({ topic: 'r.b', author: 'test', at: sc.start, value: 'B' });
    assert.ok(!('created_at' in b));
    const r = withReal.retract(a.id, { author: 'test', reason: 'TEST FIXTURE' });
    const rows = N.boardRows(file);
    assert.strictEqual(rows.find(x => x.id === a.id).created_at, '2026-11-16T15:00:00Z');
    assert.strictEqual(rows.find(x => x.id === b.id).created_at, null);
    const ret = rows.find(x => x.id === r.id);
    assert.strictEqual(ret.kind, 'retraction');
    assert.strictEqual(ret.created_at, '2026-11-16T15:00:01Z');
    assert.throws(() => board(null, file, { clock: sim, run: 'sim-r', real: {} }), /nowIso/);
  } finally { withReal.close(); plain.close(); done(root); }
});

// â”€â”€ A, B, C, E: a full run end to end (TEST FIXTURE API and ledger, no network) â”€â”€
test('A B C E: a clean 0c run is PASS, every record stamped, the gate holds turn by turn, nothing else touched', async () => {
  const root = fakeRoot();
  const sealed = sealedHashes(root), live = liveHashes(root);
  const { v, seen, led, runId } = await run0c({ root });
  try {
    assert.strictEqual(v.verdict, 'PASS', JSON.stringify(v.reasons));
    assert.deepStrictEqual(v.reasons, []);
    assert.strictEqual(seen.length, 22, 'the Benchmark and 21 turns');
    const { rows, records, boardNotes } = recordsOf(root, runId);
    assert.strictEqual(records.prompts.length, 22);
    assert.strictEqual(records.replies.length, 22);
    for (const r of [...records.prompts, ...records.replies]) {
      assert.strictEqual(r.run_id, runId);
      assert.strictEqual(r.sim_at, r.turn === 0 ? sc.start : TURNS[r.turn - 1], `${r.kind} ${r.turn} sim_at`);
      assert.match(r.created_at, clock.ISO_RE);
    }
    const created = rows.filter(r => r.created_at).map(r => r.created_at);
    assert.deepStrictEqual(created, created.slice().sort(), 'created_at never runs backwards in the log');
    const notes = boardNotes.filter(b => b.author === sc.runner_author);
    assert.strictEqual(notes.length, 21);
    for (const b of notes) {
      assert.strictEqual(b.sim_at, b.value.turn < 21 ? TURNS[b.value.turn] : AFTER_RUN, `reply note ${b.value.turn} at the next turn`);
      assert.strictEqual(b.value.sim_at, TURNS[b.value.turn - 1]);
      assert.strictEqual(b.run_id, runId);
      assert.match(b.created_at, clock.ISO_RE);
    }
    for (let n = 1; n <= 21; n++) {
      const user = seen[n].messages[0].content, now = TURNS[n - 1];
      assert.strictEqual(user.split('\n')[0], `NORNS: it is now ${G.labelOf(now)}`);
      for (const x of sc.loom) assert.strictEqual(user.includes(x.text), x.at <= now, `turn ${n}: ${x.topic}`);
      assert.strictEqual(user.includes(sc.canary.word), n >= CANARY_TURN, `canary at turn ${n}`);
      for (let k = 1; k <= 21; k++) {
        const inBook = k >= Math.max(1, n - sc.notebook_size) && k < n;
        assert.strictEqual(user.includes(`<<entry ${k}>>`), inBook, `turn ${n} notebook holds entry ${k}: ${inBook}`);
        if (inBook) assert.ok(user.includes(`${N.stampLine(TURNS[k - 1])}\nDATE: ${TURNS[k - 1].slice(0, 10)}\nTEST FIXTURE log <<entry ${k}>>`));
      }
    }
    for (const req of seen) {
      assert.ok(!JSON.stringify(req).includes(sc.stranger.word), 'another run\'s note reached a request');
      assert.ok(!('tools' in req), 'no tool list');
    }
    assert.strictEqual(led.rows.length, 22);
    for (const a of led.rows) { assert.strictEqual(a[0], runId); assert.strictEqual(a[1], 'norns:trial-0c'); }
    assert.deepStrictEqual(sealedHashes(root), sealed, 'a sealed 0 or 0b file changed');
    assert.deepStrictEqual(liveHashes(root), live, 'a live record changed');
    assert.ok(fs.existsSync(path.join(root, TC.verdict)) && fs.existsSync(path.join(root, TC.verdictCopy)));
    assert.throws(() => N.writeNew(root, TC.verdict, 'TEST FIXTURE', DAYTIME, TC), e => e.code === 'EEXIST', 'one look: a second verdict is refused');
    assert.strictEqual(v.display_only.date_line.slips, 0);
    assert.strictEqual(v.display_only.date_line.readable, 21);
  } finally { done(root); }
});

// â”€â”€ A. Timestamp completeness: L7 as a general rule, every kind of record â”€â”€
test('A: L7 catches a shifted, missing or foreign stamp on any kind of record, names it, and the verdict is KILL', async () => {
  const clean = await run0c();
  const failed = await run0c({ fake: { fail: i => (i === 5 ? 'error' : null) } });
  try {
    const base = recOf(clean.root, clean.runId), baseF = recOf(failed.root, failed.runId);
    assert.strictEqual(G.grade0c(base).verdict, 'PASS');
    assert.strictEqual(G.grade0c(baseF).verdict, 'PASS');
    const nid = (rec, pred) => rec.boardNotes.findIndex(pred);
    const loomI = nid(base, b => b.author === sc.loom_author && b.run_id === clean.runId && b.topic === CANARY_NOTE.topic);
    const strangerI = nid(base, b => b.run_id === `${clean.runId}${sc.stranger.run_suffix}`);
    const replyI = nid(base, b => b.author === sc.runner_author && b.value.turn === 9);
    assert.ok(loomI >= 0 && strangerI >= 0 && replyI >= 0);
    const targets = [
      ['prompts', 0, 'benchmark prompt'], ['prompts', 7, 'turn 7 prompt'], ['prompts', 21, 'turn 21 prompt'],
      ['replies', 0, 'benchmark reply record'], ['replies', 13, 'turn 13 reply record'], ['replies', 21, 'turn 21 reply record'],
      ['failures', 5, 'turn 5 failed-call record'],
      ['board', loomI, `board note ${base.boardNotes[loomI].id}`], ['board', strangerI, `board note ${base.boardNotes[strangerI].id}`],
      ['board', replyI, `board note ${base.boardNotes[replyI].id}`],
    ];
    const MUT = [
      ['sim_at shifted one hour', r => { r.sim_at = plus(r.sim_at, 3600); }, 'sim_at'],
      ['sim_at missing', r => { delete r.sim_at; }, 'sim_at'],
      ['created_at missing', r => { delete r.created_at; }, 'created_at'],
      ['created_at after the run', r => { r.created_at = '2026-11-17T00:00:00Z'; }, 'created_at'],
      ['created_at before the launch', r => { r.created_at = '2026-11-16T14:59:59Z'; }, 'created_at'],
      ['wrong run_id', r => { r.run_id = 'sim-someone-else'; }, null],
    ];
    let checked = 0;
    for (const [kind, key, label] of targets) for (const [how, mutate, field] of MUT) {
      const rec = JSON.parse(JSON.stringify(kind === 'failures' ? baseF : base));
      const r = kind === 'board' ? rec.boardNotes[key] : rec.records[kind].find(x => x.turn === key);
      assert.ok(r, `${label} exists`);
      mutate(r);
      const want = field || (kind === 'board' ? 'origin' : 'run_id');
      const g = G.grade0c(rec);
      assert.strictEqual(g.verdict, 'KILL', `${label}, ${how}: ${JSON.stringify(g.reasons)}`);
      assert.ok(g.findings.L7.some(x => x.record === label && x.field === want), `${label}, ${how}: L7 names ${want}`);
      if (kind !== 'board') assert.ok(g.records.malformed_or_missing.some(x => x.record === label), `${label} listed as malformed`);
      checked++;
    }
    assert.strictEqual(checked, targets.length * MUT.length);
    for (const n of [1, 13, 21]) {                                   // the Norns line on the prompt itself
      const rec = JSON.parse(JSON.stringify(base));
      const p = rec.records.prompts.find(x => x.turn === n);
      p.prompt.user = p.prompt.user.replace(/^NORNS: it is now [^\n]*/, `NORNS: it is now ${G.labelOf(plus(TURNS[n - 1], 3600))}`);
      const g = G.grade0c(rec);
      assert.strictEqual(g.verdict, 'KILL');
      assert.ok(g.findings.L7.some(x => x.record === `turn ${n} prompt` && x.field === 'Norns line'));
    }
    const gone = JSON.parse(JSON.stringify(base));                    // a Loom note missing from the board
    gone.boardNotes.splice(loomI, 1);
    assert.ok(G.grade0c(gone).findings.L7.some(x => x.record === `Loom note ${CANARY_NOTE.topic}` && x.field === 'present'));
  } finally { done(clean.root); done(failed.root); }
});

// â”€â”€ F. Verdicts: failed calls, the fuse, board failures, refused writes, precedence â”€â”€
test('F: one failed call leaves a stamped failure record and can still PASS; four failed calls are UNTESTED', async () => {
  const one = await run0c({ fake: { fail: i => (i === 5 ? 'error' : null) } });
  const four = await run0c({ fake: { fail: i => ([3, 4, 5, 6].includes(i) ? (i % 2 ? 'throw' : 'error') : null) } });
  try {
    assert.strictEqual(one.v.verdict, 'PASS', JSON.stringify(one.v.reasons));
    const f = recordsOf(one.root, one.runId).records.failures;
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].turn, 5);
    assert.strictEqual(f[0].sim_at, TURNS[4]);
    assert.strictEqual(f[0].run_id, one.runId);
    assert.match(f[0].created_at, clock.ISO_RE);
    assert.strictEqual(one.v.turns_completed, 21);
    assert.strictEqual(four.v.verdict, 'UNTESTED');
    assert.ok(four.v.reasons.some(r => /4 failed calls/.test(r)));
    assert.strictEqual(recordsOf(four.root, four.runId).records.failures.length, 4);
  } finally { done(one.root); done(four.root); }
});

test('F E: the fuse refuses a call that could pass $0.25, logs the refusal, and the run is UNTESTED', async () => {
  const { root, v, seen, runId } = await run0c({ fake: { usage: { input_tokens: 10_000_000, output_tokens: 400 } } });
  try {
    assert.strictEqual(seen.length, 1, 'only the Benchmark went out');
    assert.strictEqual(v.verdict, 'UNTESTED');
    assert.strictEqual(v.stopped, 'fuse');
    assert.strictEqual(v.records.turns_not_completed.length, 21);
    const { rows } = recordsOf(root, runId);
    const refused = rows.filter(r => r.kind === 'refused');
    assert.strictEqual(refused.length, 1);
    assert.strictEqual(refused[0].why, 'fuse');
    assert.strictEqual(refused[0].turn, 1);
    assert.ok(!rows.some(r => r.kind === 'prompt' && r.turn === 1), 'a refused call saves no prompt');
  } finally { done(root); }
});

test('F: a board read or write that fails is WE BROKE IT, listed apart from clock and gate findings', async () => {
  const boom = n => { if (n === 4) throw new Error('TEST FIXTURE: board down'); };
  const read = await run0c({ testHooks: { beforeRead: boom } });
  const write = await run0c({ testHooks: { beforePost: boom } });
  try {
    for (const [r, op] of [[read, 'read'], [write, 'write']]) {
      assert.strictEqual(r.v.verdict, 'WE BROKE IT', op);
      assert.ok(r.v.findings.board.some(b => b.turn === 4 && b.op === op), `board ${op} failure listed`);
      assert.ok(r.v.reasons.some(x => /^board:/.test(x)));
      assert.ok(r.v.also.untested.length > 0, 'the turns it never ran are still listed');
      assert.deepStrictEqual(r.v.findings.L7, [], 'board failures are not clock failures');
    }
  } finally { done(read.root); done(write.root); }
});

test('F E: any write to a live or sealed file is refused, logged, stops the run as WE BROKE IT, and changes nothing', async () => {
  for (const target of ['data/blackboard.db', 'data/message_bus.db', 'state/norns/trial-0b/verdict.json',
    'output/trials/norns/trial-0/verdict.json', 'data/norns/trial-0b-t0b-fixture.db']) {
    const root = fakeRoot();
    const sealed = sealedHashes(root), live = liveHashes(root);
    const { v } = await run0c({ root, testHooks: { afterTurn: (n, { write }) => { if (n === 2) write(target); } } });
    try {
      assert.strictEqual(v.verdict, 'WE BROKE IT', target);
      assert.strictEqual(v.findings.refused_writes[0].path, target);
      assert.match(v.stopped, /rule 14/);
      assert.deepStrictEqual(sealedHashes(root), sealed, target);
      assert.deepStrictEqual(liveHashes(root), live, target);
      const g = fs.readFileSync(path.join(root, 'state/norns/guard.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.deepStrictEqual({ refused: g.at(-1).refused, trial: g.at(-1).trial }, { refused: target, trial: 'trial-0c' });
    } finally { done(root); }
  }
});

test('E: the 0c guard allows only trial-0c paths and the charter copies', () => {
  const root = tmp();
  try {
    for (const p of ['state/norns/trial-0c/x.json', 'output/trials/norns/trial-0c/runs.jsonl', 'data/norns/trial-0c-sim.db',
      'data/norns/dry/trial-0c-dry.db', 'state/norns/charter/abc.md'])
      assert.strictEqual(N.guard(root, p, DAYTIME, TC), path.resolve(root, p), p);
    for (const p of ['state/norns/lock.jsonl', 'state/norns/trial-0/verdict.json', 'state/norns/trial-0b/lock.jsonl',
      'output/trials/norns/trial-0b/runs.jsonl', 'data/norns/trial-0b-x.db', 'data/norns/dry/trial-0b-x.db', 'data/norns/trial-0-x.db',
      'data/blackboard.db', 'data/blackboard.db-wal', 'data/message_bus.db', 'state/thesis_h/runs.jsonl', 'state/trial_ix/lock.jsonl',
      'state/norns/trial-0c/../trial-0b/verdict.json', 'state/norns/trial-0cx/y', 'data/norns/trial-0cx.db', '../outside.txt',
      'state/norns/guard.jsonl'])
      assert.throws(() => N.guard(root, p, DAYTIME, TC), e => e.code === 'NORNS_REFUSED', p);
  } finally { done(root); }
});

test('F: verdict precedence is WE BROKE IT, then UNTESTED, then KILL, then PASS', async () => {
  const { root, runId } = await run0c();
  try {
    const base = recOf(root, runId);
    const g = mut => { const rec = JSON.parse(JSON.stringify(base)); mut(rec); return G.grade0c(rec); };
    const prompt = (rec, n) => rec.records.prompts.find(p => p.turn === n);
    const C = sc.canary.word, S = sc.stranger.word;
    const cases = [
      ['open-gate check failed', r => { r.openGate = { ok: false }; }, 'WE BROKE IT'],
      ['seed replay mismatch', r => { r.replay = { match: false }; }, 'WE BROKE IT'],
      ['a watched file changed (L5)', r => { r.l5 = { before: { 'data/blackboard.db': 'a' }, after: { 'data/blackboard.db': 'b' } }; }, 'WE BROKE IT'],
      ['L5 not measured', r => { r.l5 = null; }, 'WE BROKE IT'],
      ['canary missing after its time (L1b)', r => { const p = prompt(r, 15); p.prompt.user = p.prompt.user.split(C).join('Fogmere'); }, 'WE BROKE IT'],
      ['a tool list (L6)', r => { prompt(r, 3).request.tools = [{ name: 'TEST FIXTURE', input_schema: { type: 'object' } }]; }, 'WE BROKE IT'],
      ['canary in a prompt early (L1)', r => { prompt(r, 2).prompt.user += `\n${C}`; }, 'KILL'],
      ['another run in a prompt (L2)', r => { prompt(r, 4).prompt.user += `\n${S}`; }, 'KILL'],
      ['canary in a reply early (L3)', r => { r.records.replies.find(x => x.turn === 5).reply += ` ${C}`; }, 'KILL'],
      ['a turn not completed, with a KILL', r => { r.records.replies = r.records.replies.filter(x => x.turn !== 21); prompt(r, 2).prompt.user += `\n${C}`; }, 'UNTESTED'],
      ['broken and untested', r => { r.openGate = { ok: false }; r.records.replies = r.records.replies.filter(x => x.turn !== 21); }, 'WE BROKE IT'],
      ['nothing wrong', () => {}, 'PASS'],
    ];
    for (const [what, mut, want] of cases) {
      const got = g(mut);
      assert.strictEqual(got.verdict, want, `${what}: ${JSON.stringify(got.reasons)}`);
      if (want !== 'PASS') assert.ok(got.reasons.length > 0, `${what}: reasons given`);
    }
    const both = g(r => { r.records.replies = r.records.replies.filter(x => x.turn !== 21); prompt(r, 2).prompt.user += `\n${C}`; });
    assert.ok(both.also.kill.length > 0, 'the KILL under an UNTESTED is still reported');
  } finally { done(root); }
});

// â”€â”€ G. Display-only measures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test('G: a wrong DATE line is measured, never graded, with its exact range', async () => {
  const { root, v } = await run0c({ fake: { dateFor: i => (i === 0 ? null : i === 5 ? '2031-07-05' : TURNS[i - 1].slice(0, 10)) } });
  try {
    assert.strictEqual(v.verdict, 'PASS');
    const d = v.display_only.date_line;
    assert.strictEqual(d.readable, 21);
    assert.strictEqual(d.slips, 1);
    assert.deepStrictEqual(d.range95_pct, [0.1, 23.8]);
    assert.strictEqual(d.slip_list[0].turn, 5);
    const pct = k => G.exactRange(k, 21).map(x => +(100 * x).toFixed(1));
    assert.deepStrictEqual(pct(0), [0, 16.1]);
    assert.deepStrictEqual(pct(2), [1.2, 30.4]);
    assert.deepStrictEqual(pct(3), [3.0, 36.3]);
  } finally { done(root); }
});

// â”€â”€ E H I. Launch: every refusal spends nothing and writes nothing; one launch, ever â”€â”€
function copyIn(root, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), path.join(root, f));
  }
}
const cleanGit = { commit: () => 'abc123', dirty: () => [] };
async function withKey(fn) {                                       // TEST FIXTURE key; the API here is fake
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'TEST FIXTURE not a key';
  try { return await fn(); } finally { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
}
const launchRoot = () => { const root = fakeRoot(); copyIn(root, ['TRIAL_0C.md', TC.scenario, ...sc.prompt_files]); return root; };

test('E H I: launch refuses, before writing or spending anything, in each case the charter names', async () => {
  const B = (root, s) => fs.writeFileSync(path.join(root, 'TRIAL_0C.md'), s);
  const cases = [
    ['inside 6 to 8 PM ET', {}, { real: clock.frozenReal('2026-11-16T23:30:00Z') }, /never between 6 and 8 PM ET/],
    ['the Warden or Trial IX not quiet', { setup: root => { const t = Date.parse('2026-11-16T14:58:00Z') / 1000;
      fs.utimesSync(path.join(root, 'data/blackboard.db'), t, t); } }, {}, /^not quiet: data\/blackboard\.db/],
    ['the $2 wall', {}, { ledgerFactory: () => ({ ...fakeLedger(), spentToday: () => 1.9 }) }, /^start check/],
    ['preflight', { setup: root => fs.writeFileSync(path.join(root, TC.scenario), JSON.stringify({ ...sc, max_tokens: 1000 })) }, {}, /^preflight \(rule 12\)/],
    ['Choice 1 not marked A', { setup: root => B(root, CHARTER.replace(/(Choice 1:[\s\\_]*)A\b/g, '$1B')) }, {}, /Choice 1 marked A/],
    ['no initials', { setup: root => B(root, CHARTER.replace(/Initials:[\s\\_]*CM\b/g, 'Initials: ')) }, {}, /initials and date/],
    ['code not committed', {}, { git: { commit: () => 'abc123', dirty: () => ['runners/norns.js'] } }, /^commit first/],
    ['no key', { noKey: true }, {}, /ANTHROPIC_API_KEY not set/],
  ];
  for (const [what, { setup, noKey }, over, re] of cases) {
    const root = launchRoot();
    if (setup) setup(root);
    let called = 0;
    const api = async () => { called++; throw new Error('TEST FIXTURE: launch must not call the API here'); };
    const opts = { root, real: DAYTIME, api, git: cleanGit, ledgerFactory: () => fakeLedger(), trial: 'trial-0c', ...over };
    const saved = process.env.ANTHROPIC_API_KEY;
    let r;
    if (noKey) { delete process.env.ANTHROPIC_API_KEY; try { r = await N.launch(opts); } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; } }
    else r = await withKey(() => N.launch(opts));
    try {
      assert.strictEqual(r.ok, false, what);
      assert.match(r.why, re, what);
      assert.strictEqual(called, 0, `${what}: no call`);
      assert.ok(!fs.existsSync(path.join(root, TC.marker)) && !fs.existsSync(path.join(root, TC.lock)), `${what}: no marker, no lock`);
      assert.ok(!fs.existsSync(path.join(root, 'state/norns/trial-0c')), `${what}: nothing written`);
    } finally { done(root); }
  }
});

test('E H I: the full launch runs once, records the charter hash by code, seals PASS, and never launches again', async () => {
  const root = launchRoot();
  const sealed = sealedHashes(root), live = liveHashes(root);
  const { api, seen } = fakeApi();
  try {
    const r = await withKey(() => N.launch({ root, real: DAYTIME, api, git: cleanGit, ledgerFactory: () => fakeLedger(), trial: 'trial-0c' }));
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.verdict, 'PASS', JSON.stringify(r.reasons));
    assert.match(r.run, /^t0c-20261117-20261116t150000z$/);
    assert.strictEqual(seen.length, 22);
    const want = sha(path.join(SRC, 'TRIAL_0C.md'));
    const lock = fs.readFileSync(path.join(root, TC.lock), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(lock.length, 1);
    assert.strictEqual(lock[0].trial, 'trial-0c');
    assert.strictEqual(lock[0].hash, want, 'the hash is written by code from the file, never by hand');
    assert.strictEqual(lock[0].commit, 'abc123');
    assert.strictEqual(sha(path.join(root, `state/norns/charter/${want}.md`)), want, 'the charter copy is the signed bytes');
    assert.ok(N.lockCheck(root, 'trial-0c').ok);
    const v = JSON.parse(fs.readFileSync(path.join(root, TC.verdict), 'utf8'));
    assert.strictEqual(v.charter_hash, want);
    assert.strictEqual(v.commit, 'abc123');
    assert.strictEqual(v.choice_1, 'A');
    assert.deepStrictEqual(sealedHashes(root), sealed);
    assert.deepStrictEqual(liveHashes(root), live);
    const again = await withKey(() => N.launch({ root, real: DAYTIME, api, git: cleanGit, ledgerFactory: () => fakeLedger(), trial: 'trial-0c' }));
    assert.match(again.why, /already launched/);
    assert.strictEqual(seen.length, 22, 'the second launch called nothing');
    fs.appendFileSync(path.join(root, 'TRIAL_0C.md'), ' ');
    const after = N.lockCheck(root, 'trial-0c');
    assert.strictEqual(after.ok, false);
    assert.match(after.why, /charter changed/);
  } finally { done(root); }
});

// â”€â”€ H. The zero-call dry run, and what L5 watches â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test('H: the dry run makes zero model calls, reads no wall clock, and every build check is clean', () => {
  const root = fakeRoot();
  const sealed = sealedHashes(root);
  const RealDate = Date;
  class TrapDate extends RealDate {                                 // TEST FIXTURE: any wall-clock read throws
    constructor(...a) { if (!a.length) throw new Error('TEST FIXTURE: new Date() read the wall clock'); super(...a); }
    static now() { throw new Error('TEST FIXTURE: Date.now() read the wall clock'); }
  }
  let s;
  global.Date = TrapDate;
  try { s = N.dryRun0c({ root, srcRoot: SRC, real: steppingReal('2026-11-16T15:00:00Z'), trial: 'trial-0c' }); }
  finally { global.Date = RealDate; }
  try {
    assert.strictEqual(s.model_calls, 0);
    assert.strictEqual(s.calls_planned, 22);
    assert.ok(s.open_gate.ok, 'open-gate check');
    assert.strictEqual(s.open_gate.stamp_self_check, true, 'L7 catches a shifted or missing stamp');
    assert.ok(s.replay.match && s.replay.compared === 21 && s.replay.stamps_compared > 0, 'seed replay');
    assert.deepStrictEqual(s.build_checks, { ...s.build_checks, L1: 0, L1b: 0, L2: 0, L3: 0, L6: 0, L7: 0 });
    assert.strictEqual(s.canary_visible_from_turn, CANARY_TURN);
    assert.strictEqual(s.canary_turns, 21 - CANARY_TURN + 1);
    assert.ok(s.fuse.fits, `worst case $${s.fuse.worst_run_usd} under the $0.25 fuse`);
    assert.ok(s.preflight.ok);
    const dry = fs.readFileSync(path.join(root, TC.dryLog), 'utf8').trim().split('\n');
    assert.strictEqual(dry.length, 1);
    assert.ok(fs.existsSync(path.join(root, `${TC.dryDir}/${s.label}-prompts.json`)));
    assert.deepStrictEqual(sealedHashes(root), sealed);
    assert.ok(!fs.existsSync(path.join(root, TC.verdict)), 'a dry run is never graded');
  } finally { done(root); }
});

test('H: L5 watches the live files and every sealed 0 and 0b path, and none of 0c\'s own', () => {
  const root = fakeRoot();
  try {
    const w = N.watched0c(root);
    const covered = p => w.some(x => p === x || p.startsWith(x + '/'));
    for (const [p] of LIVE) assert.ok(covered(p), p);
    for (const p of SEALED) assert.ok(covered(p), p);
    assert.ok(!w.some(x => x.includes('trial-0c')), 'trial-0c files are its own, not watched');
  } finally { done(root); }
});

test('H: the build\'s four choices where the charter is silent are declared in every run record and dry run', async () => {
  assert.strictEqual(N.DECLARED_0C.length, 4);
  for (const word of ['Benchmark stamp', 'Quiet', 'Where reply notes show', 'Stamp line'])
    assert.ok(N.DECLARED_0C.some(d => d.startsWith(`${word}:`)), word);
  const { root, runId } = await run0c();
  try {
    const start = recordsOf(root, runId).rows.find(r => r.kind === 'start');
    assert.deepStrictEqual(start.declared_build_choices, [...N.DECLARED_0C]);
    const s = N.dryRun0c({ root, srcRoot: SRC, real: steppingReal('2026-11-16T16:00:00Z'), trial: 'trial-0c' });
    assert.deepStrictEqual(s.declared_build_choices, N.DECLARED_0C);
  } finally { done(root); }
});
