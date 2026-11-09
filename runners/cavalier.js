'use strict';
// ══════════════════════════════════════════════════════════════════════
// CAVALIER RUNNER (2026-11-08) — the third twin's daily scan (Thesis E: the crowd's attention).
// Plain code, $0. Runs C:\Cavalier\scan.py right after Ecnalanif's scan.
// Measurement only: the Cavalier has no broker and places no orders (Edict VI).
// ══════════════════════════════════════════════════════════════════════
const ecnalanif = require('./ecnalanif.js');      // same runner: python3 <dir>/scan.py --json, one JSON line back

function runScan(conf = {}) {
  return ecnalanif.runScan({ timeout_min: 5, ...conf, dir: conf.dir || 'C:\\Cavalier' });
}

function summaryLine(res) {
  if (res.status === 'riding') return `[CAVALIER] ${res.herald}`;
  if (res.status === 'docked') return `[CAVALIER] ${res.herald || 'In the stable: sign C:\\Cavalier\\THESIS_E.md to ride.'}`;
  return `[CAVALIER] Scan stopped: ${res.message}`;
}

module.exports = { runScan, summaryLine };
