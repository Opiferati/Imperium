'use strict';
// Page Skimmer table tests (Phase 1, offline). Synthetic fixtures; real ones are skipped until fetched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const sk = require(path.join(__dirname, '..', 'runners', 'skimmer.js'));
const tb = require(path.join(__dirname, '..', 'runners', 'skimmer-tables.js'));

const FIX = path.join(__dirname, 'fixtures', 'skimmer');
const SYN = path.join(FIX, 'synthetic');
const REAL = path.join(FIX, 'real');
const cfg = sk.loadConfig();
const read = f => fs.readFileSync(path.join(SYN, f), 'utf8');
const ADDR = {
  usgs: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&starttime=2026-03-01&endtime=2026-03-05',
  treasury: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve',
  sidc: 'https://www.sidc.be/SILSO/INFO/SN_d_tot_V2.0.csv',
  noaa: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
  gfzjson: 'https://kp.gfz.de/app/json/?start=2026-11-14T00:00:00Z&end=2026-11-15T00:00:00Z&index=Kp',
  gfzfile: 'https://kp.gfz.de/app/files/Kp_ap_since_1932.txt',
};
const tpage = (address, text, extra = {}) => Object.assign({ address, final: address, type: 'text/plain', status: 200, fetched_at: '2026-11-17T00:00:00Z', retrieval: 'full', partial_reason: '', text }, extra);
const skim = (p, rows, opts) => sk.skim(p, { looking_for: 'rows', rows }, cfg, opts);
const invariant = r => assert.strictEqual(r.rows.total, r.rows.matched + r.rows.outside + r.rows.unparsed, 'total = matched + outside + unparsed');

function kpFile(days, startUTC = Date.UTC(1932, 0, 1)) {
  const out = ['# PURPOSE: synthetic file in the Kp_ap_since_1932 layout', '# YYYY MM DD hh.h hh._m        days      days_m     Kp  ap D'];
  for (let d = 0; d < days; d++) {
    const dt = new Date(startUTC + d * 86400000);
    const y = dt.getUTCFullYear(), m = String(dt.getUTCMonth() + 1).padStart(2, '0'), dd = String(dt.getUTCDate()).padStart(2, '0');
    for (let h = 0; h < 24; h += 3) out.push(`${y} ${m} ${dd} ${String(h).padStart(2, '0')}.0 ${(h + 1.5).toFixed(2).padStart(5, '0')} ${(d + h / 24).toFixed(5).padStart(11)} ${(d + h / 24 + 0.0625).toFixed(5).padStart(11)} ${((d * 7 + h) % 27 / 3).toFixed(3)} ${(d + h) % 50} 1`);
  }
  return out.join('\n') + '\n';
}

// A second counter, written separately: plain line loop, no shared code with the filter.
function countKp(text, from, to) {
  let total = 0, matched = 0, unparsed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim() || line[0] === '#') continue;
    const f = line.trim().split(/\s+/);
    if (f.length !== 10 || !/^\d{4}$/.test(f[0])) { total++; unparsed++; continue; }
    total++;
    const d = `${f[0]}-${f[1]}-${f[2]}`;
    if (d >= from && d <= to) matched++;
  }
  return { total, matched, unparsed };
}

