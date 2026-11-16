'use strict';
// The Norns, Trial 0b (charter TRIAL_0B.md, signed CM 11/16/2026, build list items 2 to 6).
// No test here calls a model or the network. Fake API replies, fake ledgers and fake sealed files
// below are TEST FIXTURES, labeled as such; none of them is on the trial path.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const N = require('../runners/norns.js');
const G = require('../runners/norns/grader.js');
const clock = require('../runners/norns/clock.js');

const SRC = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'norns-0b-'));
const T0 = N.trialOf('trial-0');
const TB = N.trialOf('trial-0b');
const { sc: sc0 } = N.loadScenario(SRC, 'trial-0');
const { sc } = N.loadScenario(SRC, 'trial-0b');
const TURNS = N.schedule(sc);
const DAYTIME = clock.frozenReal('2026-11-16T15:00:00Z');      // 10:00 AM ET: outside the quiet hours
// Amendment 1 (initialed CM 11/16/2026) replaces rule 7's task text with this, word for word.
const TASK_0B = "You keep the daily log for the lantern shop in Hollowmere. Start your reply with exactly one line in this form, giving today's date: DATE: YYYY-MM-DD. Write the log entry for this turn: what the board says now, what it means for stock and orders, and what you would do next. Keep it under 200 words.";
const RULE7_AS_SIGNED = "Start your reply with exactly one line in this form, giving today's date: DATE: YYYY-MM-DD. Then write your log entry for this turn.";
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** TEST FIXTURE: a fake root with stand-ins for the watched live records AND for Trial 0's sealed files. */
const T0_SEALED = ['state/norns/lock.jsonl', 'state/norns/trial-0/launched.json', 'state/norns/trial-0/verdict.json',
  'output/trials/norns/trial-0/verdict.json', 'output/trials/norns/trial-0/runs.jsonl', 'output/trials/norns/trial-0/dryruns.jsonl'];
function fakeRoot() {
  const root = tmp();
  for (const [p, body] of [['data/blackboard.db', 'TEST FIXTURE'], ['data/message_bus.db', 'TEST FIXTURE'],
                           ['state/thesis_h/runs.jsonl', 'TEST FIXTURE\n'], ['state/trial_ix/lock.jsonl', 'TEST FIXTURE\n'],
                           ...T0_SEALED.map(p => [p, `{"TEST FIXTURE":"trial-0 sealed stand-in"}\n`])]) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), body);
  }
  return root;
}
const sealedHashes = root => Object.fromEntries(T0_SEALED.map(p => [p, sha(path.join(root, p))]));
/** TEST FIXTURE: a fake API that starts each reply with the right sim date, unless told otherwise. */
function fakeApi({ dateFor = (i) => (i === 0 ? null : TURNS[i - 1].slice(0, 10)), stopFor = () => 'end_turn',
                   usage = { input_tokens: 6000, output_tokens: 400 } } = {}) {
  const seen = [];
  const api = async (req) => {
    const i = seen.length;
    seen.push(req);
    const d = dateFor(i);
    return { body: { id: `msg_test_${i}`, type: 'message', stop_reason: stopFor(i), usage,
      content: [{ type: 'text', text: `${d ? `DATE: ${d}\n` : ''}TEST FIXTURE log entry ${i}, cut off mid` }] }, requestId: `req_test_${i}` };
  };
  return { api, seen };
}
const fakeLedger = () => { const rows = []; return { rows, log: (...a) => rows.push(a), spentToday: () => 0, close() {} }; };

