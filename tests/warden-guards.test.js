// ══════════════════════════════════════════════════════════════════════
// THE WARDEN'S GUARDS (tests written 2026-11-12)
//
// warden.js cannot be started in a test — it opens the live databases and begins
// dispatching — so these assert what a test can HONESTLY prove about it, following
// the precedent set by warden-intercom-wiring.test.js. That file's own header is
// worth repeating: a source assertion is weaker than a behavioural one, and it is
// named as such rather than dressed up.
//
// It is also not nothing. The temporal-dead-zone bug that kept the Intercom dark
// on every boot was caught by exactly this kind of test, after 92 behavioural
// tests passed against the module without ever booting the Warden.
//
// Each test below pins a guard that was found MISSING or SILENT on 2026-11-12.
// ══════════════════════════════════════════════════════════════════════
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT     = path.join(__dirname, '..');
const WARDEN   = fs.readFileSync(path.join(ROOT, 'warden.js'), 'utf8');
const TERMINAL = fs.readFileSync(path.join(ROOT, 'imperium-terminal.js'), 'utf8');
const ORACLE   = fs.readFileSync(path.join(ROOT, 'imperium-oracle-server.js'), 'utf8');

// ── 1. The guard that could not guard its own absence ──────────────────

test('a missing Legion loader ALARMS — the fail-closed path covers its own absence', () => {
  // The fault: `if (slots && slots.restricted(...))`. With the loader unresolvable,
  // `slots` was null, BOTH branches were skipped, no card ran and no alarm was sent.
  // The night was indistinguishable from a quiet one — on nights a signed thesis
  // collects data. The comment directly above it was emphatic about failing closed.
  const i = WARDEN.indexOf('const slotRequired');
  assert.ok(i !== -1, 'the slots block exists');
  const block = WARDEN.slice(i, i + 2400);

  // Comments are stripped before the negative assertion. The first draft of this
  // test failed because the comment EXPLAINING the fix quotes the broken form it
  // replaced — so the test matched prose about the bug and called it the bug.
  // That is CHARTER-LOCK-V-0001 exactly: a document hiding its own signature from
  // the guard, because the guard matched an example of the syntax it was hunting.
  // A source-matching test must read code, not the commentary around it.
  const code = block.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  assert.match(code, /if \(!slots\)/,
    'a null loader has its OWN branch — it is not folded into a condition that skips it');
  assert.match(code, /BUS RESTRICTED/,
    'and that branch raises the same alarm as a missing required card');
  assert.ok(!/if \(slots && slots\.restricted/.test(code),
    'the old fail-open form is gone from the CODE (comments may still quote it)');
});

test('the missing-loader alarm reaches the Emperor at priority 1', () => {
  const i = WARDEN.indexOf('if (!slots)');
  assert.ok(i !== -1);
  const branch = WARDEN.slice(i, i + 700);
  assert.match(branch, /stmtInsertMessage\.run\([^)]*'emperor'/,
    'it is sent, not merely logged to a console nobody is reading at 23:02');
  assert.match(branch, /,\s*1\)/, 'at priority 1, like the required-card alarm');
  assert.match(branch, /not a quiet night/i,
    'and it says plainly that silence here means UNCHECKED, not fine');
});

// ── 2. Who confirmed it ────────────────────────────────────────────────

test("the Emperor's report says WHICH layer passed the work", () => {
  // The marker has read "[FORSETI: PASS] (the Lawspeaker)" since it was written,
  // but wardenRelay's regex captured only the verdict, so the report printed a bare
  // "Forseti: PASS". A judged pass and a mechanical-only pass reached the Emperor
  // as the same four characters.
  assert.match(WARDEN, /\(\?:\\s\*\\\(\(\[\^\)\]\+\)\\\)\)\?/,
    'the regex captures the parenthesised layer, not just the verdict');
  assert.match(WARDEN, /const judgedBy/, 'the layer is bound to a name');
  assert.match(WARDEN, /judgedBy \? `? ?\(\$\{judgedBy\}\)/,
    'and that name is printed in the report line');
});

test('the layer is still written at the point of judgement', () => {
  // The upstream half: forseti.js records `layer`, and warden.js turns it into the
  // marker. If this ever stops, the report above has nothing to carry.
  assert.match(WARDEN, /v\.layer === 'lawspeaker' \? 'the Lawspeaker' : 'Forseti'/,
    'the two cases are named in plain words, not left as a code');
  assert.match(WARDEN, /\[FORSETI: \$\{v\.verdict\}\] \(\$\{who\}\)/,
    'and both ride in the marker together');
});

// ── 3. Which door a decree came through ────────────────────────────────

test('every decree records its source — the bus no longer takes "emperor" on trust', () => {
  // from_agent:'emperor' was recorded identically whether a decree came from the
  // dashboard, the oracle's open HTTP port, or a curl on the network. Law 14 makes
  // every thesis record its inputs; the order that STARTS them recorded nothing.
  const inserts = [...TERMINAL.matchAll(/action: 'decree'[^}]*}/g)].map(m => m[0]);
  assert.ok(inserts.length >= 3, 'the terminal has several decree paths');
  for (const ins of inserts) {
    assert.match(ins, /source:/, `every decree insert carries a source — missing in: ${ins.slice(0, 90)}`);
  }
  assert.match(ORACLE, /action: 'decree', text, source,/,
    'and the oracle stamps one too');
});

test("the oracle's source carries the caller's address", () => {
  // "Who issued this" must be answerable in the morning rather than never. A door
  // that anything on the network can knock on should record who knocked.
  assert.match(ORACLE, /insertDecree\(text\.trim\(\), 'oracle:'/,
    'the address is passed at the call site, not defaulted away');
  assert.match(ORACLE, /remoteAddress/, 'and it is the real socket address');
});

// ── 4. The door itself ─────────────────────────────────────────────────

test('the oracle binds loopback only, like the terminal', () => {
  // listen(PORT) with no host binds EVERY interface. imperium-terminal.js has always
  // bound '127.0.0.1'; this one did not, and POST /decree has no authentication — so
  // anything that could reach port 7979 could issue an Imperial decree.
  assert.match(ORACLE, /server\.listen\(PORT, '127\.0\.0\.1'/,
    "the oracle is bound to loopback");
  assert.ok(!/server\.listen\(PORT,\s*\(\)/.test(ORACLE),
    'the hostless form is gone');
});

test('the terminal has not quietly lost its own binding', () => {
  // The asymmetry between these two servers was accidental and went unnoticed for
  // months. Pin both sides so it cannot drift back.
  assert.match(TERMINAL, /server\.listen\(PORT, '127\.0\.0\.1'/,
    'the terminal still binds loopback');
});
