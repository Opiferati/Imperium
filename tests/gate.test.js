'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE ASK-FIRST GATE (tests written 2026-11-11)
//
// Until today this file did not exist. The gate and the code-writer are the
// two parts standing between an agent's words and the filesystem, and neither
// had a single test — while the blackboard had 10 and the slot standard 45.
// The privilege boundary was the one thing nobody was checking.
//
// What matters here, in order:
//   1. The three verdicts are right, including at the edges (a sibling folder
//      whose name merely STARTS with "output" is not the free folder).
//   2. output/ cannot be used as a launchpad — climbing out of it loses the
//      freedom, it does not carry it along.
//   3. The never-list cannot be talked around.
//   4. An approval is one write, for one file, inside one day.
//   5. The gate can only ever say no. There is no path through this module
//      that creates an approval — only the Emperor does that.
// ══════════════════════════════════════════════════════════════════════

const { test } = require('node:test');
const assert   = require('node:assert');
const path     = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const gate = require('../runners/gate.js');

const R  = gate.ROOT;
const at = (...p) => path.join(R, ...p);

function freshDb() {
  const d = new DatabaseSync(':memory:');
  gate.ensureTables(d);
  return d;
}
function grantAt(d, target, whenSql) {
  d.prepare(`INSERT INTO approvals (petition_id, task_id, target, granted_at)
             VALUES (1, 'TASK-TEST', ?, ${whenSql})`).run(target);
}
const grant = (d, target) => grantAt(d, target, `datetime('now')`);

// ── 1. The three verdicts ──────────────────────────────────────────────

test('output/ is free, and the whole of it', () => {
  assert.strictEqual(gate.classifyWrite(at('output')).verdict, 'free');
  assert.strictEqual(gate.classifyWrite(at('output', 'report.md')).verdict, 'free');
  assert.strictEqual(gate.classifyWrite(at('output', 'a', 'b', 'c.txt')).verdict, 'free');
});

test('a folder whose name merely starts with output is NOT the free folder', () => {
  // The same prefix-leak the blackboard's topic test guards against. "outputs"
  // and "output-old" share five letters with freedom and none of its licence.
  assert.strictEqual(gate.classifyWrite(at('outputs', 'x.txt')).verdict, 'ask');
  assert.strictEqual(gate.classifyWrite(at('output-old', 'x.txt')).verdict, 'ask');
  assert.strictEqual(gate.classifyWrite(at('outputting.js')).verdict, 'ask');
});

test("the Empire's own files need the Emperor, and the reason says so", () => {
  for (const p of ['warden.js', 'runners/gate.js', 'preflight.js', 'IMPERIAL_BRIEF.md',
                   'library/edicts/EDICTS.md', 'ministries/chancellor/SOUL.md',
                   'cards/testcard/index.js', 'data/imperium-registry.json']) {
    const v = gate.classifyWrite(at(p));
    assert.strictEqual(v.verdict, 'ask', `${p} must need approval, got ${v.verdict}`);
    assert.match(v.reason, /Emperor/, `${p} should be told who can approve it`);
    assert.strictEqual(v.rel, p, 'the relative path is reported for the petition');
  }
});

test('secrets, databases, git and key files are never — not ask', () => {
  for (const p of ['.env', '.env.local', '.env.production',
                   'data/message_bus.db', 'data/message_bus.db-wal',
                   'data/bus.db-shm', 'data/bus.db-journal',
                   '.git/config', '.git/HEAD',
                   'certs/server.pem', 'deploy/id_rsa.key', 'store.pfx', 'store.p12']) {
    const v = gate.classifyWrite(at(p));
    assert.strictEqual(v.verdict, 'never', `${p} must be never, got ${v.verdict}`);
  }
});

test('a never verdict offers no petition — there is nothing to approve', () => {
  const v = gate.classifyWrite(at('data', 'imperial-ledger.db'));
  assert.strictEqual(v.verdict, 'never');
  assert.doesNotMatch(v.reason, /Emperor|approv/i,
    'a never must not hint that asking would help, or an agent will keep asking');
});

