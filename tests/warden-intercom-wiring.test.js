'use strict';
// Step 2: the Intercom wired into the Warden, DARK. warden.js cannot be started in a test -
// it opens the live databases and begins dispatching - so these assert the two things a test
// can honestly prove about it: that every use site sits behind the switch, and that the switch
// ships off. The behaviour itself is tested against the module in the other three files.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WARDEN = fs.readFileSync(path.join(ROOT, 'warden.js'), 'utf8');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'imperium-registry.json'), 'utf8'));

test('the switch is explicit, either way', () => {
  // 2026-11-11. This used to assert `enabled === false`, which pinned a DECISION
  // rather than an invariant — and the decision was reversed the moment the
  // Intercom was lit. A test that fails when you deliberately change your mind is
  // not protecting anything; it is just a second place to edit.
  //
  // What is worth pinning is that the state is never a GUESS: the key exists and
  // is a real boolean. A missing key and a false key read the same at a glance
  // and mean different things — one is a decision, the other is an oversight.
  assert.ok(REGISTRY.intercom, 'the key exists, so its state is never a guess');
  assert.strictEqual(typeof REGISTRY.intercom.enabled, 'boolean',
    'not a string, not undefined — the switch says plainly which way it is set');
});

test('the flag alone cannot open the Intercom', () => {
  // The real invariant, and the one that matters: enabled:true is necessary and
  // NOT sufficient. The Warden opens the Intercom only if the module loads AND
  // the switch is true AND Amendment 1 is initialed. Flipping a registry line
  // must never be able to route around a signature.
  assert.match(WARDEN, /ICOM_CONF\.enabled === true/,
    'the switch is checked by identity, so a truthy string cannot open it');
  assert.match(WARDEN, /amendment|amended/i,
    'and the amendment is checked too, in the same gate');
  const block = WARDEN.slice(WARDEN.indexOf('const ICOM_CONF'),
                             WARDEN.indexOf('const ICOM_CONF') + 1400);
  assert.ok(block.includes('Amendment 1 is not initialed'),
    'an uninitialed amendment keeps it dark and says so by name');
});

test('the Intercom block can reach what it reads at load time', () => {
  // Found by lighting it: the block reads MINISTRY_AGENTS for collectsFor, and the
  // const sat ~100 lines further down. A const is in the temporal dead zone until
  // its declaration runs, so open() threw every time and the Intercom reported
  // itself dark. 92 tests passed against the module; none booted the Warden.
  const decl  = WARDEN.indexOf('const MINISTRY_AGENTS');
  const reads = WARDEN.indexOf('...MINISTRY_AGENTS');
  assert.ok(decl !== -1 && reads !== -1, 'both the declaration and the use exist');
  assert.ok(decl < reads,
    'MINISTRY_AGENTS must be declared BEFORE the Intercom block that reads it — '
    + 'otherwise the Intercom cannot open at all, and says so only at boot');
});

test('nothing opens unless the switch is true AND the amendment is initialed', () => {
  const block = WARDEN.slice(WARDEN.indexOf('const ICOM_CONF'), WARDEN.indexOf('console.log(`Bus:'));
  assert.match(block, /ICOM_CONF\.enabled === true/, 'strictly true, not merely truthy');
  assert.match(block, /if \(!s\.ok\)/, 'an unsigned spec does not open');
  assert.match(block, /else if \(!s\.amended\)/, 'an uninitialed amendment does not open');
});