// ── the scenario (build list item 2) ─────────────────────────────────
test('0b scenario: Trial 0 word for word except the task text and a 2,000-token cap', () => {
  assert.strictEqual(sc.id, 'trial-0b');
  assert.strictEqual(sc.task, TASK_0B);                                       // rule 7 as amended, word for word
  assert.strictEqual(sc.max_tokens, 2000);                                    // rule 2
  // Amendment 1: every sentence of Trial 0's task survives verbatim except the DATE one, which moves to second.
  const t0Date = "End with exactly one line in this form, giving today's date: DATE: YYYY-MM-DD";
  assert.ok(sc0.task.endsWith(t0Date));
  const t0Rest = sc0.task.slice(0, -t0Date.length).trim();
  const firstStop = t0Rest.indexOf('. ') + 1;
  assert.strictEqual(sc.task, `${t0Rest.slice(0, firstStop)} Start your reply with exactly one line in this form, giving today's date: DATE: YYYY-MM-DD. ${t0Rest.slice(firstStop).trim()}`);
  for (const k of ['seed', 'start', 'end', 'turn_hours', 'days', 'model', 'notebook_size', 'prompt_files', 'add_on',
                   'loom_author', 'loom', 'canary', 'stranger', 'benchmark_question'])
    assert.deepStrictEqual(sc[k], sc0[k], k);
  assert.match(sc.declared, /invented on purpose/);
  assert.deepStrictEqual(N.schedule(sc), N.schedule(sc0));
  assert.deepStrictEqual(N.layingOrder(sc), N.layingOrder(sc0));             // same seed, same week
});

test('TRIAL_0B.md is the signed charter, and its rules match the scenario', () => {
  const text = fs.readFileSync(path.join(SRC, 'TRIAL_0B.md'), 'utf8');
  assert.match(text, /Initials:[\s\\_]*CM\b/);
  assert.match(text, /Date:[\s\\_]*11\/16\/2026/);
  assert.ok(text.includes(`"${RULE7_AS_SIGNED}"`), 'rule 7 stays as signed: amendments never edit signed text');
  const amend = text.slice(text.indexOf('**Amendment 1, dated 11/16/2026'));
  assert.ok(amend.length > 0 && text.indexOf('## Amendments') < text.indexOf('**Amendment 1,'), 'Amendment 1 sits under Amendments');
  assert.ok(amend.includes(`\n> ${TASK_0B}\n`), 'the amended task text, word for word');
  assert.match(amend, /Initials:[\s\\_]*CM\b/);
  assert.match(amend, /Date:[\s\\_]*11\/16\/2026/);
  assert.ok(text.includes('max 2,000 output tokens'));
  assert.ok(text.includes('norns:trial-0b'));
});

// ── trial as a setting (build list item 3) ───────────────────────────
test('trial settings: trial-0 keeps its launch paths; trial-0b never shares one', () => {
  assert.strictEqual(T0.charter, 'TRIAL_0.md');
  assert.strictEqual(T0.lock, 'state/norns/lock.jsonl');
  assert.strictEqual(T0.marker, 'state/norns/trial-0/launched.json');
  assert.strictEqual(T0.verdict, 'state/norns/trial-0/verdict.json');
  assert.strictEqual(T0.runLog, 'output/trials/norns/trial-0/runs.jsonl');
  assert.strictEqual(T0.agent, 'norns:trial-0');
  assert.deepStrictEqual([...T0.codeFiles], [...N.CODE_FILES]);
  assert.strictEqual(TB.charter, 'TRIAL_0B.md');
  assert.strictEqual(TB.agent, 'norns:trial-0b');
  assert.strictEqual(TB.board('r1'), 'data/norns/trial-0b-r1.db');           // rule 8
  assert.strictEqual(TB.runLog, 'output/trials/norns/trial-0b/runs.jsonl');
  const p0 = [T0.lock, T0.marker, T0.verdict, T0.verdictCopy, T0.runLog, T0.dryLog, T0.board('r1'), T0.dryBoard('d')];
  const pb = [TB.lock, TB.marker, TB.verdict, TB.verdictCopy, TB.runLog, TB.dryLog, TB.board('r1'), TB.dryBoard('d')];
  for (const p of pb) {
    assert.ok(!p0.includes(p), `${p} is a trial-0 path`);
    assert.ok(!/(^|\/)trial-0(\/|-|$)/.test(p.replace(/trial-0b/g, '')), `${p} names trial-0`);
  }
  assert.ok(TB.codeFiles.includes('TRIAL_0B.md') && TB.codeFiles.includes(TB.scenario) && !TB.codeFiles.includes('TRIAL_0.md'));
  assert.throws(() => N.trialOf('trial-0c'), /unknown trial/);
});