test('a token-shaped name is never outside output/, and ordinary inside it', () => {
  assert.strictEqual(gate.classifyWrite(at('runners', 'my-secret-helper.js')).verdict, 'never');
  assert.strictEqual(gate.classifyWrite(at('config', 'password-rules.md')).verdict, 'never');
  assert.strictEqual(gate.classifyWrite(at('lib', 'credential-store.js')).verdict, 'never');
  assert.strictEqual(gate.classifyWrite(at('api', 'token-cache.json')).verdict, 'never');
  // Inside output/ the ministries own the folder, so a REPORT about credentials
  // is just a report. The rule is about reaching the Empire's own secrets.
  assert.strictEqual(gate.classifyWrite(at('output', 'password-policy-notes.md')).verdict, 'free');
  assert.strictEqual(gate.classifyWrite(at('output', 'token-research.md')).verdict, 'free');
});

// ── 2. output/ is not a launchpad ──────────────────────────────────────

test('climbing out of output/ loses the freedom rather than carrying it along', () => {
  assert.strictEqual(gate.classifyWrite(at('output', '..', 'warden.js')).verdict, 'ask',
    'the path is resolved first and judged second, so .. cannot smuggle');
  assert.strictEqual(gate.classifyWrite(at('output', '..', '..', 'escaped.txt')).verdict, 'never');
  assert.strictEqual(gate.classifyWrite(at('output', 'sub', '..', '..', '.env')).verdict, 'never');
});

test('anything outside the Imperium is never, and says it is outside', () => {
  for (const p of ['/etc/passwd', '/tmp/loot.txt', at('..', 'Finalance', 'scan.py')]) {
    const v = gate.classifyWrite(p);
    assert.strictEqual(v.verdict, 'never', `${p} must be never, got ${v.verdict}`);
    assert.match(v.reason, /outside/i);
  }
});

// ── 3. Reading ─────────────────────────────────────────────────────────

test('reading is free everywhere inside the Imperium', () => {
  // This is the rule the court could not find on 2026-11-10, when Engineering
  // was ordered to copy the shape of cards/testcard/index.js and reported that
  // it was not allowed to read it. The capability was always here.
  for (const p of ['warden.js', 'cards/testcard/index.js', 'runners/slots.js',
                   'INTERCOM.md', 'ministries/engineering/SOUL.md']) {
    assert.strictEqual(gate.classifyRead(at(p)).verdict, 'free', `${p} must be readable`);
  }
});

test('reading the never-list is still refused', () => {
  for (const p of ['.env', 'data/message_bus.db', '.git/config', 'deploy/id_rsa.key']) {
    assert.strictEqual(gate.classifyRead(at(p)).verdict, 'never', `${p} must stay unreadable`);
  }
  assert.strictEqual(gate.classifyRead('/etc/passwd').verdict, 'never');
});

test('a read verdict never upgrades a never into a free', () => {
  const w = gate.classifyWrite(at('.env'));
  const r = gate.classifyRead(at('.env'));
  assert.strictEqual(w.verdict, 'never');
  assert.strictEqual(r.verdict, 'never');
  assert.strictEqual(r.reason, w.reason, 'the refusal keeps its reason, so the log says why');
});

// ── 4. Approvals ───────────────────────────────────────────────────────

test('ensureTables is safe to run twice and needs no petitions table', () => {
  const d = new DatabaseSync(':memory:');
  gate.ensureTables(d);
  gate.ensureTables(d);
  assert.ok(d.prepare(`SELECT name FROM sqlite_master WHERE name='approvals'`).get());
});

