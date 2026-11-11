'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE EVIDENCE RUNNER (tests written 2026-11-11)
//
// This is how the nightly record leaves the machine, across six repositories,
// and it had no tests at all. It got a behaviour change today — push-only
// repos, for Legion — so it gets tests now.
//
// The one that matters most is "source is never auto-committed". Legion is a
// contract. A contract that can be changed by a nightly job with a generated
// commit message is a contract nobody can trust, and the whole reason the
// standard was given its own repository was so that changes to it are
// deliberate and signed by whoever made them.
//
// These drive the REAL git binary against real temporary repositories, because
// a push path proven against a mock is not proven.
// ══════════════════════════════════════════════════════════════════════

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const { execFileSync } = require('node:child_process');

const ev = require('../runners/evidence.js');

const GIT = '/mnt/c/Program Files/Git/cmd/git.exe';
// The runner converts C:\... to /mnt/c/..., so the fixtures must live on C:
// and be named the Windows way. tests/.tmp-* is gitignored.
const WIN_BASE = `C:\\Imperium\\tests\\.tmp-ev-${process.pid}`;
const WSL_BASE = `/mnt/c/Imperium/tests/.tmp-ev-${process.pid}`;

let n = 0;
function fixture(files) {
  const name = `r${n++}`;
  const wsl = path.join(WSL_BASE, name);
  fs.mkdirSync(wsl, { recursive: true });
  for (const [rel, body] of Object.entries(files || {})) {
    fs.mkdirSync(path.dirname(path.join(wsl, rel)), { recursive: true });
    fs.writeFileSync(path.join(wsl, rel), body);
  }
  return { win: `${WIN_BASE}\\${name}`, wsl };
}
// fs speaks the WSL path; the WINDOWS git binary only understands C:\ paths —
// which is also why the runner itself passes repo.dir straight to -C.
const git = (f, ...args) =>
  execFileSync(GIT, ['-C', f.win, ...args], { encoding: 'utf8' }).trim();

// One repo at a time. NEVER ev.run() in a test — that walks the real six.
const evRunOne = (repo, label) => ev.commitOne(repo, label);

function initRepo(f) {
  git(f, 'init', '-q');
  git(f, 'config', 'user.name', 'Test');
  git(f, 'config', 'user.email', 'test@example.com');
  git(f, 'add', '-A');
  git(f, 'commit', '-q', '-m', 'base');
  return f;
}
const commitCount = (f) => Number(git(f, 'rev-list', '--count', 'HEAD'));

after(() => fs.rmSync(WSL_BASE, { recursive: true, force: true }));

// ── push-only, which is what Legion is ─────────────────────────────────

test('SOURCE IS NEVER AUTO-COMMITTED: a push-only repo keeps its dirt', async () => {
  const f = initRepo(fixture({ 'loader/slots.js': 'const CONTRACT = "legion/2";\n' }));
  const before = commitCount(f);
  fs.writeFileSync(path.join(f.wsl, 'loader/slots.js'), 'const CONTRACT = "legion/3";\n');

  const results = await evRunOne({ name: 'Legion', dir: f.win }, '2026-11-11');

  assert.strictEqual(commitCount(f), before,
    'the nightly job committed a change to the standard — it must never do that');
  assert.match(git(f, 'status', '--porcelain'), /loader\/slots\.js/,
    'and the change is still sitting there, uncommitted, for a human to write up');
  assert.strictEqual(results.status, 'nothing', 'no remote and nothing committed');
});

test('a push-only repo with no remote reports nothing rather than claiming a push', async () => {
  const f = initRepo(fixture({ 'README.md': 'x\n' }));
  const r = await evRunOne({ name: 'Legion', dir: f.win }, 'label');
  assert.strictEqual(r.status, 'nothing');
});

test('a push-only repo that is not a repo at all is named missing', async () => {
  const f = fixture({ 'README.md': 'x\n' });            // no git init
  const r = await evRunOne({ name: 'Legion', dir: f.win }, 'label');
  assert.strictEqual(r.status, 'missing');
});

// ── the evidence repos, unchanged behaviour ────────────────────────────

test('an evidence repo DOES commit its declared paths, with the dated message', async () => {
  const f = initRepo(fixture({ 'state/day.json': '{"day":1}\n' }));
  const before = commitCount(f);
  fs.writeFileSync(path.join(f.wsl, 'state/day.json'), '{"day":2}\n');
  const r = await evRunOne({ name: 'Cavalier', dir: f.win, paths: ['state'] }, '2026-11-11');
  assert.strictEqual(commitCount(f), before + 1, 'nightly data is exactly what this job is for');
  assert.match(git(f, 'log', '-1', '--format=%s'), /^Daily evidence: 2026-11-11$/);
  assert.strictEqual(r.status, 'committed (no remote)',
    'committed but unsent must say BOTH, so a repo with no GitHub copy is visible '
    + 'in the nightly line rather than reading as a successful push');
});

test('an evidence repo only touches its declared paths', async () => {
  const f = initRepo(fixture({ 'state/day.json': '{"day":1}\n', 'secret-notes.md': 'mine\n' }));
  fs.writeFileSync(path.join(f.wsl, 'state/day.json'), '{"day":2}\n');
  fs.writeFileSync(path.join(f.wsl, 'secret-notes.md'), 'still mine, still untracked by this job\n');
  await evRunOne({ name: 'Cavalier', dir: f.win, paths: ['state'] }, 'label');
  assert.match(git(f, 'status', '--porcelain'), /secret-notes\.md/,
    'a file outside the declared paths is left exactly where it was');
});

test('an evidence repo whose declared paths do not exist does nothing', async () => {
  const f = initRepo(fixture({ 'README.md': 'x\n' }));
  const before = commitCount(f);
  const r = await evRunOne({ name: 'Ghost', dir: f.win, paths: ['data', 'state'] }, 'label');
  assert.strictEqual(r.status, 'nothing');
  assert.strictEqual(commitCount(f), before);
});

// ── the roster and the report ──────────────────────────────────────────

test('Legion is on the roster, and it is push-only', () => {
  const legion = ev.REPOS.find((r) => r.name === 'Legion');
  assert.ok(legion, 'Legion must be in the nightly push or it never leaves the machine');
  assert.strictEqual(legion.dir, 'C:\\Legion');
  assert.ok(!legion.paths || legion.paths.length === 0,
    'giving Legion evidence paths would let the nightly job rewrite the standard');
});

test('every other repo on the roster declares paths', () => {
  for (const r of ev.REPOS.filter((x) => x.name !== 'Legion')) {
    assert.ok(Array.isArray(r.paths) && r.paths.length,
      `${r.name} has no paths, so it would silently become push-only`);
  }
});

test('the summary line never reports a push that did not happen', () => {
  const line = ev.summaryLine([
    { name: 'Imperium', status: 'pushed' },
    { name: 'Legion', status: 'nothing' },
    { name: 'Cavalier', status: 'push failed', message: 'no upstream' },
  ]);
  assert.match(line, /Pushed to GitHub: Imperium\./);
  assert.doesNotMatch(line, /Legion/, 'nothing to say about a repo with nothing to send');
  assert.match(line, /PROBLEM.*Cavalier/);
});