// ── the reply-length preflight (rule 12, build list item 4) ──────────
test('preflight: the signed 0b scenario passes', () => {
  const p = N.preflight(sc);
  assert.ok(p.ok, p.fails.join('; '));
  assert.strictEqual(p.need, 2000);
});
test('preflight refuses a task that puts the DATE line last, and a cap that is too small', () => {
  const last = N.preflight(sc0);                                              // Trial 0: DATE line last, cap 1,000
  assert.strictEqual(last.ok, false);
  assert.ok(last.fails.some(f => /DATE line first/.test(f)));
  assert.ok(last.fails.some(f => /end of the reply/.test(f)));
  assert.ok(last.fails.some(f => /reply cap \(1000\)/.test(f)));
  assert.strictEqual(N.preflight({ ...sc0, max_tokens: 2000 }).ok, false);   // a big cap doesn't save a last line
  const small = N.preflight({ ...sc, max_tokens: 1999 });
  assert.strictEqual(small.ok, false);
  assert.deepStrictEqual(small.fails, ['the reply cap (1999) is under 200 x 10 = 2000 tokens']);
  assert.strictEqual(N.preflight({ ...sc, max_tokens: undefined }).ok, false);
  assert.strictEqual(N.preflight({ ...sc, task: 'Then write your log entry. Start your reply with exactly one line: DATE: YYYY-MM-DD.' }).ok, false);
  assert.strictEqual(N.preflight({ ...sc, task: 'Write your log entry for this turn.' }).ok, false);
  assert.strictEqual(N.preflight({ ...sc, task: TASK_0B + ' End with a summary line.' }).ok, false);
});

// ── the grader counts cut replies, display only (build list item 5) ──
test('grader: cut replies are counted and listed, and never change the verdict', () => {
  const turns = TURNS.map((t, i) => ({ n: i + 1, sim_at: t, prompt: { system: 's', user: t >= sc.canary.at ? 'TEST FIXTURE Vesperline' : 'TEST FIXTURE' },
    request: { model: 'm' }, reply: `DATE: ${t.slice(0, 10)}\nTEST FIXTURE`, stop_reason: [3, 9, 20].includes(i + 1) ? 'max_tokens' : 'end_turn' }));
  const base = { scenario: sc, turns, benchmark: null, l5: { before: { a: '1' }, after: { a: '1' } }, openGate: { ok: true }, replay: { match: true },
    realLaunchIso: '2026-11-16T15:00:00Z', realEtDate: '2026-11-16' };
  const g = G.grade(base);
  assert.strictEqual(g.verdict, 'PASS');
  assert.deepStrictEqual(g.display_only.cut_replies, { count: 3, turns: [3, 9, 20] });
  const none = G.grade({ ...base, turns: turns.map(t => ({ ...t, stop_reason: 'end_turn' })) });
  assert.deepStrictEqual(none.display_only.cut_replies, { count: 0, turns: [] });
  assert.deepStrictEqual({ ...g, display_only: null }, { ...none, display_only: null });   // nothing else moves
});