test('an approval is matched on the path RELATIVE to the root', () => {
  // Both sides must agree on the form of the path or every approval silently
  // misses: the petition stores 'cards/diskwatch/card.json', the writer asks
  // with an absolute path, and findApproval is what reconciles them.
  const d = freshDb();
  grant(d, 'cards/diskwatch/card.json');
  assert.ok(gate.findApproval(d, at('cards', 'diskwatch', 'card.json')));
  assert.strictEqual(gate.rel(at('cards', 'diskwatch', 'card.json')), 'cards/diskwatch/card.json',
    'and rel() reports forward slashes on every platform');
});

test('an approval is for one file, not for its folder or its neighbours', () => {
  const d = freshDb();
  grant(d, 'cards/diskwatch/card.json');
  assert.strictEqual(gate.findApproval(d, at('cards', 'diskwatch', 'index.js')), null);
  assert.strictEqual(gate.findApproval(d, at('cards', 'diskwatch')), null);
  assert.strictEqual(gate.findApproval(d, at('cards', 'other', 'card.json')), null);
});

test('one approval is one write', () => {
  const d = freshDb();
  grant(d, 'warden.js');
  const a = gate.findApproval(d, at('warden.js'));
  assert.ok(a, 'granted and unused, so it is found');
  gate.useApproval(d, a.id);
  assert.strictEqual(gate.findApproval(d, at('warden.js')), null,
    'spent is spent — a second write needs a second approval');
});

test('an approval expires after a day', () => {
  const young = freshDb();
  grantAt(young, 'warden.js', `datetime('now','-23 hours')`);
  assert.ok(gate.findApproval(young, at('warden.js')), '23 hours old is still good');

  const old = freshDb();
  grantAt(old, 'warden.js', `datetime('now','-25 hours')`);
  assert.strictEqual(gate.findApproval(old, at('warden.js')), null,
    '25 hours old has lapsed — approval is not a standing licence');
});

test('the oldest unused approval is spent first', () => {
  const d = freshDb();
  grantAt(d, 'warden.js', `datetime('now','-2 hours')`);
  grantAt(d, 'warden.js', `datetime('now')`);
  const first = gate.findApproval(d, at('warden.js'));
  gate.useApproval(d, first.id);
  const second = gate.findApproval(d, at('warden.js'));
  assert.ok(second && second.id > first.id, 'FIFO, so two approvals are two writes and not one');
});

// ── 5. The gate can only say no ────────────────────────────────────────

test('nothing in this module can create an approval', () => {
  // The whole mechanism rests on this. If the gate could grant, the court
  // could reach every file in the Empire by asking the gate instead of Opie.
  for (const name of Object.keys(gate)) {
    assert.doesNotMatch(name, /^(grant|approve|allow|permit|create|add|insert)/i,
      `gate exports ${name}() — only the Emperor may create an approval`);
  }
});

test('looking for an approval never creates one', () => {
  const d = freshDb();
  gate.findApproval(d, at('warden.js'));
  gate.findApproval(d, at('.env'));
  gate.findApproval(d, at('output', 'x.txt'));
  assert.strictEqual(d.prepare(`SELECT COUNT(*) n FROM approvals`).get().n, 0,
    'a lookup is a question, not a request');
});

test('an approval row cannot promote a never into a write', () => {
  // A row can exist for any string. The verdict is computed from the path and
  // never read from the approvals table, so a stray row buys nothing.
  const d = freshDb();
  grant(d, '.env');
  assert.ok(gate.findApproval(d, at('.env')), 'the row is findable');
  assert.strictEqual(gate.classifyWrite(at('.env')).verdict, 'never',
    'and it changes the verdict not at all — the code-writer checks never FIRST');
});

test('every verdict is one of exactly three words', () => {
  const sample = ['output/a.txt', 'warden.js', '.env', 'outputs/b.txt', 'data/x.db',
                  'library/edicts/EDICTS.md', 'cards/testcard/card.json'];
  for (const p of sample) {
    assert.ok(['free', 'ask', 'never'].includes(gate.classifyWrite(at(p)).verdict),
      `${p} produced a verdict outside the closed set`);
  }
});
