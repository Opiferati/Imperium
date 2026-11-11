'use strict';
// ══════════════════════════════════════════════════════════════════════
// EVIDENCE RUNNER (2026-11-09) — the nightly record leaves the machine.
// After the twins and the Ravens have run, commit each repo's evidence files (prices, frozen feeds,
// scan logs, Skald readings) and push them to GitHub. "Frozen on first sight" is only provable if a
// dated copy exists somewhere else. Plain code, $0. Only the listed paths are ever added: no code, no .env.
// Uses Windows git (it holds the GitHub sign-in); WSL's own git has no credentials.
// ══════════════════════════════════════════════════════════════════════
const { execFile } = require('node:child_process');
const fs = require('node:fs');

const GIT = '/mnt/c/Program Files/Git/cmd/git.exe';
const REPOS = [
  { name: 'Imperium',  dir: 'C:\\Imperium',  paths: ['data/skald-mood.csv', 'data/skald-archive', 'library/chronicles', 'Art',
            // Thesis G's observation log and launch lock (added 2026-11-10: they were being frozen but never left the machine)
            'library/thesis_g.jsonl', 'state'] },
  { name: 'Finalance', dir: 'C:\\Finalance', paths: ['data/v2_prices'] },
  { name: 'Ecnalanif', dir: 'C:\\Ecnalanif', paths: ['data', 'state'] },
  { name: 'Cavalier',  dir: 'C:\\Cavalier',  paths: ['data', 'state'] },
  { name: 'Ravens',    dir: 'C:\\Ravens',    paths: ['state'] },
  // No paths = push-only. Legion is the slot standard, not nightly data: it must
  // never be auto-committed, but its deliberate commits should still leave the
  // machine the same night. See commitOne().
  { name: 'Legion',    dir: 'C:\\Legion' },
];

const toWsl = p => '/mnt/' + p[0].toLowerCase() + '/' + p.slice(3).replace(/\\/g, '/');

function git(dir, args, timeout = 90_000) {
  return new Promise(resolve => {
    execFile(GIT, ['-C', dir, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout).trim(), err: String(stderr).trim() }));
  });
}

async function commitOne(repo, label) {
  if (!fs.existsSync(toWsl(repo.dir) + '/.git')) return { name: repo.name, status: 'missing' };
  // PUSH-ONLY (2026-11-11). A repo with no evidence paths is source, not nightly
  // data — Legion is the standard itself. Such a repo must never be swept into an
  // automatic "Daily evidence" commit: a change to a contract earns a written
  // message, by hand, from whoever changed it. What this entry buys is the other
  // half — that deliberate commits still reach GitHub the same night rather than
  // sitting on one machine until somebody remembers.
  const pushOnly = !repo.paths || repo.paths.length === 0;
  let committed = false;
  if (!pushOnly) {
    const paths = repo.paths.filter(p => fs.existsSync(toWsl(repo.dir) + '/' + p));
    if (!paths.length) return { name: repo.name, status: 'nothing' };
    const add = await git(repo.dir, ['add', '-A', '--', ...paths]);
    if (add.code) return { name: repo.name, status: 'error', message: add.err.split('\n').pop() };
    const staged = await git(repo.dir, ['diff', '--cached', '--quiet', '--', ...paths]);
    if (staged.code === 1) {                     // 1 = there are staged changes in the evidence paths
      const c = await git(repo.dir, ['commit', '-q', '-m', `Daily evidence: ${label}`, '--', ...paths]);
      if (c.code) return { name: repo.name, status: 'error', message: c.err.split('\n').pop() };
      committed = true;
    }
  }
  const hasRemote = (await git(repo.dir, ['remote'])).out.length > 0;
  if (!hasRemote) return { name: repo.name, status: committed ? 'committed (no remote)' : 'nothing' };
  const ahead = await git(repo.dir, ['rev-list', '--count', '@{u}..HEAD']);
  if (ahead.code === 0 && ahead.out === '0') return { name: repo.name, status: 'nothing' };
  const push = await git(repo.dir, ['push', '-q']);
  if (push.code) return { name: repo.name, status: 'push failed', message: push.err.split('\n').pop() };
  return { name: repo.name, status: 'pushed' };
}

async function run(label) {
  const results = [];
  for (const r of REPOS) {
    try { results.push(await commitOne(r, label)); }
    catch (e) { results.push({ name: r.name, status: 'error', message: e.message }); }
  }
  return results;
}

function summaryLine(results) {
  const bad = results.filter(r => /error|failed/.test(r.status));
  const sent = results.filter(r => r.status === 'pushed').map(r => r.name);
  const local = results.filter(r => /no remote/.test(r.status)).map(r => r.name);
  let s = `[EVIDENCE] ${sent.length ? 'Pushed to GitHub: ' + sent.join(', ') + '.' : 'Nothing new to push.'}`;
  if (local.length) s += ` Committed locally only (no GitHub copy): ${local.join(', ')}.`;
  if (bad.length) s += ` PROBLEM: ${bad.map(r => `${r.name} (${r.status}${r.message ? ': ' + r.message : ''})`).join('; ')}.`;
  return s;
}

// commitOne is exported for tests only (2026-11-11): run() walks the REAL five
// repos, so a test that called it would commit and push this machine's work.
module.exports = { run, summaryLine, REPOS, commitOne };
