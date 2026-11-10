'use strict';
// ══════════════════════════════════════════════════════════════════════
// BACKUP RUNNER (2026-11-09) — the Empire's two databases get a second home.
// The ledger and the message bus are live files, so git ignores them. Each night this takes a clean
// snapshot of both (SQLite's own VACUUM INTO, safe while the Warden is running) into
// C:\Imperium\backups\<date>\, keeps the last N days, and, when registry.backup.drive_dir is set,
// mirrors the folder there with robocopy (e.g. a Google Drive for desktop folder). Plain code, $0.
// ══════════════════════════════════════════════════════════════════════
const { DatabaseSync } = require('node:sqlite');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROBOCOPY = '/mnt/c/Windows/System32/robocopy.exe';
const DBS = ['imperial-ledger.db', 'message_bus.db'];
const toWin = p => p.replace(/^\/mnt\/([a-z])\//, (_, d) => d.toUpperCase() + ':\\').replace(/\//g, '\\');

function snapshot(root, day) {
  const dir = path.join(root, 'backups', day);
  fs.mkdirSync(dir, { recursive: true });
  const done = [];
  for (const name of DBS) {
    const src = path.join(root, 'data', name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, name);
    fs.rmSync(dst, { force: true });                       // VACUUM INTO refuses to overwrite
    const db = new DatabaseSync(src);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
    } finally { db.close(); }
    const check = new DatabaseSync(dst, { readOnly: true });
    try {
      const ok = check.prepare('PRAGMA integrity_check').get();
      if (Object.values(ok)[0] !== 'ok') throw new Error(`${name}: snapshot failed its integrity check`);
    } finally { check.close(); }
    done.push({ name, bytes: fs.statSync(dst).size });
  }
  return { dir, done };
}

function prune(root, keepDays) {
  const base = path.join(root, 'backups');
  const days = fs.readdirSync(base).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  const gone = days.slice(0, Math.max(0, days.length - keepDays));
  for (const d of gone) fs.rmSync(path.join(base, d), { recursive: true, force: true });
  return gone.length;
}

function mirror(root, driveDir) {
  return new Promise(resolve => {
    // /MIR keeps the Drive folder identical to backups\ (including pruned days). Exit codes below 8 mean success.
    execFile(ROBOCOPY, [toWin(path.join(root, 'backups')), driveDir, '/MIR', '/R:1', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
      { timeout: 120_000 }, err => resolve(!err || (typeof err.code === 'number' && err.code < 8)));
  });
}

async function run(root, conf = {}, day) {
  const snap = snapshot(root, day);
  const pruned = prune(root, conf.keep_days ?? 14);
  let drive = 'not set';
  if (conf.drive_dir) drive = (await mirror(root, conf.drive_dir)) ? 'copied' : 'copy FAILED';
  return { ...snap, pruned, drive, drive_dir: conf.drive_dir || null };
}

function summaryLine(r) {
  const kb = r.done.map(d => `${d.name} ${(d.bytes / 1024).toFixed(0)} KB`).join(', ');
  const where = r.drive === 'copied' ? ` Mirrored to ${r.drive_dir}.`
    : r.drive === 'not set' ? ' Local only: no second location is set yet.' : ` PROBLEM: the copy to ${r.drive_dir} failed.`;
  return `[BACKUP] Snapshot of ${r.done.length} databases (${kb}).${where}`;
}

module.exports = { run, summaryLine };