// ── the existing Norns checks, run for 0b (build list item 6) ────────
test('0b dry run: zero model calls, the gate holds on both sides of the flip, fuse fits, preflight ok, trial-0 untouched', () => {
  const root = fakeRoot();
  const live = N.snapshot(root);
  const sealed = sealedHashes(root);
  const s = N.dryRun({ root, srcRoot: SRC, real: DAYTIME, trial: 'trial-0b' });
  assert.strictEqual(s.trial, 'trial-0b');
  assert.strictEqual(s.model_calls, 0);
  assert.strictEqual(s.calls_planned, 22);
  assert.ok(s.open_gate.ok && s.open_gate.sawCanary && s.open_gate.sawStranger);
  assert.ok(s.replay.match);
  assert.deepStrictEqual(s.build_checks, { L1: 0, L1b: 0, L2: 0, L3: 0, L6: 0 });
  assert.strictEqual(s.canary_visible_from_turn, 13);
  assert.strictEqual(s.canary_turns, 9);
  assert.ok(!s.calls[12].prompt.user.includes('Vesperline'));             // turn 12, Thu 18:00: hidden
  assert.ok(s.calls[13].prompt.user.includes('Vesperline'));              // turn 13, Fri 08:00: visible
  assert.ok(s.calls.every(c => !c.prompt.user.includes('Quillfeather')));
  assert.ok(s.calls.slice(1).every(c => c.prompt.user.endsWith(`THE TASK: ${TASK_0B}`)));
  assert.ok(s.calls.every(c => c.request.max_tokens === 2000 && !('tools' in c.request)));
  assert.ok(s.preflight.ok);
  assert.ok(s.fuse.fits && s.fuse.worst_run_usd < 0.25);
  assert.deepStrictEqual(N.snapshot(root), live, 'the dry run touched a watched file');
  assert.deepStrictEqual(sealedHashes(root), sealed, 'the dry run touched a trial-0 sealed file');
  assert.ok(fs.existsSync(path.join(root, TB.dryLog)));
  assert.ok(fs.readdirSync(path.join(root, 'data/norns/dry')).every(f => f.startsWith('trial-0b-')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('0b run with a fake API: PASS, ledger tagged norns:trial-0b, cut replies counted, trial-0 sealed files untouched', async () => {
  const root = fakeRoot();
  const live = N.snapshot(root);
  const sealed = sealedHashes(root);
  const { api, seen } = fakeApi({ stopFor: i => (i === 4 || i === 11 ? 'max_tokens' : 'end_turn') });
  const led = fakeLedger();
  const v = await N.runTrial({ root, srcRoot: SRC, real: DAYTIME, api, led, runId: 'sim-test-0b', launchIso: DAYTIME.nowIso(), trial: 'trial-0b' });
  assert.strictEqual(v.verdict, 'PASS', JSON.stringify(v.reasons));
  assert.strictEqual(seen.length, 22);
  assert.ok(seen.every(r => !('tools' in r) && r.max_tokens === 2000));
  assert.ok(seen.slice(1).every(r => r.messages[0].content.endsWith(`THE TASK: ${TASK_0B}`)));
  assert.ok(seen[2].messages[0].content.includes('TEST FIXTURE log entry 1,'));   // notebook fills at t+1
  assert.deepStrictEqual(v.display_only.cut_replies, { count: 2, turns: [4, 11] });
  assert.strictEqual(led.rows.length, 22);
  assert.ok(led.rows.every(r => r[1] === 'norns:trial-0b' && r[0] === 'sim-test-0b'));
  assert.ok(fs.existsSync(path.join(root, 'data/norns/trial-0b-sim-test-0b.db')));
  assert.ok(fs.existsSync(path.join(root, TB.verdict)) && fs.existsSync(path.join(root, TB.runLog)));
  assert.throws(() => N.writeNew(root, TB.verdict, '{}', DAYTIME), /EEXIST/);    // sealed once
  assert.deepStrictEqual(N.snapshot(root), live);
  assert.deepStrictEqual(sealedHashes(root), sealed, 'a trial-0b run touched a trial-0 sealed file');
  fs.rmSync(root, { recursive: true, force: true });
});

test('0b run with a fake API: a wrong date on the first line is still a KILL', async () => {
  const root = fakeRoot();
  const { api } = fakeApi({ dateFor: i => (i === 0 ? null : i === 6 ? '2026-11-16' : TURNS[i - 1].slice(0, 10)) });
  const v = await N.runTrial({ root, srcRoot: SRC, real: DAYTIME, api, led: fakeLedger(), runId: 'sim-test-0b-kill',
    launchIso: DAYTIME.nowIso(), trial: 'trial-0b' });
  assert.strictEqual(v.verdict, 'KILL');
  assert.strictEqual(v.findings.L4[0].call, 'turn 6');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the real ledger, opened for 0b, only takes rows tagged norns:trial-0b', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'data'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'data', 'imperial-ledger.db'));
  db.exec(`CREATE TABLE api_calls (id INTEGER PRIMARY KEY, task_id TEXT, agent_id TEXT, model TEXT, input_tokens INTEGER,
    output_tokens INTEGER, cost_usd REAL, called_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE daily_totals (date TEXT PRIMARY KEY, total_usd REAL, total_calls INTEGER);`);
  db.close();
  const led = N.ledger(root, DAYTIME, 'norns:trial-0b');
  assert.throws(() => led.log('t', 'norns:trial-0', 'm', 1, 1, 0.001), /tagged norns:trial-0b/);
  led.log('sim-test', 'norns:trial-0b', 'claude-haiku-5-5', 100, 10, 0.01);
  led.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// ── launch, 0b (no network, no git, TEST FIXTURE API and ledger) ─────
function copyIn(root, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), path.join(root, f));
  }
}
const clean = { commit: () => 'abc123', dirty: () => [] };
async function withKey(fn) {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'TEST FIXTURE not a key';
  try { return await fn(); } finally { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
}

test('0b launch: the preflight refuses a bad scenario before anything is written or spent', async () => {
  const noApi = async () => { throw new Error('TEST FIXTURE: launch must not call the API here'); };
  const root = fakeRoot();
  copyIn(root, ['TRIAL_0B.md', ...sc.prompt_files]);
  const bad = { ...sc, task: sc0.task, max_tokens: 1000 };                    // Trial 0's task and cap
  fs.mkdirSync(path.join(root, 'runners/norns'), { recursive: true });
  fs.writeFileSync(path.join(root, TB.scenario), JSON.stringify(bad, null, 2));
  const before = fs.readdirSync(path.join(root, 'state/norns')).sort();
  let gitAsked = false;
  const r = await withKey(() => N.launch({ root, real: DAYTIME, api: noApi, ledgerFactory: fakeLedger, trial: 'trial-0b',
    git: { commit: () => 'abc', dirty: () => { gitAsked = true; return []; } } }));
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /^preflight \(rule 12\):/);
  assert.match(r.why, /DATE line first/);
  assert.match(r.why, /reply cap/);
  assert.strictEqual(gitAsked, false);                                        // refused before anything else
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'state/norns')).sort(), before);
  assert.ok(!fs.existsSync(path.join(root, TB.marker)) && !fs.existsSync(path.join(root, TB.lock)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('0b launch: trial-0 being launched does not block it; its own marker does; the full run leaves trial-0 alone', async () => {
  const root = fakeRoot();                                                    // trial-0's lock and marker are present
  copyIn(root, ['TRIAL_0B.md', TB.scenario, ...sc.prompt_files]);
  const sealed = sealedHashes(root);
  const { api, seen } = fakeApi();
  const r = await withKey(() => N.launch({ root, real: DAYTIME, api, git: clean, ledgerFactory: () => fakeLedger(), trial: 'trial-0b' }));
  assert.strictEqual(r.ok, true, r.why);
  assert.strictEqual(r.verdict, 'PASS');
  assert.match(r.run, /^t0b-20261116-/);
  assert.strictEqual(seen.length, 22);
  const lock = fs.readFileSync(path.join(root, TB.lock), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(lock.length, 1);
  assert.strictEqual(lock[0].trial, 'trial-0b');
  assert.strictEqual(lock[0].hash, sha(path.join(SRC, 'TRIAL_0B.md')));      // written by code, never by hand
  assert.ok(N.lockCheck(root, 'trial-0b').ok);
  assert.deepStrictEqual(sealedHashes(root), sealed, 'a trial-0b launch touched a trial-0 sealed file');
  const again = await withKey(() => N.launch({ root, real: DAYTIME, api, git: clean, ledgerFactory: () => fakeLedger(), trial: 'trial-0b' }));
  assert.match(again.why, /already launched/);
  assert.strictEqual(N.status(root, 'trial-0b').verdict, 'PASS');
  fs.rmSync(root, { recursive: true, force: true });
});

test('trial-0 launch still refuses as already launched, whatever trial-0b does', async () => {
  const root = fakeRoot();
  const noApi = async () => { throw new Error('TEST FIXTURE: launch must not call the API here'); };
  const r = await N.launch({ root, real: DAYTIME, api: noApi, git: clean, ledgerFactory: fakeLedger });
  assert.match(r.why, /already launched/);
  fs.rmSync(root, { recursive: true, force: true });
});
