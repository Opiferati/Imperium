'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE CODE-WRITER (tests written 2026-11-11)
//
// The only path by which an agent's words become a file on disk. Untested
// until today, alongside the gate it consults.
//
// What matters here:
//   1. A FILE: declaration counts only at the start of a line. A path
//      mentioned inside dispatch JSON must not create a file — that was a
//      real bug (the `",` and `/n` debris) and the fix needs a guard.
//   2. Nothing lands outside the Imperium, however the path is spelled.
//   3. The gate is consulted on EVERY block, and never is refused before
//      anything is written.
//   4. The byte count comes from the disk, not from the string in memory.
//   5. An approval authorises exactly one write and is spent.
//
// These tests write real files, because a write path proven with a fake
// filesystem is not proven. Everything lands in a temp folder under
// output/ or tests/, and is removed afterwards.
// ══════════════════════════════════════════════════════════════════════

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const cw   = require('../runners/code-writer.js');
const gate = require('../runners/gate.js');

const R = cw.ROOT;
const TAG = `.tmp-cwtest-${process.pid}`;
const FREE = `output/${TAG}`;          // free zone, no approval needed
const ASK  = `tests/${TAG}`;           // inside the Empire, outside output/
const abs  = (rel) => path.join(R, rel);

after(() => {
  fs.rmSync(abs(FREE), { recursive: true, force: true });
  fs.rmSync(abs(ASK),  { recursive: true, force: true });
});

const fenced = (declPath, body, lang) =>
  `// FILE: ${declPath}\n\`\`\`${lang || ''}\n${body}\n\`\`\`\n`;

function freshDb() {
  const d = new DatabaseSync(':memory:');
  gate.ensureTables(d);
  return d;
}

// ── 1. Extraction ──────────────────────────────────────────────────────

test('a FILE: declaration counts only at the start of its own line', () => {
  const inline = 'The Chancellor wrote // FILE: cards/junk.js in a sentence.\n'
               + '```\nsome content\n```\n';
  assert.strictEqual(cw.extractFileBlocks(inline).length, 0,
    'a path mentioned in prose or inside dispatch JSON must not become a file');

  const real = fenced('output/x.js', 'const a = 1;', 'js');
  const blocks = cw.extractFileBlocks(real);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].content, 'const a = 1;');
});

test('all three comment styles open a declaration', () => {
  for (const open of ['//', '#', '<!--']) {
    const text = `${open} FILE: output/x.txt\n\`\`\`\nbody\n\`\`\`\n`;
    assert.strictEqual(cw.extractFileBlocks(text).length, 1, `${open} should declare a file`);
  }
});

test('nested fences inside a document are not cut short', () => {
  // The v2.1 fix: a markdown doc containing its own ``` examples used to be
  // truncated after the first inner fence, losing everything after section one.
  const text = [
    '// FILE: output/doc.md',
    '```md',
    '# Title',
    '```js',
    'const inner = 1;',
    '```',
    'after the inner block',
    '```',
  ].join('\n');
  const [b] = cw.extractFileBlocks(text);
  assert.match(b.content, /const inner = 1;/, 'the inner example survives');
  assert.match(b.content, /after the inner block/, 'and so does everything after it');
});

test('two declarations in one reply are two separate files', () => {
  const text = fenced('output/a.txt', 'first') + fenced('output/b.txt', 'second');
  const blocks = cw.extractFileBlocks(text);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].content, 'first');
  assert.strictEqual(blocks[1].content, 'second');
});

test('a declaration with no body writes nothing at all', () => {
  assert.strictEqual(cw.extractFileBlocks('// FILE: output/empty.txt\n').length, 0);
});

// ── 2. Path handling ───────────────────────────────────────────────────

test('a Windows path from the court lands in the Imperium on either platform', () => {
  assert.strictEqual(cw.normalisePath('C:\\Imperium\\output\\x.txt'),
                     path.join(R, 'output', 'x.txt'));
  assert.strictEqual(cw.normalisePath('C:/Imperium/output/x.txt'),
                     path.join(R, 'output', 'x.txt'));
});

test('trailing JSON debris and a literal backslash-n do not join the path', () => {
  assert.strictEqual(cw.normalisePath('output/x.js",'), path.join(R, 'output', 'x.js'));
  assert.strictEqual(cw.normalisePath('output/x.js);'), path.join(R, 'output', 'x.js'));
  assert.strictEqual(cw.normalisePath('output/x.js\\nand more text'),
                     path.join(R, 'output', 'x.js'));
  assert.strictEqual(cw.normalisePath('C:\\Imperium\\output\\list.js\\nconst fs'),
                     path.join(R, 'output', 'list.js'), 'content running on from the declaration');
});

test('a path segment starting with "n" survives — it is not debris', () => {
  // 2026-11-11, found in anger. The old rule cut at the FIRST literal \n, and a
  // Windows path CONTAINS that sequence whenever the next segment begins with n.
  // Intelligence finished a research job with 14 sources, declared
  // C:\Imperium\output\node-sqlite-22-to-26.md, and the write was refused as
  // "a directory, not a file" — because the path had been cut back to output.
  // The work was paid for and thrown away.
  for (const name of ['node-sqlite-22-to-26.md', 'notes.md', 'new-plan.md', 'nightly-report.md']) {
    assert.strictEqual(cw.normalisePath(`C:\\Imperium\\output\\${name}`),
      path.join(R, 'output', name), `${name} must survive the backslash-n rule`);
  }
  assert.strictEqual(cw.normalisePath('C:\\Imperium\\output\\nightly\\x.md'),
    path.join(R, 'output', 'nightly', 'x.md'), 'a whole folder starting with n, too');
});

