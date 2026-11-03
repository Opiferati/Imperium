'use strict';
// ══════════════════════════════════════════════════════════════════════
// runners/gate.js — THE ASK-FIRST GATE (2026-11-03, Phase 3½ step 2)
// Plain code, $0. Decides what the court may touch. A model never decides this.
// (Lauren Tan's rule: soft rules get forgotten; hard rules don't.)
//
//   free  — output/ : ministries write here without asking
//   ask   — anything else inside C:\Imperium (the Warden, runners, registry,
//           the Brief, edicts, souls…): refused until the Emperor approves
//           that exact file in the Petitions bar. One approval = one write,
//           good for 24 hours.
//   never — outside C:\Imperium, .env, databases, .git, key files, anything
//           named like a token/secret/password/credential: refused, no
//           petition. Reading these is refused too.
// ══════════════════════════════════════════════════════════════════════
const path = require('node:path');

const ROOT      = path.resolve(__dirname, '..');
const FREE_DIRS = ['output'];
const NEVER_ANYWHERE = [/(^|\/)\.env(\.|$)/i, /(^|\/)\.git(\/|$)/i, /\.db(-wal|-shm|-journal)?$/i, /\.(pem|key|pfx|p12)$/i];
const NEVER_OUTSIDE_OUTPUT = [/(token|secret|password|credential)/i];

function rel(p) { return path.relative(ROOT, path.resolve(p)).replace(/\\/g, '/'); }
function isFree(r) { return FREE_DIRS.some(d => r === d || r.startsWith(d + '/')); }

function classify(resolvedPath) {
  const r = rel(resolvedPath);
  if (!r || r.startsWith('..') || path.isAbsolute(r))
    return { verdict: 'never', rel: r, reason: `outside C:\\Imperium (${resolvedPath})` };
  if (NEVER_ANYWHERE.some(re => re.test(r)) || (!isFree(r) && NEVER_OUTSIDE_OUTPUT.some(re => re.test(r))))
    return { verdict: 'never', rel: r, reason: `${r} is protected — secrets, databases and git are off-limits to the court` };
  if (isFree(r)) return { verdict: 'free', rel: r };
  return { verdict: 'ask', rel: r, reason: `${r} is outside output/ — changing the Empire's own files needs the Emperor's approval` };
}

const classifyWrite = classify;
function classifyRead(resolvedPath) {          // reading is fine everywhere except the "never" list
  const c = classify(resolvedPath);
  return c.verdict === 'never' ? c : { verdict: 'free', rel: c.rel };
}

// ── Approvals: one row per file the Emperor said yes to ──
function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, petition_id INTEGER, task_id TEXT, target TEXT NOT NULL,
    granted_at TEXT DEFAULT (datetime('now')), used_at TEXT)`);
  const cols = db.prepare(`PRAGMA table_info(petitions)`).all().map(c => c.name);
  if (cols.length && !cols.includes('kind'))   db.exec(`ALTER TABLE petitions ADD COLUMN kind TEXT DEFAULT 'scope'`);
  if (cols.length && !cols.includes('target')) db.exec(`ALTER TABLE petitions ADD COLUMN target TEXT`);
}
function findApproval(db, resolvedPath) {
  return db.prepare(`SELECT id FROM approvals WHERE target = ? AND used_at IS NULL
                     AND granted_at > datetime('now','-1 day') ORDER BY id LIMIT 1`).get(rel(resolvedPath)) || null;
}
function useApproval(db, id) {
  db.prepare(`UPDATE approvals SET used_at = datetime('now') WHERE id = ?`).run(id);
}

module.exports = { classifyWrite, classifyRead, ensureTables, findApproval, useApproval, rel, ROOT };
