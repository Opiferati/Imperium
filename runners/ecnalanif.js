'use strict';
// ══════════════════════════════════════════════════════════════════════
// ECNALANIF RUNNER (2026-11-03) — the mirror-dimension station's daily scan.
// Plain code, $0. Runs C:\Ecnalanif\scan.py after the Skald's evening reading.
// Measurement only: Ecnalanif has no broker and places no orders (Edict VI).
// ══════════════════════════════════════════════════════════════════════
const fs   = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function toWsl(p) {
  const m = String(p).match(/^([A-Za-z]):[\\/](.*)/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

function runScan(conf = {}) {
  const dir = toWsl(conf.dir || 'C:\\Ecnalanif');
  const script = path.join(dir, 'scan.py');
  if (!fs.existsSync(script)) return Promise.resolve({ status: 'missing', message: `${script} not found` });
  return new Promise(resolve => {
    execFile(conf.python || 'python3', [script, '--json'],
      { cwd: dir, timeout: (conf.timeout_min || 5) * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let res = null;
        try { res = JSON.parse(String(stdout).trim().split('\n').pop()); } catch {}
        resolve(res || { status: 'error', message: (String(stderr).trim().split('\n').slice(-2).join(' ') || (err ? err.message : 'no output')) });
      });
  });
}

function summaryLine(res) {
  if (res.status === 'flying') return `[ECNALANIF] ${res.cogito}`;
  if (res.status === 'docked') return '[ECNALANIF] Fleet docked: sign the Mission Charter (C:\\Ecnalanif\\THESIS_D.md) to launch.';
  return `[ECNALANIF] Scan stopped: ${res.message}`;
}

module.exports = { runScan, summaryLine };
