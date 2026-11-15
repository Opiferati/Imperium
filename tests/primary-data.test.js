'use strict';
// PRIMARY DATA BRIDGE (tests written 2026-11-14). Mock fetch only; no network.
const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const pd       = require('../runners/primary-data.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
const okRes = body => ({ ok: true, status: 200, text: async () => body });
const swpcBody = JSON.stringify([
  { 'time-tag': '1972-12', ssn: 50 },
  { 'time-tag': '1973-01', ssn: 40 }, { 'time-tag': '1973-02', ssn: 60 },
  { 'time-tag': '1974-01', ssn: 10 } ]);
const goodFetch = async url => url.includes('swpc') ? okRes(swpcBody)
  : okRes(url.includes('minmagnitude=7') ? '15\n' : '140\n');

test('needs() reads the order', () => {
  assert.deepStrictEqual(pd.needs('Use the USGS earthquake catalogue and NOAA SWPC'), { usgs: true, swpc: true });
  assert.deepStrictEqual(pd.needs('sunspot activity only'), { usgs: false, swpc: true });
  assert.deepStrictEqual(pd.needs('write a poem'), { usgs: false, swpc: false });
});

test('good fetch: counts per year, frozen to disk, current year partial', async () => {
  const root = tmp();
  const sets = await pd.gather(root, 'USGS and SWPC', { fetch: goodFetch, date: '1974-06-01' });
  const u = sets.find(s => s.name === 'usgs-m6'), s = sets.find(s => s.name === 'swpc-ssn');
  assert.ok(u.ok && s.ok);
  assert.deepStrictEqual(u.rows.map(r => [r.year, r.m6, r.m7, r.partial]), [[1973, 140, 15, false], [1974, 140, 15, true]]);
  assert.deepStrictEqual(s.rows.map(r => [r.year, r.mean_ssn, r.partial]), [[1973, 50, true], [1974, 10, true]]);
  assert.ok(fs.existsSync(path.join(root, 'data', 'primary', 'usgs-m6-1974-06-01.json')));
});

test('frozen file is reused the same day, network untouched', async () => {
  const root = tmp();
  await pd.gather(root, 'USGS', { fetch: goodFetch, date: '1974-06-01' });
  let calls = 0;
  const sets = await pd.gather(root, 'USGS', { fetch: async () => { calls++; return okRes('999'); }, date: '1974-06-01' });
  assert.strictEqual(calls, 0);
  assert.ok(sets[0].reused);
  assert.strictEqual(sets[0].rows[0].m6, 140);
});

test('one failed year fails the whole dataset; nothing is written or filled', async () => {
  const root = tmp();
  const bad = async url => url.includes('starttime=1974') ? { ok: false, status: 503, text: async () => '' } : okRes('140');
  const sets = await pd.gather(root, 'USGS', { fetch: bad, date: '1974-06-01' });
  assert.strictEqual(sets[0].ok, false);
  assert.strictEqual(sets[0].rows, undefined);
  assert.ok(!fs.existsSync(path.join(root, 'data', 'primary', 'usgs-m6-1974-06-01.json')));
  assert.match(pd.toPrompt(sets), /FAILED .*Counts unknown/);
});

test('a non-number count is a failure, not a zero', async () => {
  const sets = await pd.gather(tmp(), 'USGS', { fetch: async () => okRes('<html>error</html>'), date: '1973-06-01' });
  assert.strictEqual(sets[0].ok, false);
});

test('a thrown network error never escapes gather()', async () => {
  const sets = await pd.gather(tmp(), 'SWPC', { fetch: async () => { throw new Error('ENOTFOUND'); }, date: '1973-06-01' });
  assert.strictEqual(sets[0].ok, false);
  assert.match(sets[0].error, /ENOTFOUND/);
});

test('toPrompt marks data PRIMARY and partial years', async () => {
  const sets = await pd.gather(tmp(), 'USGS', { fetch: goodFetch, date: '1974-06-01' });
  const p = pd.toPrompt(sets);
  assert.match(p, /PRIMARY/);
  assert.match(p, /1974\* \| 140 \| 15/);
  assert.strictEqual(pd.toPrompt([]), '');
});
