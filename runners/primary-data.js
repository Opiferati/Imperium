'use strict';
// ----------------------------------------------------------------------------
// THE PRIMARY DATA BRIDGE (2026-11-14)
//
// Why: the Ministry of Intelligence has only web search, so it could never
// query the USGS catalogue or NOAA SWPC itself. It said so honestly, but the
// counts an order asked for were never pulled. This runner pulls them with
// plain code BEFORE the ministry starts, and hands them over as its primary
// source.
//
// Laws kept:
//   - No mock data. If any part of a dataset fails, the WHOLE dataset is
//     marked FAILED and the ministry is told the counts are unknown. Nothing
//     is filled in, carried forward, or estimated.
//   - Frozen at first sight. A dataset fetched OK is written to
//     data/primary/<name>-<date>.json with its fetch time and exact query,
//     and that file is reused for the rest of that day, never rewritten.
//   - Plain code. No model chooses an address. The only hosts touched are
//     earthquake.usgs.gov and services.swpc.noaa.gov.
// ----------------------------------------------------------------------------

const fs   = require('node:fs');
const path = require('node:path');

const USGS_RE = /\bUSGS\b|earthquake catalog/i;
const SWPC_RE = /\bSWPC\b|sunspot|solar cycle/i;
const FIRST_YEAR = 1973;            // start of the USGS global catalogue's consistent era
const TIMEOUT_MS = 15_000;

function needs(text) {
  const t = String(text || '');
  return { usgs: USGS_RE.test(t), swpc: SWPC_RE.test(t) };
}

function today() { return new Date().toISOString().slice(0, 10); }
function dir(root) { return path.join(root, 'data', 'primary'); }
function frozenPath(root, name, date) { return path.join(dir(root), `${name}-${date}.json`); }

function readFrozen(root, name, date) {
  try {
    const j = JSON.parse(fs.readFileSync(frozenPath(root, name, date), 'utf8'));
    return j && j.ok ? j : null;
  } catch { return null; }
}
function freeze(root, ds, date) {
  fs.mkdirSync(dir(root), { recursive: true });
  const p = frozenPath(root, ds.name, date);
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(ds, null, 2), { flag: 'wx' });
  return p;
}

async function getText(fetchFn, url) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// USGS ComCat count API: one exact count per calendar year, M6+ and M7+.
async function usgs(fetchFn, nowYear) {
  const tmpl = 'https://earthquake.usgs.gov/fdsnws/event/1/count?starttime={Y}-01-01&endtime={Y+1}-01-01&minmagnitude={M}';
  const rows = [];
  for (let y = FIRST_YEAR; y <= nowYear; y++) {
    const row = { year: y, partial: y === nowYear };
    for (const m of [6, 7]) {
      const url = `https://earthquake.usgs.gov/fdsnws/event/1/count?starttime=${y}-01-01&endtime=${y + 1}-01-01&minmagnitude=${m}`;
      const n = Number(String(await getText(fetchFn, url)).trim());
      if (!Number.isInteger(n) || n < 0) throw new Error(`bad count for ${y} M${m}+`);
      row[`m${m}`] = n;
    }
    rows.push(row);
  }
  return { name: 'usgs-m6', source: 'USGS ComCat count API (earthquake.usgs.gov/fdsnws/event/1/count)', query: tmpl, rows };
}

// NOAA SWPC observed solar cycle indices: monthly sunspot number, averaged per year.
async function swpc(fetchFn, nowYear) {
  const url = 'https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json';
  const data = JSON.parse(await getText(fetchFn, url));
  if (!Array.isArray(data) || !data.length) throw new Error('empty SWPC series');
  const by = new Map();
  for (const r of data) {
    const y = Number(String(r['time-tag'] || '').slice(0, 4));
    const s = Number(r.ssn);
    if (!y || y < FIRST_YEAR || !Number.isFinite(s)) continue;
    if (!by.has(y)) by.set(y, []);
    by.get(y).push(s);
  }
  const rows = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([y, v]) => ({
    year: y, months: v.length, mean_ssn: Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10,
    partial: v.length < 12 }));
  if (!rows.length) throw new Error('no SWPC years after filtering');
  return { name: 'swpc-ssn', source: 'NOAA SWPC observed solar cycle indices (services.swpc.noaa.gov)', query: url, rows };
}

/** gather(root, orderText, {fetch}) -> [{name, ok, ...}] ; never throws. */
async function gather(root, orderText, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const date = opts.date || today();
  const nowYear = Number(date.slice(0, 4));
  const want = needs(orderText);
  const jobs = [];
  if (want.usgs) jobs.push(['usgs-m6', usgs]);
  if (want.swpc) jobs.push(['swpc-ssn', swpc]);
  const out = [];
  for (const [name, fn] of jobs) {
    const frozen = readFrozen(root, name, date);
    if (frozen) { out.push({ ...frozen, reused: true }); continue; }
    try {
      const ds = { ...(await fn(fetchFn, nowYear)), ok: true, fetched_at: new Date().toISOString() };
      ds.file = freeze(root, ds, date);
      out.push(ds);
    } catch (e) {
      out.push({ name, ok: false, error: e.message, fetched_at: new Date().toISOString() });
    }
  }
  return out;
}

function toPrompt(sets) {
  if (!sets || !sets.length) return '';
  const parts = ['## PRIMARY DATA - fetched by the Warden in plain code before you started',
    'These are the official datasets your order names. Cite each as a PRIMARY source in your Sources list, ' +
    'with its source line and fetch time. Use these numbers for the counts; do not replace them with figures from search. ' +
    'If a dataset says FAILED, the counts are UNKNOWN: say so, and do not fill them from anywhere else.'];
  for (const s of sets) {
    if (!s.ok) { parts.push(`### ${s.name}: FAILED (${s.error}) at ${s.fetched_at}. Counts unknown.`); continue; }
    parts.push(`### ${s.name} - ${s.source}\nFetched ${s.fetched_at}. Query: ${s.query}. Rows marked * are partial years.`);
    if (s.name === 'usgs-m6') {
      parts.push('year | M6+ | M7+\n' + s.rows.map(r => `${r.year}${r.partial ? '*' : ''} | ${r.m6} | ${r.m7}`).join('\n'));
    } else {
      parts.push('year | mean sunspot number | months\n' + s.rows.map(r => `${r.year}${r.partial ? '*' : ''} | ${r.mean_ssn} | ${r.months}`).join('\n'));
    }
  }
  return parts.join('\n\n');
}

module.exports = { needs, gather, toPrompt, USGS_RE, SWPC_RE };