test('every address finds its own parser and no other', () => {
  for (const [k, id] of Object.entries({ usgs: 'usgs-fdsn-csv', treasury: 'treasury-yield-csv', sidc: 'sidc-sn-daily', noaa: 'noaa-swpc-json', gfzjson: 'gfz-kp-json', gfzfile: 'gfz-kp-file' })) {
    assert.strictEqual(tb.findParser({ address: ADDR[k] }).id, id, k);
  }
  assert.strictEqual(tb.findParser({ address: 'https://earthquake.usgs.gov.evil.example/fdsnws/event/1/query?format=csv' }), null);
  assert.strictEqual(tb.findParser({ address: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson' }), null);
});

test('GFZ Kp file: a March range is FILTERED, verified, and counted the same by a second counter', async () => {
  const text = kpFile(365 * 3, Date.UTC(2024, 0, 1));
  const r = await skim(tpage(ADDR.gfzfile, text), { from: '2026-03-01', to: '2026-03-31' });
  assert.deepStrictEqual([r.outcome, r.reasons], ['FILTERED', ['RANGE_VERIFIED']]);
  invariant(r);
  const c = countKp(text, '2026-03-01', '2026-03-31');
  assert.deepStrictEqual([r.rows.total, r.rows.matched, r.rows.unparsed], [c.total, c.matched, c.unparsed]);
  assert.strictEqual(r.rows.matched, 31 * 8);
  assert.match(r.hand_off, /^TABLE https:\/\/kp\.gfz\.de\/app\/files\/Kp_ap_since_1932\.txt \(text\/plain\) FILTERED, retrieval full/);
  assert.match(r.hand_off, /248 of 8,760 rows match 2026-03-01 to 2026-03-31; 0 unparsed; file runs 2024-01-01 to 2026-12-30\./);
  assert.ok(r.hand_off.includes('# YYYY MM DD'), 'header notes are kept');
});

test('rows go out exactly as written in the file', async () => {
  const text = kpFile(40, Date.UTC(2026, 0, 1));
  const r = await skim(tpage(ADDR.gfzfile, text), { from: '2026-02-01', to: '2026-02-01' });
  const want = text.split('\n').filter(l => l.startsWith('2026 02 01'));
  for (const l of want) assert.ok(r.hand_off.includes('\n' + l + '\n'), l);
});

test('a range the file does not cover is ABSTAINED, with no rows passed on', async () => {
  const r = await skim(tpage(ADDR.gfzfile, kpFile(30, Date.UTC(2026, 0, 1))), { from: '2026-01-15', to: '2026-03-01' });
  assert.deepStrictEqual([r.outcome, r.reasons], ['ABSTAINED', ['RANGE_NOT_VERIFIED']]);
  assert.match(r.hand_off, /rows seen run 2026-01-01 to 2026-01-30 only, so the range can't be verified/);
  assert.match(r.hand_off, /No rows passed on\./);
  assert.ok(!/\n2026 01 1\d/.test(r.hand_off));
});

test('a partial download (last part only) cannot verify an early range', async () => {
  const text = kpFile(60, Date.UTC(2026, 0, 1)).split('\n').slice(240).join('\n');
  const r = await skim(tpage(ADDR.gfzfile, text, { retrieval: 'partial', partial_reason: 'character cut, last part only' }), { from: '2026-01-02', to: '2026-01-05' });
  assert.strictEqual(r.outcome, 'ABSTAINED');
  assert.ok(r.reasons.includes('PARTIAL_RETRIEVAL'));
  assert.match(r.hand_off, /retrieval partial \(character cut, last part only\)/);
});

test('an unparsed line between matches abstains; one outside them is only counted', async () => {
  const lines = kpFile(20, Date.UTC(2026, 0, 1)).split('\n');
  const inside = lines.slice(); inside.splice(50, 0, 'GARBLED LINE');            // 2026-01-07
  const r1 = await skim(tpage(ADDR.gfzfile, inside.join('\n')), { from: '2026-01-05', to: '2026-01-10' });
  assert.deepStrictEqual([r1.outcome, r1.reasons], ['ABSTAINED', ['UNPARSED_BETWEEN_MATCHES']]);
  invariant(r1);
  const outside = lines.slice(); outside.splice(130, 0, 'GARBLED LINE');         // 2026-01-17
  const r2 = await skim(tpage(ADDR.gfzfile, outside.join('\n')), { from: '2026-01-05', to: '2026-01-10' });
  assert.strictEqual(r2.outcome, 'FILTERED');
  assert.strictEqual(r2.rows.unparsed, 1);
  assert.match(r2.hand_off, /1 unparsed/);
  invariant(r2);
});

test('dates out of order abstain', async () => {
  const lines = kpFile(10, Date.UTC(2026, 0, 1)).split('\n');
  [lines[20], lines[60]] = [lines[60], lines[20]];
  const r = await skim(tpage(ADDR.gfzfile, lines.join('\n')), { from: '2026-01-02', to: '2026-01-05' });
  assert.deepStrictEqual([r.outcome, r.reasons], ['ABSTAINED', ['DATES_OUT_OF_ORDER']]);
});

test('columns and where: only the named columns, only rows that pass', async () => {
  const r = await skim(tpage(ADDR.gfzfile, kpFile(60, Date.UTC(2026, 0, 1))), { from: '2026-01-01', to: '2026-02-28', columns: ['YYYY', 'MM', 'DD', 'Kp'], where: { column: 'Kp', op: '>=', value: 8 } });
  assert.strictEqual(r.outcome, 'FILTERED');
  invariant(r);
  const shown = r.hand_off.split('\n').filter(l => /^2026 /.test(l));
  assert.ok(shown.length > 0);
  for (const l of shown) { const f = l.trim().split(/\s+/); assert.strictEqual(f.length, 4); assert.ok(+f[3] >= 8); }
});

test('an unknown column is a layout mismatch, never a guess', async () => {
  const r = await skim(tpage(ADDR.gfzfile, kpFile(5, Date.UTC(2026, 0, 1))), { from: '2026-01-01', to: '2026-01-02', columns: ['kp_index'] });
  assert.deepStrictEqual([r.outcome, r.reasons], ['ABSTAINED', ['LAYOUT_MISMATCH']]);
});

test('bad row requests abstain', async () => {
  const p = tpage(ADDR.gfzfile, kpFile(5, Date.UTC(2026, 0, 1)));
  for (const rows of [{ from: '2026-01-01' }, { from: '01/01/2026', to: '2026-01-02' }, { from: '2026-01-03', to: '2026-01-01' }]) {
    assert.strictEqual((await skim(p, rows)).outcome, 'ABSTAINED', JSON.stringify(rows));
  }
});

test('no rows asked: header plus the latest 20 rows', async () => {
  const text = kpFile(10, Date.UTC(2026, 0, 1));
  const r = await sk.skim(tpage(ADDR.gfzfile, text), { looking_for: 'Kp' }, cfg);
  assert.deepStrictEqual([r.outcome, r.reasons], ['FILTERED', ['NO_ROWS_ASKED']]);
  const rows = text.trim().split('\n').filter(l => !l.startsWith('#'));
  const shown = r.hand_off.split('\n').filter(l => /^2026 /.test(l));
  assert.deepStrictEqual(shown, rows.slice(-20));
});

test('too many matches: whole rows to the cap, then the "showing rows" line', async () => {
  const r = await skim(tpage(ADDR.gfzfile, kpFile(400, Date.UTC(2025, 0, 1))), { from: '2025-01-01', to: '2025-12-31' }, { cap: 6000 });
  assert.strictEqual(r.outcome, 'FILTERED');
  assert.ok(r.hand_off.length <= 6000);
  assert.match(r.hand_off, /\[showing rows 1 to \d+ of 2,920 matched, last date shown 2025-\d\d-\d\d; ask again with a narrower range\.\]$/);
  for (const l of r.hand_off.split('\n').filter(x => /^2025 /.test(x))) assert.strictEqual(l.trim().split(/\s+/).length, 10, 'no row is cut');
});

test('F11 USGS CSV: two-line quoted places, doubled quotes, duplicate rows kept and counted', async () => {
  const r = await skim(tpage(ADDR.usgs, read('usgs-edge.csv'), { type: 'text/csv' }), { from: '2026-03-01', to: '2026-03-04' });
  assert.deepStrictEqual([r.outcome, r.reasons], ['FILTERED', ['RANGE_VERIFIED']]);
  assert.deepStrictEqual([r.rows.total, r.rows.matched, r.rows.unparsed], [6, 6, 0]);
  invariant(r);
  assert.ok(r.hand_off.includes('"Anchorage\nAlaska (two-line place)"'));
  assert.strictEqual(r.hand_off.split('"He said ""big one"", Hawaii"').length - 1, 2, 'the duplicate row is shown, not merged');
});

test('F11 USGS CSV: magnitude filter', async () => {
  const r = await skim(tpage(ADDR.usgs, read('usgs-edge.csv')), { from: '2026-03-01', to: '2026-03-04', where: { column: 'mag', op: '>=', value: 4 } });
  assert.strictEqual(r.rows.matched, 3);
  invariant(r);
});

test('F11 USGS CSV: a footnote inside the matches abstains', async () => {
  const r = await skim(tpage(ADDR.usgs, read('usgs-footnote-inside.csv')), { from: '2026-03-01', to: '2026-03-03' });
  assert.deepStrictEqual([r.outcome, r.reasons], ['ABSTAINED', ['UNPARSED_BETWEEN_MATCHES']]);
});

test('F11 USGS CSV: a title line above the header is a layout mismatch', async () => {
  const r = await skim(tpage(ADDR.usgs, read('usgs-two-headers.csv')), { from: '2026-03-01', to: '2026-03-01' });
  assert.deepStrictEqual([r.outcome, r.reasons], ['ABSTAINED', ['LAYOUT_MISMATCH']]);
});

test('F11 USGS CSV: mixed and missing dates are unparsed, and abstain when they sit between matches', async () => {
  const r = await skim(tpage(ADDR.usgs, read('usgs-mixed-dates.csv')), { from: '2026-03-01', to: '2026-03-03' });
  assert.strictEqual(r.rows.unparsed, 2);
  assert.strictEqual(r.outcome, 'ABSTAINED');
  invariant(r);
});

test('Treasury CSV: slash dates, newest first, verified', async () => {
  const r = await skim(tpage(ADDR.treasury, read('treasury-sample.csv')), { from: '2026-11-12', to: '2026-11-13', columns: ['Date', '10 Yr'] });
  assert.deepStrictEqual([r.outcome, r.rows.matched, r.rows.direction], ['FILTERED', 2, -1]);
  assert.ok(r.hand_off.includes('\n11/13/2026,4.15\n'));
});

test('SIDC sunspot file: semicolons, the -1 missing marker passes through as written', async () => {
  const r = await skim(tpage(ADDR.sidc, read('sidc-sample.csv')), { from: '2026-11-01', to: '2026-11-04' });
  assert.strictEqual(r.outcome, 'FILTERED');
  assert.strictEqual(r.rows.matched, 4);
  assert.ok(r.hand_off.includes('2026;11;03;2026.842;  -1; -1.0;   0;0'));
});

test('NOAA JSON: numbers kept as written; descending order is fine', async () => {
  const r = await skim(tpage(ADDR.noaa, read('noaa-kp.json'), { type: 'application/json' }), { from: '2026-11-14', to: '2026-11-14' });
  assert.deepStrictEqual([r.outcome, r.rows.matched], ['FILTERED', 3]);
  assert.ok(r.hand_off.includes('["2026-11-14 03:00:00.000","5.00","48","8"]'));
  const d = await skim(tpage(ADDR.noaa, read('noaa-kp-descending.json')), { from: '2026-11-14', to: '2026-11-14' });
  assert.deepStrictEqual([d.outcome, d.rows.matched, d.rows.direction], ['FILTERED', 2, -1]);
});

test('GFZ JSON: lists become rows, other keys become notes, 5.000 stays 5.000', async () => {
  const r = await skim(tpage(ADDR.gfzjson, read('gfz-kp.json')), { from: '2026-11-14', to: '2026-11-14' });
  assert.deepStrictEqual([r.outcome, r.rows.matched], ['FILTERED', 2]);
  assert.ok(r.hand_off.includes('"2026-11-14T03:00:00Z",5.000,"def"'));
  assert.ok(r.hand_off.includes('meta: {"source":"synthetic"}'));
});

test('rows asked of a table with no parser abstain; without rows it passes through', async () => {
  const p = tpage('https://example.org/data.csv', 'a,b\n1,2\n', { type: 'text/csv' });
  const r = await skim(p, { from: '2026-01-01', to: '2026-01-02' });
  assert.deepStrictEqual([r.outcome, r.reasons], ['ABSTAINED', ['NO_PARSER']]);
  const q = await sk.skim(p, { looking_for: 'a b values' }, cfg);
  assert.deepStrictEqual([q.outcome, q.reasons], ['PASSTHROUGH', ['NOT_PROSE']]);
});

test('F12: a failed or refused download is UNAVAILABLE, never reported as a dataset', async () => {
  for (const error of ['file larger than 5,000,000 bytes', 'unzipped size passed 20,000,000 bytes']) {
    const r = await skim({ address: ADDR.gfzfile, ok: false, error }, { from: '2026-01-01', to: '2026-01-02' });
    assert.strictEqual(r.outcome, 'UNAVAILABLE');
    assert.strictEqual(r.rows, null);
  }
});

test('a forced table error gives PASSTHROUGH inside the cap', async () => {
  const text = kpFile(2000);
  const r = await skim(tpage(ADDR.gfzfile, text), { from: '1932-01-01', to: '1932-01-02' }, { failAt: 'table' });
  assert.deepStrictEqual([r.outcome, r.reasons], ['PASSTHROUGH', ['SKIMMER_FAILED']]);
  assert.ok(r.hand_off.length <= r.cap);
});

test('a slow table filter times out into PASSTHROUGH', async () => {
  let t = 0;
  const r = await skim(tpage(ADDR.gfzfile, kpFile(2000)), { from: '1932-01-01', to: '1932-01-02' }, { now: () => (t += 5000) });
  assert.deepStrictEqual([r.outcome, r.reasons], ['PASSTHROUGH', ['SKIMMER_TIMEOUT']]);
});

test('big file: a 95-year Kp file streams from disk (plain and gzip) under the memory ceiling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-big-'));
  try {
    const text = kpFile(95 * 365);                 // about 277,000 rows
    const plain = path.join(dir, 'Kp_ap_since_1932.txt');
    fs.writeFileSync(plain, text);
    fs.writeFileSync(plain + '.gz', zlib.gzipSync(text));
    const expect = countKp(text, '1990-06-01', '1990-06-30');
    const script = `
      const sk = require(${JSON.stringify(path.join(__dirname, '..', 'runners', 'skimmer.js'))});
      const cfg = sk.loadConfig();
      (async () => {
        const out = [];
        for (const f of process.argv.slice(1)) {
          const r = await sk.skim({ address: ${JSON.stringify(ADDR.gfzfile)}, type: 'text/plain', retrieval: 'full', sha256: 'x', path: f },
            { looking_for: 'Kp', rows: { from: '1990-06-01', to: '1990-06-30' } }, cfg);
          out.push({ outcome: r.outcome, total: r.rows.total, matched: r.rows.matched, unparsed: r.rows.unparsed, len: r.hand_off.length, cap: r.cap });
        }
        out.push({ rssMB: process.resourceUsage().maxRSS / 1024 });
        process.stdout.write(JSON.stringify(out));
      })();`;
    const run = spawnSync(process.execPath, ['-e', script, plain, plain + '.gz'], { encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    for (const r of out.slice(0, 2)) {
      assert.deepStrictEqual([r.outcome, r.total, r.matched, r.unparsed], ['FILTERED', expect.total, expect.matched, expect.unparsed]);
      assert.ok(r.len <= r.cap);
    }
    assert.ok(out[2].rssMB < cfg.settings.limits.memory_ceiling_mb, `peak memory ${out[2].rssMB.toFixed(0)} MB`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// -- real fixtures: present only after tools/fetch-skimmer-fixtures.js has been run --
const manifestPath = path.join(REAL, 'manifest.json');
test('real frozen files match their declared layouts', { skip: !fs.existsSync(manifestPath) && 'real fixtures not fetched yet (run tools/fetch-skimmer-fixtures.js)' }, async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const f of manifest.files) {
    if (!f.ok || !f.parser) continue;
    const text = fs.readFileSync(path.join(REAL, f.file), 'utf8');
    const r = await sk.skim(tpage(f.final || f.address, text, { type: f.type, retrieval: f.truncated ? 'partial' : 'full' }), { looking_for: 'rows' }, cfg);
    assert.strictEqual(r.outcome, 'FILTERED', `${f.file}: ${r.outcome} ${r.reasons} ${r.why || ''}`);
    assert.ok(r.rows.unparsed * 100 <= r.rows.total, `${f.file}: ${r.rows.unparsed} of ${r.rows.total} rows unparsed`);
  }
});
