'use strict';
// ======================================================================
// Fetch the real skimmer fixtures, once. Page Skimmer Phase 1.
//
// NEEDS THE NETWORK. Run by hand only, with Opie's yes:
//     wsl node tools/fetch-skimmer-fixtures.js
// It reads each page with Legion's own reader (runners/page-reader.js),
// limited to the six government data sites, with the character cap lifted,
// and freezes the text into tests/fixtures/skimmer/real/ with a manifest.
// It never overwrites a frozen file: a second run writes nothing that exists.
//
// Honest limit: the reader returns text, not raw bytes, so the manifest's
// sha256 is of the text as frozen, and it says so.
// ======================================================================

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readPage } = require(path.join(__dirname, '..', 'runners', 'page-reader.js'));

const DATA_HOSTS = ['usgs.gov', 'gfz.de', 'gfz-potsdam.de', 'noaa.gov', 'sidc.be', 'treasury.gov'];
const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'skimmer', 'real');

// One page per fixture the design names. Ranges are fixed so the files are small and repeatable.
const PAGES = [
  { file: 'usgs-fdsn-2026-03.csv', parser: 'usgs-fdsn-csv', address: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&starttime=2026-03-01&endtime=2026-03-08&minmagnitude=2.5' },
  { file: 'gfz-kp-json-2026-11.json', parser: 'gfz-kp-json', address: 'https://kp.gfz.de/app/json/?start=2026-11-01T00:00:00Z&end=2026-11-07T21:00:00Z&index=Kp&status=def' },
  { file: 'gfz-Kp_ap_since_1932.txt', parser: 'gfz-kp-file', address: 'https://kp.gfz.de/app/files/Kp_ap_since_1932.txt' },
  { file: 'sidc-SN_d_tot_V2.0.csv', parser: 'sidc-sn-daily', address: 'https://www.sidc.be/SILSO/INFO/sndtotcsv.php', note: 'the site may redirect; the final address decides the parser' },
  { file: 'noaa-planetary-k-index.json', parser: 'noaa-swpc-json', address: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json' },
  { file: 'treasury-yield-2026.csv', parser: 'treasury-yield-csv', address: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv' },
  { file: 'noaa-prose-3-day-forecast.txt', parser: null, address: 'https://services.swpc.noaa.gov/text/3-day-forecast.txt' },
  { file: 'usgs-prose-faq.html.txt', parser: null, address: 'https://www.usgs.gov/programs/earthquake-hazards/science/earthquake-hazards-science' },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { note: 'Frozen real fixtures for the Page Skimmer. sha256 is of the text as returned by the reader, not of raw bytes.', files: [] };
  const have = new Set(manifest.files.map(f => f.file));
  for (const p of PAGES) {
    if (have.has(p.file) || fs.existsSync(path.join(OUT, p.file))) { console.log(`skip ${p.file} (already frozen)`); continue; }
    const at = new Date().toISOString();
    let r;
    try { r = await readPage(p.address, { allowHosts: DATA_HOSTS, maxChars: Number.MAX_SAFE_INTEGER }); }
    catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    const entry = { file: p.file, parser: p.parser, address: p.address, fetched_at: at, ok: !!(r && r.ok), note: p.note || null };
    if (r && r.ok) {
      fs.writeFileSync(path.join(OUT, p.file), r.text, { flag: 'wx' });   // wx: never overwrite
      Object.assign(entry, { final: r.final, status: r.status, type: r.type, chars: r.text.length, truncated: !!r.truncated,
        sha256_of_text: crypto.createHash('sha256').update(r.text).digest('hex') });
    } else entry.error = String((r && r.error) || 'no text').slice(0, 300);
    manifest.files.push(entry);
    console.log(`${entry.ok ? 'froze' : 'FAILED'} ${p.file}${entry.ok ? ` (${entry.chars} chars${entry.truncated ? ', TRUNCATED' : ''})` : `: ${entry.error}`}`);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
