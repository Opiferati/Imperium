'use strict';
// ══════════════════════════════════════════════════════════════════════
// RAVENS' LEAGUE RUNNER (2026-11-09) — Huginn & Muninn's second duty: the Empire's control.
// (Their first duty, the Chancellor's "state of the realm" report, lives in ravens.js.)
// Plain code, $0. Runs C:\Ravens\scan.py AFTER the twins, because it reads their results.
// Measurement only: no broker, no orders, no verdicts (Edict VI).
// ══════════════════════════════════════════════════════════════════════
const ecnalanif = require('./ecnalanif.js');      // same runner: python3 <dir>/scan.py --json, one JSON line back

function runScan(conf = {}) {
  return ecnalanif.runScan({ timeout_min: 3, ...conf, dir: conf.dir || 'C:\\Ravens' });
}

function summaryLine(res) {
  if (res.status === 'riding') return `[RAVENS' LEAGUE] ${res.herald}`;
  if (res.status === 'docked') return `[RAVENS' LEAGUE] ${res.herald || 'Perched: sign C:\\Ravens\\RAVENS_CHARTER.md to fly.'}`;
  return `[RAVENS' LEAGUE] Grounded: ${res.message}`;
}

module.exports = { runScan, summaryLine };
