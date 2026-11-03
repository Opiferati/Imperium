'use strict';
// ══════════════════════════════════════════════════════════════════════
// TREASURY RUNNER v2.0 (2026-11-01) — measurement only after Finalance v2's KILL
// Runs the Finalance v2 paper scan as plain code. No model is involved:
// no AI ever makes, changes or second-guesses a trade (Edict VI).
// ══════════════════════════════════════════════════════════════════════
const fs   = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function toWsl(p) {
  const m = String(p).match(/^([A-Za-z]):[\\/](.*)/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

function runScan(conf) {
  const dir = toWsl(conf.finalance_dir || 'C:\\Finalance');
  const venvPy = path.join(dir, conf.python || '.venv-v2/bin/python');
  const py = fs.existsSync(venvPy) ? venvPy : 'python3';
  return new Promise(resolve => {
    execFile(py, [path.join(dir, 'treasury_refresh.py'), '--json'],
      { cwd: dir, timeout: (conf.timeout_min || 10) * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let res = null;
        try { res = JSON.parse(String(stdout).trim().split('\n').pop()); } catch {}
        if (!res) {
          res = { status: 'error', message: (err && err.killed) ? 'Refresh timed out.'
                  : (String(stderr).trim().split('\n').slice(-3).join(' ') || (err ? err.message : 'No output from refresh')) };
        }
        resolve(res);
      });
  });
}

const label = v => v == null ? '—' : v <= 25 ? 'Extreme Fear' : v <= 45 ? 'Fear' : v <= 55 ? 'Neutral' : v <= 75 ? 'Greed' : 'Extreme Greed';
const gv = g => (Array.isArray(g) && g[1] != null) ? `${g[1]} ${label(g[1])} (${g[0]})` : '—';

function report(res) {
  if (res.status !== 'ok') {
    return `# Treasury refresh — FAILED\n\n${res.message}\n\nNothing was overwritten. Fix the data source, then press Treasury again.\n`;
  }
  const tc = res.thesis_c || {}, sk = res.skald_last;
  const added = Object.entries(res.added || {}).filter(([, n]) => n > 0).map(([a, n]) => `${a} +${n}`).join(', ') || 'already current';
  const lines = [
    `# Treasury — prices, gauges, Thesis C`,
    `Prices as of **${res.as_of}** · new bars: ${added}`,
    ``,
    `| Gauge | Reading |`, `|---|---|`,
    `| Crypto Fear & Greed | ${gv(res.crypto_fg)} |`,
    `| Stock Fear Gauge | ${gv(res.stock_gauge)} |`,
    sk ? `| Skald (last, ${sk.date}) | crypto ${sk.crypto_mood} · stocks ${sk.stock_mood} |` : `| Skald | no reading yet |`,
    ``,
    `## Thesis C — news vs price mood`,
    tc.sealed ? `**Sealed.** Read the verdict with \`thesis_c.py --show-sealed\`.` :
      `Stocks **${tc.stocks_valid} / ${tc.needed}** valid readings (${tc.stocks_waiting} waiting on prices) · ` +
      `Crypto **${tc.crypto_valid} / ${tc.needed}** (${tc.crypto_waiting} waiting). ` +
      (tc.stocks_valid >= tc.needed && tc.crypto_valid >= tc.needed ? '**Checkpoint READY** — run `thesis_c.py --checkpoint`.' : 'Results stay hidden until the checkpoint.'),
  ];
  if (res.note) lines.push('', `_${res.note}_`);
  lines.push('', '_Measurement only — no trading of any kind (Edict VI). Finalance v2 was KILLED on 2026-11-01._');
  return lines.join('\n') + '\n';
}

function summaryLine(res) {
  if (res.status !== 'ok') return `[FAILED] Treasury refresh: ${res.message}`;
  const tc = res.thesis_c || {};
  return `Treasury: prices as of ${res.as_of} · crypto F&G ${gv(res.crypto_fg)} · stock gauge ${gv(res.stock_gauge)} · ` +
         `Thesis C ${tc.stocks_valid}/${tc.needed} stocks, ${tc.crypto_valid}/${tc.needed} crypto`;
}

module.exports = { runScan, report, summaryLine, toWsl };
