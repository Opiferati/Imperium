'use strict';
// ══════════════════════════════════════════════════════════════════════
// THESIS H — the one look (sealed). Built 2026-11-15, before any result exists.
//
// This module holds the scoring math the charter fixes, so it is committed
// before the first quake is read: the aftershock rule (rule 7), the score
// (rule 9), the exact conditional binomial interval, and the verdict ladder.
//
// open() refuses, in this order: before the opening date; while any item in
// PENDING_RULINGS is unsettled; after a verdict has already been sealed; and,
// until the scoring of episodes, windows and controls is written to Amendment 2,
// always. Nothing here reads a quake file until open() runs.
// ══════════════════════════════════════════════════════════════════════

const fs   = require('node:fs');
const path = require('node:path');

const DAY_MS = 86400000;

// Every question the charter left open, by number, so a ruling can be pointed at
// exactly. R1-R10 were settled by Amendment 2 (CM 2026-11-15), items 1-10.
const SETTLED = Object.freeze({
  R1:  'Amendment 2 item 1: a late call counts if made by midnight UTC on t+1, marked late; otherwise the day abstains',
  R2:  'Amendment 2 item 2: an abstained day is not quiet and breaks the 3-day run',
  R3:  'Amendment 2 item 3: 3-day blocks never cross a test window or an abstained day; leftovers under 3 days dropped',
  R4:  'Amendment 2 item 4: whole-day shifts 1..period-1, mulberry32 seeded 20261114, a tie counts as the Jester beating it',
  R5:  "Amendment 2 item 5: GFZ Potsdam final Kp and NOAA archived event reports, same calendar days 11 years earlier; Feb 29, 2028 skipped",
  R6:  'Amendment 2 item 6: 2026-11-15 through 2028-11-14 UTC; a window or block past the end is dropped',
  R7:  'Amendment 2 item 7: the next snapshot stands in; none within 5 days and the window abstains',
  R8:  'Amendment 2 item 8: USGS type "earthquake" only',
  R9:  'Amendment 2 item 9: k = test-period days / scored episodes, rounded down, from day one',
  R10: 'Amendment 2 item 10: great-circle distance between epicentres, depth ignored',
});

// Still open. Each is settled only by a dated, initialed amendment.
const PENDING_RULINGS = Object.freeze([
  'R11 a flare that peaked on the day with no readable class, on a day nothing else triggers: an incomplete read (Amendment 2 item 1) or its own ruling',
]);

// ── rule 7: mainshocks only ───────────────────────────────────────────
function km(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A quake is thrown out if an earlier quake of equal or bigger magnitude
 *  happened within 300 km and the 30 days before it. Nothing else is thrown out.
 *  "Earlier quake" means any earlier quake in the catalog, thrown out or not. */
function mainshocks(quakes) {
  const qs = [...quakes].sort((a, b) => a.time - b.time);
  return qs.filter(q => !qs.some(e => e.time < q.time && q.time - e.time <= 30 * DAY_MS && e.mag >= q.mag && km(e, q) <= 300));
}

// ── the exact conditional binomial interval ───────────────────────────
function logChoose(n, k) { return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1); }
function lgamma(x) {   // Lanczos, good to ~1e-13 for x > 0
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function binomCdf(k, n, p) {          // P(X <= k)
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
}
function solve(f, target) {           // f decreasing in p on [0,1]
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(mid) > target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
/** Clopper-Pearson 95% interval for a binomial share x of n. */
function clopperPearson(x, n, alpha = 0.05) {
  // lower: the smallest share q with P(X >= x | q) >= alpha/2; upper: the largest with P(X <= x | q) >= alpha/2
  let lower = 0;
  if (x > 0) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (1 - binomCdf(x - 1, n, mid) < alpha / 2) lo = mid; else hi = mid; }
    lower = (lo + hi) / 2;
  }
  const upper = x === n ? 1 : solve(q => binomCdf(x, n, q), alpha / 2);
  return { lower, upper };
}

/**
 * The score (rule 9) and its 95% interval. Given the total mainshocks N, x fell
 * in test windows; with nTest and nBench windows of equal length, under rate
 * ratio RR the share in test windows is RR*nTest / (RR*nTest + nBench). The
 * interval for that share maps one-to-one onto an interval for RR.
 */
function rateRatio(xTest, nTest, xBench, nBench) {
  const N = xTest + xBench;
  const toRR = s => (s >= 1 ? Infinity : (s / (1 - s)) * (nBench / nTest));
  const point = xBench === 0 ? (xTest === 0 ? null : Infinity) : (xTest / nTest) / (xBench / nBench);
  if (N === 0) return { rr: null, lower: 0, upper: Infinity, n: 0 };
  const ci = clopperPearson(xTest, N);
  return { rr: point, lower: toRR(ci.lower), upper: toRR(ci.upper), n: N };
}

// ── the verdict ladder: top to bottom, the first that fits wins ───────
function ladder({ scoredEpisodes, windowsTotal, windowsAbstained, real, squire, jesterBeatShare }) {
  const abstFrac = windowsTotal > 0 ? windowsAbstained / windowsTotal : 1;
  if (scoredEpisodes < 10 || abstFrac > 0.20) return 'UNTESTED';
  if (squire && squire.lower > 1.0) return 'WE BROKE IT';
  if (real.lower > 1.0 && jesterBeatShare >= 0.975) return 'PASS';
  if (real.upper < 2.0) return 'KILL';
  return 'UNTESTED';
}

// ── the strong-form line (rule 10) ────────────────────────────────────
const strongFormDead = testWindowCounts => testWindowCounts.some(n => n === 0);

// ── the one look ──────────────────────────────────────────────────────
function opensAt(root) {
  const info = JSON.parse(fs.readFileSync(path.join(root, 'state', 'thesis_h', 'launch.json'), 'utf8'));
  return Date.parse(info.verdict_opens);
}

function open(root, { now = Date.now() } = {}) {
  const sealed = path.join(root, 'state', 'thesis_h', 'verdict.json');
  if (fs.existsSync(sealed)) return { ok: false, why: 'the verdict is already sealed; it opens once' };
  let at;
  try { at = opensAt(root); } catch { return { ok: false, why: 'not launched' }; }
  if (now < at) return { ok: false, why: `sealed until ${new Date(at).toISOString()}` };
  if (PENDING_RULINGS.length) return { ok: false, why: `rulings still pending: ${PENDING_RULINGS.length}` };
  return { ok: false, why: 'the one look (episodes, windows, controls) is not written yet' };
}

module.exports = { SETTLED, PENDING_RULINGS, km, mainshocks, clopperPearson, binomCdf, rateRatio, ladder, strongFormDead, open, opensAt };
