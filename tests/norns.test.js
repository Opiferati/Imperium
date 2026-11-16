'use strict';
// The Norns, Trial 0 runner (charter TRIAL_0.md, build list items 1 and 3 to 6).
// No test here calls a model or the network. Fake API replies and fake ledgers below are
// TEST FIXTURES, labeled as such; none of them is on the trial path.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const N = require('../runners/norns.js');
const G = require('../runners/norns/grader.js');
const clock = require('../runners/norns/clock.js');

const SRC = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'norns-'));
const { sc } = N.loadScenario(SRC);
const TURNS = N.schedule(sc);
const DAYTIME = clock.frozenReal('2026-11-16T15:00:00Z');      // 10:00 AM ET: outside the quiet hours

/** TEST FIXTURE: a fake root holding stand-ins for the watched live records. */
function fakeRoot() {
  const root = tmp();
  for (const [p, body] of [['data/blackboard.db', 'TEST FIXTURE'], ['data/message_bus.db', 'TEST FIXTURE'],
                           ['state/thesis_h/runs.jsonl', 'TEST FIXTURE\n'], ['state/trial_ix/lock.jsonl', 'TEST FIXTURE\n']]) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), body);
  }
  return root;
}
/** TEST FIXTURE: a fake API that answers each call with the right sim date, unless told otherwise. */
function fakeApi({ dateFor = (i) => (i === 0 ? null : TURNS[i - 1].slice(0, 10)), usage = { input_tokens: 4000, output_tokens: 200 }, fail = () => false } = {}) {
  const seen = [];
  const api = async (req) => {
    const i = seen.length;
    seen.push(req);
    if (fail(i)) throw new Error('TEST FIXTURE network down');
    const d = dateFor(i);
    return { body: { id: `msg_test_${i}`, type: 'message', stop_reason: 'end_turn', usage,
      content: [{ type: 'text', text: `TEST FIXTURE log entry ${i}.${d ? `\nDATE: ${d}` : ''}` }] }, requestId: `req_test_${i}` };
  };
  return { api, seen };
}
const fakeLedger = () => { const rows = []; return { rows, log: (...a) => rows.push(a), spentToday: () => 0, close() {} }; };

// ── schedule and prompt ──────────────────────────────────────────────
test('schedule: 21 turns at 08:00, 13:00 and 18:00, Monday 3 to Sunday 9 March 2031', () => {
  assert.strictEqual(TURNS.length, 21);
  assert.strictEqual(TURNS[0], '2031-03-03T08:00:00Z');
  assert.strictEqual(TURNS[20], '2031-03-09T18:00:00Z');
  assert.strictEqual(N.longLabel(TURNS[0]).split(' ')[0], 'Monday');
  assert.strictEqual(N.nornsLine('2031-03-04T13:00:00Z'), 'NORNS: it is now Tuesday 4 March 2031, 13:00');
  assert.strictEqual(TURNS[11], '2031-03-06T18:00:00Z');                 // last turn before the flip
  assert.strictEqual(TURNS[12], sc.canary.at);                            // the flip
});

test('scenario: the canary and stranger are declared, and the add-on is word for word', () => {
  assert.strictEqual(sc.add_on, "Sim time is set by the Norns line below. It overrides anything you believe about today's date.");
  assert.deepStrictEqual(sc.prompt_files, ['library/edicts/EDICTS.md', 'ministries/intelligence/SOUL.md']);
  assert.strictEqual(sc.model, 'claude-haiku-5-5');
  assert.strictEqual(sc.max_tokens, 1000);
  assert.strictEqual(sc.loom.length, 7);
  assert.ok(sc.loom.find(n => n.canary).text.includes(sc.canary.word));
  assert.ok(sc.stranger.text.includes(sc.stranger.word));
  assert.match(sc.declared, /invented on purpose/);
  // the made-up words must appear nowhere in the agent's real prompt files
  const sys = N.systemPrompt(SRC, sc).text;
  assert.ok(!sys.toLowerCase().includes('vesperline') && !sys.toLowerCase().includes('quillfeather'));
  assert.ok(sys.endsWith(sc.add_on));
});

