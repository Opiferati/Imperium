'use strict';
// NOTE: This CommonJS shape (module.exports = { run, summaryLine }) was ASSUMED,
// not copied from cards/testcard/index.js, which the author could not read.
// diskwatch is read-only: no writes, no board posts, no model calls, no network.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GB = 1024 ** 3;
const GDRIVE = '/mnt/g/My Drive';

function round(n) { return Math.round(n * 100) / 100; }

function brief(e) {
  const m = e && (e.code || e.message) ? String(e.code || e.message) : 'unknown error';
  return m.replace(/\s+/g, ' ').slice(0, 120);
}

function good(freeBytes, totalBytes, via) {
  return { state: 'ok', free_gb: round(freeBytes / GB), total_gb: round(totalBytes / GB), via };
}

// Measure one path. Never throws. Returns { state:'ok', ... } or { state:'unreadable', error }.
function measure(p) {
  let why = 'statfsSync unavailable';
  if (typeof fs.statfsSync === 'function') {
    try {
      const s = fs.statfsSync(p);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      if (Number.isFinite(total) && Number.isFinite(free) && total > 0) {
        return good(free, total, 'statfs');
      }
      why = 'statfs returned unusable values';
    } catch (e) {
      why = 'statfs failed: ' + brief(e);
    }
  }
  try {
    const out = execFileSync('df', ['-Pk', p], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = String(out).trim().split('\n');
    const m = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.*)$/.exec(lines[lines.length - 1]);
    if (m) {
      const total = Number(m[2]) * 1024;
      const free = Number(m[4]) * 1024;
      if (Number.isFinite(total) && Number.isFinite(free) && total > 0) {
        return good(free, total, 'df');
      }
    }
    return { state: 'unreadable', error: why + '; df output not understood' };
  } catch (e) {
    return { state: 'unreadable', error: why + '; df failed: ' + brief(e) };
  }
}

function run(ctx) {
  try {
    const root = ctx && typeof ctx.root === 'string' && ctx.root.trim() ? ctx.root : null;

    let imperium;
    if (root) {
      imperium = Object.assign({ path: path.resolve(root) }, measure(root));
    } else {
      imperium = { path: null, state: 'unreadable', error: 'ctx.root missing' };
    }

    let gdrive;
    try {
      if (!fs.existsSync(GDRIVE)) {
        gdrive = { path: GDRIVE, state: 'absent' };
      } else {
        gdrive = Object.assign({ path: GDRIVE }, measure(GDRIVE));
      }
    } catch (e) {
      gdrive = { path: GDRIVE, state: 'unreadable', error: brief(e) };
    }

    if (imperium.state !== 'ok' && gdrive.state !== 'ok') {
      const g = gdrive.state === 'absent' ? 'Google Drive not mounted' : 'Google Drive unreadable (' + gdrive.error + ')';
      return { status: 'thin', message: 'Imperium drive unreadable (' + imperium.error + '); ' + g };
    }
    return { status: 'ok', imperium, gdrive };
  } catch (e) {
    return { status: 'thin', message: 'diskwatch failed unexpectedly: ' + brief(e) };
  }
}

function fmt(n) { return Number.isFinite(n) ? n.toFixed(2) : '?'; }

function summaryLine(r) {
  try {
    if (!r || typeof r !== 'object') return '[DISKWATCH] no result to report';
    if (r.status === 'thin') {
      return '[DISKWATCH] thin: ' + String(r.message || 'no reason given').replace(/\s+/g, ' ');
    }
    if (r.status !== 'ok') return '[DISKWATCH] result not recognised';

    const i = r.imperium;
    const g = r.gdrive;
    let a;
    if (i && i.state === 'ok') {
      a = 'Imperium drive ' + fmt(i.free_gb) + ' GB free of ' + fmt(i.total_gb) + ' GB';
    } else {
      a = 'Imperium drive could not be read (' + String((i && i.error) || 'no data').replace(/\s+/g, ' ') + ')';
    }
    let b;
    if (g && g.state === 'ok') {
      b = 'Google Drive ' + fmt(g.free_gb) + ' GB free';
    } else if (g && g.state === 'absent') {
      b = 'Google Drive not mounted';
    } else {
      b = 'Google Drive could not be read (' + String((g && g.error) || 'no data').replace(/\s+/g, ' ') + ')';
    }
    return '[DISKWATCH] ' + a + '; ' + b;
  } catch (e) {
    return '[DISKWATCH] summary unavailable';
  }
}

module.exports = { run, summaryLine };