test('when in doubt the path is KEPT, because losing work is worse than a junk name', () => {
  // No extension before the \n, so nothing is cut: the result is an odd filename,
  // which is visible and harmless. The alternative is a silent truncation onto a
  // directory, which is what cost a research job.
  const odd = cw.normalisePath('C:\\Imperium\\output\\LICENSE\\nMIT');
  assert.ok(odd.startsWith(path.join(R, 'output')), 'still inside output/');
  assert.notStrictEqual(odd, path.join(R, 'output'), 'and NOT the bare directory');
});

test('READ: requests are collected, and only at the start of a line', () => {
  const text = '// READ: cards/testcard/index.js\n'
             + 'and in passing // READ: not-this-one.js\n'
             + '# READ: runners/slots.js\n';
  assert.deepStrictEqual(cw.extractReadRequests(text),
    ['cards/testcard/index.js', 'runners/slots.js']);
});

// ── 3. Writing, and the gate ───────────────────────────────────────────

test('a free write lands, and the byte count is read back from the disk', () => {
  const target = `${FREE}/hello.txt`;
  const [r] = cw.extractAndWrite(fenced(target, 'hello'), 'TASK-TEST-1');
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(fs.readFileSync(abs(target), 'utf8'), 'hello\n',
    'a trailing newline is added, and nothing else');
  assert.strictEqual(r.bytes, fs.statSync(abs(target)).size,
    'the size comes from stat, not from the length of the string we held');
});

test('a path outside the Imperium is refused and nothing is created', () => {
  const escape = '/tmp/cwtest-escape.txt';
  const [r] = cw.extractAndWrite(fenced(escape, 'loot'), 'TASK-TEST-2');
  assert.strictEqual(r.success, false);
  assert.match(r.error, /Outside the Imperium folder/);
  assert.strictEqual(fs.existsSync(escape), false, 'and the file does not exist');
});

test('a never-listed file is refused even with an approval in hand', () => {
  // The approval row exists and is findable. The verdict is computed from the
  // path, and never is checked BEFORE approvals are consulted, so it buys nothing.
  const d = freshDb();
  const target = 'data/cwtest-fake.db';
  d.prepare(`INSERT INTO approvals (target, granted_at) VALUES (?, datetime('now'))`).run(target);
  assert.ok(gate.findApproval(d, abs(target)), 'the approval is really there');

  const [r] = cw.extractAndWrite(fenced(target, 'nope'), 'TASK-TEST-3', d);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /NEVER/);
  assert.notStrictEqual(r.gated, true, 'a never is a refusal, not a petition');
  assert.strictEqual(fs.existsSync(abs(target)), false);
});

test('an ask-path write with no approval is GATED, and touches nothing', () => {
  const target = `${ASK}/probe.json`;
  const [r] = cw.extractAndWrite(fenced(target, '{"a":1}', 'json'), 'TASK-TEST-4', null);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.gated, true, 'gated is how the Warden knows to raise a petition');
  assert.match(r.error, /ASK-FIRST/);
  assert.strictEqual(r.rel, target, 'and the petition is told exactly which file');
  assert.strictEqual(fs.existsSync(abs(target)), false, 'a gated write writes nothing');
});

test('an approval turns one ask into one write, and is spent doing it', () => {
  const d = freshDb();
  const target = `${ASK}/approved.json`;
  d.prepare(`INSERT INTO approvals (target, granted_at) VALUES (?, datetime('now'))`).run(target);

  const text = fenced(target, '{"ok":true}', 'json');
  const [first] = cw.extractAndWrite(text, 'TASK-TEST-5', d);
  assert.strictEqual(first.success, true, first.error);
  assert.strictEqual(fs.readFileSync(abs(target), 'utf8'), '{"ok":true}\n');
  assert.ok(d.prepare(`SELECT used_at FROM approvals`).get().used_at,
    'the approval is marked used the moment the bytes are on disk');

  const [second] = cw.extractAndWrite(text, 'TASK-TEST-6', d);
  assert.strictEqual(second.gated, true,
    'the same approval cannot authorise a second write — one approval, one write');
});

test('one bad block in a reply does not stop the good ones', () => {
  const good = `${FREE}/good.txt`;
  const text = fenced('/tmp/cwtest-bad.txt', 'refused') + fenced(good, 'written');
  const results = cw.extractAndWrite(text, 'TASK-TEST-7');
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].success, false);
  assert.strictEqual(results[1].success, true, results[1].error);
  assert.strictEqual(fs.readFileSync(abs(good), 'utf8'), 'written\n');
});

test('a directory where a file should go is reported, not forced', () => {
  const dir = `${FREE}/a-directory`;
  fs.mkdirSync(abs(dir), { recursive: true });
  const [r] = cw.extractAndWrite(fenced(dir, 'content'), 'TASK-TEST-8');
  assert.strictEqual(r.success, false);
  assert.match(r.error, /directory, not a file/);
});

// ── 4. Reading ─────────────────────────────────────────────────────────

test('readFile reads anything inside the Imperium', () => {
  const ok = cw.readFile('cards/testcard/card.json');
  assert.strictEqual(ok.success, true, ok.error);
  assert.match(ok.content, /legion\//, 'the court can read a real card to copy its shape');
});

test('readFile refuses the never-list and the world outside', () => {
  const db = cw.readFile('data/message_bus.db');
  assert.strictEqual(db.success, false);
  assert.match(db.error, /NEVER/);

  const out = cw.readFile('/etc/passwd');
  assert.strictEqual(out.success, false);
  assert.match(out.error, /Outside the Imperium folder/);
});

test('a missing file is an honest failure, not a crash', () => {
  const r = cw.readFile('output/this-does-not-exist-anywhere.txt');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.content, null);
  assert.ok(r.error, 'and it says what went wrong');
});
