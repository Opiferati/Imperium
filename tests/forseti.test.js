// ══════════════════════════════════════════════════════════════════════
// FORSETI (tests written 2026-11-12)
//
// Until today runners/forseti.js had no test file. It is the Empire's judge, and
// the Lawspeaker inside it is the single cheapest and most trustworthy check the
// machine owns — plain code, zero tokens, running before any model is called.
// It was the one judging layer nobody was checking.
//
// These are BEHAVIOURAL: lawCheck and review are exported, so they can be driven
// against real files on disk rather than asserted against source text.
//
// Two of them are regressions for faults recorded on 2026-11-12:
//   - the Lawspeaker truncated its problem list in silence (fixed here)
//   - a KB entry wrongly claimed an unreadable file could PASS; it cannot, and
//     "unreadable file fails before the judge is called" is now pinned so the
//     claim can never be made again without a test contradicting it.
// ══════════════════════════════════════════════════════════════════════
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const forseti = require('../runners/forseti.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forseti-test-'));
}
function write(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, 'utf8');
  return { path: name, resolvedPath: p };
}

test('an unreadable file FAILS — it never reaches the judge', () => {
  // Pinned because a fault was filed on 2026-11-12 claiming the opposite: that a
  // swallowed read in buildCriticPrompt let the judge PASS a file it never read.
  // It was filed from a grep hit without reading the control flow. lawCheck reads
  // every file FIRST and any problem is an immediate FAIL, so the judge is never
  // reached. This test exists so that claim cannot be made again unchallenged.
  const dir = tmp();
  const asDirectory = path.join(dir, 'not-a-file');
  fs.mkdirSync(asDirectory);                    // readFileSync throws EISDIR — the April fault
  const problems = forseti.lawCheck([{ path: 'not-a-file', resolvedPath: asDirectory }]);
  assert.ok(problems.length > 0, 'an unreadable path is a problem, not a silence');
  assert.match(problems.join(' '), /can't read back from disk/,
    'and it says WHY, rather than failing anonymously');
});

test('a nearly-empty file is caught — but the floor is absolute, not relative to the ask', () => {
  // The honest limit, recorded rather than hidden. 116, 66 and 79-byte stubs were
  // stamped [VERIFIED] on 2026-04-05 because they all cleared a flat 40-byte floor.
  // Raising the constant does not fix it: a real config file can honestly be 50 bytes.
  // The fix is a check against what the ORDER named, which does not exist yet.
  const dir = tmp();
  const tiny = write(dir, 'tiny.md', 'x');
  assert.ok(forseti.lawCheck([tiny]).length > 0, 'one byte is caught');

  const stub = write(dir, 'stub.js', 'module.exports = { logSession: () => {} };'); // 42 bytes
  assert.strictEqual(forseti.lawCheck([stub]).length, 0,
    'a 42-byte stub clears the 40-byte floor — this is the open fault IO-WRITER-A-0002, pinned so it is not forgotten');
});

test('more than three problems are ANNOUNCED, never silently dropped', () => {
  // 2026-11-12: lawCheck ended `return problems.slice(0, 3)`. A file with seven
  // problems was reported as three and nothing said the other four existed. The
  // verdict was always right — any problem is a FAIL — but the REASON was truncated
  // in silence, which is the same family as the Silent Drops fixed on 11-11.
  const dir = tmp();
  const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map(n => write(dir, n, 'x'));
  const problems = forseti.lawCheck(files);
  assert.ok(problems.length > 3, 'the announcement rides along as its own entry');
  assert.match(problems[problems.length - 1], /further problem\(s\) found but not shown/,
    'the cut announces itself and names how many it did not show');
  assert.match(problems[problems.length - 1], /\+2\b/,
    'and the count is the real remainder, not a vague "more"');
});

test('three or fewer problems get no announcement', () => {
  const dir = tmp();
  const files = ['a.md', 'b.md'].map(n => write(dir, n, 'x'));
  const problems = forseti.lawCheck(files);
  assert.strictEqual(problems.length, 2, 'nothing is added when nothing was cut');
  assert.ok(!problems.join(' ').includes('not shown'), 'and no phantom announcement');
});

test('a clean file passes the Lawspeaker with nothing to say', () => {
  const dir = tmp();
  const ok = write(dir, 'fine.md', '# A real document\n\nIt has enough prose to clear the floor comfortably.\n');
  assert.deepStrictEqual(forseti.lawCheck([ok]), []);
});

test('a PASS with no judge is LABELLED as the Lawspeaker, not as Forseti', async () => {
  // The fault behind fix 1 on 2026-11-12. review() returns PASS with layer
  // 'lawspeaker' when no model is available — correct — but the Emperor's report
  // printed a bare "Forseti: PASS" either way. "A judge read this and approved it"
  // and "mechanical checks passed and nobody looked" must never read the same.
  const dir = tmp();
  const ok = write(dir, 'fine.md', '# A real document\n\nIt has enough prose to clear the floor comfortably.\n');
  const r = await forseti.review({ taskText: 'write a document', files: [ok], callModel: null });
  assert.strictEqual(r.verdict, 'PASS');
  assert.strictEqual(r.layer, 'lawspeaker',
    'the layer is recorded, so the report can say WHO confirmed it');
});

test('a budget refusal is UNSURE, never PASS', async () => {
  // Not verifying and being fine must stay distinguishable — the founding principle
  // of the Trainer, applied to the judge itself.
  const dir = tmp();
  const ok = write(dir, 'fine.md', '# A real document\n\nIt has enough prose to clear the floor comfortably.\n');
  const r = await forseti.review({
    taskText: 'write a document', files: [ok],
    callModel: async () => ({ text: '{"verdict":"PASS","problems":[]}', inputTok: 1, outputTok: 1 }),
    canSpend: () => false,
  });
  assert.strictEqual(r.verdict, 'UNSURE', 'skipped for budget is not the same as judged and approved');
  assert.match(r.problems.join(' '), /Budget limit reached/, 'and it says so plainly');
});

test("an unreadable verdict from the judge is UNSURE, and does not block the work", () => {
  const r = forseti.parseVerdict('I have thoughts but no JSON today.');
  assert.strictEqual(r.verdict, 'UNSURE');
  assert.match(r.problems.join(' '), /unreadable/,
    "the judge's own malfunction is reported as its own, not charged to the ministry");
});