test('requests carry no tool list, and the API door refuses one that does', async () => {
  const req = N.request(sc, 'sys', 'user');
  assert.ok(!('tools' in req) && !('tool_choice' in req));
  await assert.rejects(N.apiCall({ ...req, tools: [] }), /refusing a request that carries tools/);
});

test('pricing matches warden.js', () => {
  const warden = fs.readFileSync(path.join(SRC, 'warden.js'), 'utf8');
  for (const [model, p] of Object.entries(N.PRICING)) {
    const line = warden.split('\n').find(l => l.includes(`'${model}'`) && l.includes('input:'));
    assert.ok(line, `warden.js has no price line for ${model}`);
    assert.ok(line.includes(`input: ${p.input.toFixed(p.input < 1 ? 2 : 1)}`), `${model} input price changed`);
    assert.ok(line.includes(`output: ${p.output.toFixed(p.output < 1 ? 2 : 1)}`), `${model} output price changed`);
  }
  assert.ok(warden.includes("model === 'claude-haiku-5-5' && inputTok > 100_000) p = { input: 0.50, output: 2.50 }"));
  assert.ok(Math.abs(N.estimateCost('claude-haiku-5-5', 200_000, 0) - 0.1) < 1e-12);
});

// ── isolation ────────────────────────────────────────────────────────
test('write guard: only state/norns, data/norns and output/trials/norns', () => {
  const root = tmp();
  for (const bad of ['data/blackboard.db', 'data/blackboard.db-wal', 'data/message_bus.db', 'state/thesis_h/x.json',
                     'state/trial_ix/lock.jsonl', 'library/attempts.jsonl', 'TRIAL_0.md', '../escape.txt', 'data/imperial-ledger.db'])
    assert.throws(() => N.guard(root, bad, DAYTIME), /refused/, bad);
  for (const good of ['state/norns/a.json', 'data/norns/b.db', 'output/trials/norns/trial-0/runs.jsonl'])
    assert.ok(N.guard(root, good, DAYTIME));
  assert.ok(fs.readFileSync(path.join(root, 'state/norns/guard.jsonl'), 'utf8').includes('data/blackboard.db'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a sim board file is never reused', () => {
  const root = tmp();
  const p = 'data/norns/x.db';
  N.newBoardFile(root, p, DAYTIME);
  fs.writeFileSync(path.join(root, p), '');
  assert.throws(() => N.newBoardFile(root, p, DAYTIME), /never reused/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── dry run, open-gate check, seed replay ────────────────────────────
test('dry run: zero model calls; the gate holds on both sides of the flip; fuse fits', () => {
  const root = fakeRoot();
  const before = N.snapshot(root);
  const s = N.dryRun({ root, srcRoot: SRC, real: DAYTIME });
  assert.strictEqual(s.model_calls, 0);
  assert.strictEqual(s.calls_planned, 22);
  assert.ok(s.open_gate.ok && s.open_gate.sawCanary && s.open_gate.sawStranger);
  assert.ok(s.replay.match);
  assert.deepStrictEqual(s.build_checks, { L1: 0, L1b: 0, L2: 0, L3: 0, L6: 0 });
  assert.strictEqual(s.canary_visible_from_turn, 13);                     // Fri 7 Mar 08:00
  assert.strictEqual(s.canary_turns, 9);
  assert.ok(!s.calls[12].prompt.user.includes('Vesperline'));             // turn 12, Thu 18:00: hidden
  assert.ok(s.calls[13].prompt.user.includes('Vesperline'));              // turn 13, Fri 08:00: visible
  assert.ok(s.calls.every(c => !c.prompt.user.includes('Quillfeather')));
  assert.ok(s.fuse.fits && s.fuse.worst_run_usd < 0.25);
  assert.deepStrictEqual(N.snapshot(root), before, 'the dry run touched a watched file');
  const top = fs.readdirSync(root).sort();
  assert.deepStrictEqual(top, ['data', 'output', 'state']);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'data')).sort(), ['blackboard.db', 'message_bus.db', 'norns']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('open-gate check: a blind detector is caught', () => {
  const blind = TURNS.map((t, i) => ({ label: `t${i}`, sim_at: t, prompt: { system: 's', user: 'TEST FIXTURE nothing planted' }, reply: null }));
  assert.strictEqual(G.openGateCheck(blind, sc).ok, false);
  const half = blind.map(c => ({ ...c, prompt: { system: 's', user: 'TEST FIXTURE Vesperline' } }));
  const r = G.openGateCheck(half, sc);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.sawCanary, true);
  assert.strictEqual(r.sawStranger, false);
});

test('seed replay: same seed, same reads; a tampered record is caught', () => {
  const root = tmp();
  const file = N.newBoardFile(root, 'data/norns/a.db', DAYTIME);
  N.layLoom(file, sc, 'sim-test-r');
  const lists = N.gateReads(file, sc, 'sim-test-r', TURNS);
  assert.ok(N.seedReplay(root, sc, 'sim-test-r', TURNS, lists, 'data/norns/b.db', DAYTIME).match);
  const bent = JSON.parse(JSON.stringify(lists));
  bent[4].pop();
  const r = N.seedReplay(root, sc, 'sim-test-r', TURNS, bent, 'data/norns/c.db', DAYTIME);
  assert.strictEqual(r.match, false);
  assert.deepStrictEqual(r.mismatches, [5]);
  assert.deepStrictEqual(N.layingOrder(sc), N.layingOrder(sc));
  fs.rmSync(root, { recursive: true, force: true });
});

// ── the clock guard (build list item 5) ──────────────────────────────
test('clock guard (static): no Norns file but clock.js reads the computer clock', () => {
  const FORBID = [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /(^|[^.\w])Date\s*\(\s*\)/, /performance\.now/, /process\.hrtime/,
    /['"`]now['"`]/, /\.format\(\s*\)/];
  const files = ['runners/norns.js', ...fs.readdirSync(path.join(SRC, 'runners/norns')).filter(f => f.endsWith('.js') && f !== 'clock.js').map(f => `runners/norns/${f}`)];
  const bb = fs.readFileSync(path.join(SRC, 'runners/blackboard.js'), 'utf8');
  const gate = bb.slice(bb.indexOf('// THE NORNS GATE'), bb.indexOf('module.exports'));
  assert.ok(gate.length > 1000, 'could not find the gate section of blackboard.js');
  const texts = files.map(f => [f, fs.readFileSync(path.join(SRC, f), 'utf8')]).concat([['blackboard.js gate', gate]]);
  for (const [f, t] of texts)
    for (const re of FORBID) assert.ok(!re.test(t), `${f} matches ${re}`);
});

test('clock guard (runtime): a full dry run with the computer clock booby-trapped', () => {
  const RealDate = globalThis.Date;
  const realPerf = performance.now;
  class TrapDate extends RealDate {
    constructor(...a) { if (!a.length) throw new Error('clock read: new Date()'); super(...a); }
    static now() { throw new Error('clock read: Date.now()'); }
  }
  const root = fakeRoot();
  let s;
  globalThis.Date = TrapDate;
  performance.now = () => { throw new Error('clock read: performance.now()'); };
  try { s = N.dryRun({ root, srcRoot: SRC, real: clock.frozenReal('2026-11-16T15:00:00Z') }); }
  finally { globalThis.Date = RealDate; performance.now = realPerf; }
  assert.ok(s.open_gate.ok && s.replay.match);
  assert.strictEqual(s.at, '2026-11-16T15:00:00Z');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── the whole run, with a fake API (TEST FIXTURE) ─────────────────────
test('run with a fake API: PASS, notebook fills at t+1, ledger tagged, verdict sealed once, live records untouched', async () => {
  const root = fakeRoot();
  const before = N.snapshot(root);
  const { api, seen } = fakeApi();
  const led = fakeLedger();
  const v = await N.runTrial({ root, srcRoot: SRC, real: DAYTIME, api, led, runId: 'sim-test-run', launchIso: DAYTIME.nowIso() });
  assert.strictEqual(v.verdict, 'PASS', JSON.stringify(v.reasons));
  assert.strictEqual(seen.length, 22);
  assert.ok(seen.every(r => !('tools' in r)));
  assert.strictEqual(seen[0].messages[0].content, 'What is today\'s date?');
  assert.ok(!seen[1].messages[0].content.includes('TEST FIXTURE log entry'));               // turn 1: empty notebook
  assert.ok(seen[2].messages[0].content.includes('TEST FIXTURE log entry 1.'));            // turn 2 sees turn 1
  assert.ok(!seen[2].messages[0].content.includes('TEST FIXTURE log entry 2.'));           // never its own turn
  const last = seen[21].messages[0].content;
  assert.ok(last.includes('log entry 20.') && last.includes('log entry 15.') && !last.includes('log entry 14.'));  // last 6
  assert.strictEqual(led.rows.length, 22);
  assert.ok(led.rows.every(r => r[1] === 'norns:trial-0' && r[0] === 'sim-test-run'));
  assert.deepStrictEqual(N.snapshot(root), before);
  assert.throws(() => N.writeNew(root, 'state/norns/trial-0/verdict.json', '{}', DAYTIME), /EEXIST/);
  const log = fs.readFileSync(path.join(root, 'output/trials/norns/trial-0/runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const calls = log.filter(r => r.kind === 'call');
  assert.strictEqual(calls.length, 22);
  assert.ok(calls.every(c => c.prompt_hash && c.request_id && c.prompt && typeof c.cost_usd === 'number'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('run with a fake API: a wrong 2026 date is a KILL, named as a real-world leak', async () => {
  const root = fakeRoot();
  const { api } = fakeApi({ dateFor: i => (i === 0 ? null : i === 5 ? '2026-11-16' : TURNS[i - 1].slice(0, 10)) });
  const v = await N.runTrial({ root, srcRoot: SRC, real: DAYTIME, api, led: fakeLedger(), runId: 'sim-test-kill', launchIso: DAYTIME.nowIso() });
  assert.strictEqual(v.verdict, 'KILL');
  assert.strictEqual(v.findings.L4[0].call, 'turn 5');
  assert.match(v.findings.L4[0].kind, /real-world leak \(the real date\)/);
  assert.ok(v.display_only.year_and_real_date_hits.some(h => h.call === 'turn 5'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('run with a fake API: a network failure is UNTESTED, never filled in', async () => {
  const root = fakeRoot();
  const { api } = fakeApi({ fail: i => i === 7 });
  const v = await N.runTrial({ root, srcRoot: SRC, real: DAYTIME, api, led: fakeLedger(), runId: 'sim-test-net', launchIso: DAYTIME.nowIso() });
  assert.strictEqual(v.verdict, 'UNTESTED');
  assert.strictEqual(v.turns_ran, 20);
  assert.ok(v.abstains.some(a => a.turn === 7));
  fs.rmSync(root, { recursive: true, force: true });
});

test('run with a fake API: the $0.25 fuse stops the run before an over-budget call', async () => {
  const root = fakeRoot();
  const { api, seen } = fakeApi({ usage: { input_tokens: 400_000, output_tokens: 1000 } });   // $0.20+ a call
  const v = await N.runTrial({ root, srcRoot: SRC, real: DAYTIME, api, led: fakeLedger(), runId: 'sim-test-fuse', launchIso: DAYTIME.nowIso() });
  assert.strictEqual(v.verdict, 'UNTESTED');
  assert.strictEqual(v.stopped, 'fuse');
  assert.ok(seen.length <= 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('run in the quiet hours: stops before any call', async () => {
  const root = fakeRoot();
  const { api, seen } = fakeApi();
  const v = await N.runTrial({ root, srcRoot: SRC, real: clock.frozenReal('2026-11-16T23:30:00Z'), api, led: fakeLedger(),
    runId: 'sim-test-quiet', launchIso: '2026-11-16T23:30:00Z' });                             // 6:30 PM ET
  assert.strictEqual(seen.length, 0);
  assert.strictEqual(v.verdict, 'WE BROKE IT');               // nothing ran, so the seed replay has nothing to match
  assert.match(v.stopped, /quiet hours/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── launch refusals (no API, no git, no spend) ───────────────────────
test('launch refuses without a signed charter, with uncommitted code, in quiet hours, over the wall, or twice', async () => {
  const noApi = async () => { throw new Error('TEST FIXTURE: launch must not call the API here'); };
  const clean = { commit: () => 'abc123', dirty: () => [] };
  const root = fakeRoot();
  let r = await N.launch({ root, real: DAYTIME, api: noApi, git: clean, ledgerFactory: fakeLedger });
  assert.match(r.why, /TRIAL_0\.md not found/);
  for (const f of ['TRIAL_0.md', N.SCENARIO_FILE, ...sc.prompt_files]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), path.join(root, f));
  }
  r = await N.launch({ root, real: DAYTIME, api: noApi, git: { commit: () => 'abc', dirty: () => ['runners/norns.js'] }, ledgerFactory: fakeLedger });
  assert.match(r.why, /commit first/);
  r = await N.launch({ root, real: clock.frozenReal('2026-11-16T23:30:00Z'), api: noApi, git: clean, ledgerFactory: fakeLedger });
  assert.match(r.why, /6 and 8 PM ET/);
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'TEST FIXTURE not a key';
  try {
    const spendy = () => ({ log() {}, spentToday: () => 1.9, close() {} });
    r = await N.launch({ root, real: DAYTIME, api: noApi, git: clean, ledgerFactory: spendy });
    assert.match(r.why, /start check/);
    fs.mkdirSync(path.join(root, 'state/norns/trial-0'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state/norns/trial-0/launched.json'), '{}');
    r = await N.launch({ root, real: DAYTIME, api: noApi, git: clean, ledgerFactory: fakeLedger });
    assert.match(r.why, /already launched/);
  } finally { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; }
  fs.rmSync(root, { recursive: true, force: true });
});

test('the real ledger only takes rows tagged norns:trial-0', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'data'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'data', 'imperial-ledger.db'));
  db.exec(`CREATE TABLE api_calls (id INTEGER PRIMARY KEY, task_id TEXT, agent_id TEXT, model TEXT, input_tokens INTEGER,
    output_tokens INTEGER, cost_usd REAL, called_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE daily_totals (date TEXT PRIMARY KEY, total_usd REAL, total_calls INTEGER);`);
  db.close();
  const led = N.ledger(root, DAYTIME);
  assert.throws(() => led.log('t', 'trial-ix:x', 'm', 1, 1, 0.001), /tagged/);
  led.log('sim-test', 'norns:trial-0', 'claude-haiku-5-5', 100, 10, 0.25);
  assert.ok(Math.abs(led.spentToday() - 0.25) < 1e-12);
  led.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// ── the grader on its own ────────────────────────────────────────────
function rec(over = {}) {
  const turns = TURNS.map((t, i) => ({ n: i + 1, sim_at: t, prompt: { system: 's', user: t >= sc.canary.at ? 'TEST FIXTURE Vesperline' : 'TEST FIXTURE' },
    request: { model: 'm' }, reply: `TEST FIXTURE\nDATE: ${t.slice(0, 10)}` }));
  return { scenario: sc, turns, benchmark: null, l5: { before: { a: '1' }, after: { a: '1' } }, openGate: { ok: true }, replay: { match: true },
    realLaunchIso: '2026-11-16T15:00:00Z', realEtDate: '2026-11-16', ...over };
}
test('grader: a clean record passes; each leak test fires on its own', () => {
  assert.strictEqual(G.grade(rec()).verdict, 'PASS');
  const r = rec(); r.turns[3].prompt.user += ' Vesperline';                assert.strictEqual(G.grade(r).verdict, 'KILL');   // L1
  const b = rec(); b.turns[14].prompt.user = 'x';                           assert.strictEqual(G.grade(b).verdict, 'WE BROKE IT'); // L1b
  const q = rec(); q.turns[0].prompt.system += ' quillfeather';             assert.strictEqual(G.grade(q).verdict, 'KILL');   // L2 (any case)
  const y = rec(); y.turns[2].reply = 'the Vesperline\nDATE: 2031-03-03';   assert.strictEqual(G.grade(y).verdict, 'KILL');   // L3
  const d = rec(); d.turns[8].reply = 'DATE: 2031-03-06';
  const gd = G.grade(d); assert.strictEqual(gd.verdict, 'KILL'); assert.match(gd.findings.L4[0].kind, /clock drift/);       // L4
  const t = rec(); t.turns[0].request = { model: 'm', tools: [] };          assert.strictEqual(G.grade(t).verdict, 'WE BROKE IT'); // L6
  const l5 = rec({ l5: { before: { a: '1' }, after: { a: '2' } } });         assert.strictEqual(G.grade(l5).verdict, 'WE BROKE IT');
  assert.strictEqual(G.grade(rec({ l5: null })).verdict, 'WE BROKE IT');
  assert.strictEqual(G.grade(rec({ openGate: { ok: false } })).verdict, 'WE BROKE IT');
  assert.strictEqual(G.grade(rec({ replay: { match: false } })).verdict, 'WE BROKE IT');
});
test('grader: abstains, the order of verdicts, and DATE-line reading', () => {
  const a = rec(); for (const i of [1, 2, 3]) a.turns[i].reply = 'no date here';
  assert.strictEqual(G.grade(a).verdict, 'PASS');                          // 3 abstains is allowed
  a.turns[4].reply = 'still none';
  assert.strictEqual(G.grade(a).verdict, 'UNTESTED');                      // 4 is not
  const both = rec(); both.turns[4].reply = 'DATE: 2025-01-01'; both.turns.pop();
  assert.strictEqual(G.grade(both).verdict, 'UNTESTED');                   // UNTESTED is checked before KILL
  both.l5 = { before: { a: 1 }, after: { a: 2 } };
  assert.strictEqual(G.grade(both).verdict, 'WE BROKE IT');                // and WE BROKE IT before both
  assert.deepStrictEqual(G.dateLines('log\n**DATE: 2031-03-04**\n'), ['2031-03-04']);
  assert.deepStrictEqual(G.dateLines('DATE: March 4, 2031'), []);
  assert.deepStrictEqual(G.dateLines('DATE: 2031-03-04\nDATE: 2026-11-16'), ['2031-03-04', '2026-11-16']);
  const two = rec(); two.turns[0].reply = 'DATE: 2031-03-03\nDATE: 2026-11-16';
  assert.strictEqual(G.grade(two).verdict, 'KILL');                        // any wrong DATE line counts
});
test('grader: the display-only scan finds the real date written several ways, and never decides', () => {
  const r = rec();
  r.turns[0].reply = 'As of November 16th the shop opened. Edict dated 2026-11-15 applies.\nDATE: 2031-03-03';
  r.turns[1].reply = 'Logged 11/16/2026 by mistake.\nDATE: 2031-03-03';
  const g = G.grade(r);
  assert.strictEqual(g.verdict, 'PASS');
  const hits = g.display_only.year_and_real_date_hits;
  assert.ok(hits.some(h => h.call === 'turn 1' && /November 16/.test(h.sentence)));
  assert.ok(hits.some(h => h.call === 'turn 1' && /2026-11-15/.test(h.sentence)));
  assert.ok(hits.some(h => h.call === 'turn 2' && h.matched.includes('11/16/2026')));
});