test('every Intercom use site is behind the switch', () => {
  // Each place the Warden touches the Intercom must be inside `if (icom && intercomMod)`.
  const guards = [...WARDEN.matchAll(/if \(icom && intercomMod\) \{/g)].map(m => m.index);
  assert.ok(guards.length >= 2, 'the ears site and the voice site');
  for (const m of WARDEN.matchAll(/icom\.(collect|acknowledge|send|hand|report|unheard)\(/g)) {
    const before = WARDEN.slice(0, m.index);
    const lastGuard = Math.max(...guards.filter(g => g < m.index), -1);
    assert.notStrictEqual(lastGuard, -1, `icom.${m[1]}() at ${m.index} is not behind a guard`);
    // the guard must still be open: no unguarded gap with its own closing brace at column 4
    assert.ok(before.length - lastGuard < 2500, `icom.${m[1]}() is too far from its guard to be inside it`);
  }
});

test('the banner states the Intercom either way, so its state is never assumed', () => {
  assert.match(WARDEN, /console\.log\(`Intercom: \$\{icom \? icomWhy : `dark - \$\{icomWhy\}`\}`\);/);
});

test('mail is handed before the model is called, and the voice is read after', () => {
  const handed = WARDEN.indexOf('icom.collect(msg.to_agent');
  const called = WARDEN.indexOf('await callAnthropic(model, systemProm');
  const voice  = WARDEN.indexOf('intercomMod.parseIcom(responseText)');
  assert.ok(handed > 0 && called > 0 && voice > 0, 'all three sites exist');
  assert.ok(handed < called, 'the mail must be in the prompt before the call');
  assert.ok(called < voice, 'the reply must exist before it is read');
});

test('the mail block reaches the prompt the agent is actually given', () => {
  // Prompt caching (2026-11-11) split the system prompt into a cached stable prefix and an
  // uncached tail. The mail MUST be in the tail: it changes every call, and anything that
  // changes inside the cached prefix means the cache never hits at all.
  assert.match(WARDEN, /const stableProm\s+= `\$\{EDICTS\}\\n\\n\$\{soul\}\$\{codexBlock\}`/);
  assert.match(WARDEN, /const volatileProm = `\$\{briefStr\}\$\{ravensBlock\}\$\{icomBlock\}`/);
  const stable = WARDEN.slice(WARDEN.indexOf('const stableProm'), WARDEN.indexOf('const volatileProm'));
  for (const v of ['icomBlock', 'ravensBlock', 'briefStr'])
    assert.ok(!stable.includes(v), `${v} changes every call and must not sit inside the cached prefix`);
  assert.match(WARDEN, /cache_control: \{ type: 'ephemeral' \}/);
  const blocks = WARDEN.slice(WARDEN.indexOf('const systemProm = ['), WARDEN.indexOf('const systemProm = [') + 400);
  assert.ok(blocks.indexOf('stableProm') < blocks.indexOf('volatileProm'), 'stable first, or nothing caches');
});

test('an Intercom petition is filed as its own kind, not disguised as a scope petition', () => {
  assert.match(WARDEN, /INSERT INTO petitions \(task_id, agent, request, kind\) VALUES \(\?, \?, \?, 'icom'\)/);
  assert.match(WARDEN, /ICOM-PETITION #\$\{pid\}/);
  assert.match(WARDEN, /Nothing was sent/, 'a petition sends nothing sideways');
});

test('a failure in the Intercom cannot take down a turn', () => {
  // Both sites catch and warn. A night must not be lost to the mail.
  const sites = WARDEN.split('if (icom && intercomMod) {').slice(1);
  for (const s of sites) assert.match(s.slice(0, 2500), /catch \(e\) \{ console\.warn/);
});

// -- the round trip the wiring performs, run against the real module ---------
test('a ministry turn, end to end: handed, acknowledged, answered', () => {
  const { intercom, mailBlock, parseIcom } = require('../runners/intercom.js');
  const ic = intercom(null, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-')), 'ic.db'),
    { amended: true, ranToday: () => true });
  const WORKS = 'ministry-of-works';

  // the Emperor asks; the Warden builds the prompt block (the ears site)
  const q = ic.send({ from: 'emperor', parts: [{ to: `agent:${WORKS}`, code: 'ASK', line: 'where is the report?' }] });
  const mail = ic.collect(WORKS, { task: 'TASK-1' });
  const block = mailBlock(mail);
  assert.ok(block.includes('## YOUR MAIL'));

  // the ministry replies the way the block tells it to (the voice site)
  const reply = `The report is in output/.\n\n[ICOM SEEN ${mail[0].id}]\n[ICOM ANSWER call:${q.call} | output/works/report.md]`;
  const said = parseIcom(reply);
  assert.deepStrictEqual(ic.acknowledge(WORKS, said.seen).marked, [mail[0].id]);
  const sent = ic.send({ from: WORKS, task: 'TASK-1', call: said.parts[0].call, dueNextRun: true, parts: said.parts });
  assert.ok(sent.ok, sent.why);
  assert.strictEqual(said.clean, 'The report is in output/.');

  // the Emperor is handed the answer, and nothing is left unheard
  assert.strictEqual(ic.collect('emperor')[0].line, 'output/works/report.md');
  const rep = ic.report();
  assert.strictEqual(rep.unacknowledged.length, 0);
  assert.strictEqual(rep.unhanded.length, 0);
  ic.close();
});

test('the Chancellor has ears but no voice, and the refusal says exactly that', () => {
  const { intercom, parseIcom } = require('../runners/intercom.js');
  const ic = intercom(null, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiring2-')), 'ic.db'), { amended: true });
  const said = parseIcom('[ICOM ASK to:agent:ministry-of-works | do the thing]');
  const r = ic.send({ from: 'imperial-chancellor', parts: said.parts });
  assert.strictEqual(r.why, 'imperial-chancellor has no voice yet');
  // he still hears
  assert.ok(ic.send({ from: 'ministry-of-works', parts: [{ to: 'agent:imperial-chancellor', code: 'DONE' }] }).ok);
  assert.strictEqual(ic.pending('imperial-chancellor').length, 1);
  ic.close();
});
