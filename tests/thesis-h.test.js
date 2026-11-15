'use strict';
// THESIS H — the lock, the solar call, the quake snapshots, the page, and the sealed look.
// The load-bearing tests: a changed charter stops every run; a call is frozen once
// and never rewritten; a failed source writes nothing and later abstains; only the
// cases the charter and its amendments settle get TRIGGER or QUIET; status.js can't carry a quake
// count; the verdict can't open early or with a ruling pending.
// Everything here runs in a temp folder with canned replies. Nothing touches the
// real state/thesis_h or the network.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const zlib   = require('node:zlib');

const th = require('../runners/thesis-h.js');
const verdict = require('../runners/thesis-h-verdict.js');

let seq = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), `thesish-${process.pid}-${seq++}-`));
const CHARTER = '# Thesis H Charter\n\n## Signature\n\nInitials: CM\\_CM\n\nDate: 11/14/2026\n\n## Amendment 1\n\nDate: 2026-11-15 · Initials: CM\n\n1. Kp pinned.\n';
const LAUNCH = Date.parse('2026-11-15T03:00:00Z');
const at = s => Date.parse(s);

function kpBody(day, values) {
  return values.map((kp, i) => ({ time_tag: `${day}T${String(i * 3).padStart(2, '0')}:00:00`, Kp: kp, a_running: 0, station_count: 8 }));
}
function flareBody(list) { return list.map(([max_time, max_class]) => ({ max_time, max_class, satellite: 18 })); }
function quakeBody(features = []) { return { type: 'FeatureCollection', features }; }

/** A canned network. `replies` maps a source name to a body, or to null for a failure. */
function net(replies) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const src = url.includes('k-index') ? 'kp' : url.includes('xray-flares') ? 'flares' : url.includes('ssn') ? 'ssn' : 'usgs';
    const body = typeof replies[src] === 'function' ? replies[src](url) : replies[src];
    if (body === null || body === undefined) throw new Error(`no route to ${src}`);
    const buf = Buffer.from(JSON.stringify(body));
    return { ok: true, status: 200, arrayBuffer: async () => buf };
  };
  f.calls = calls;
  return f;
}

async function launched(replies = {}) {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'THESIS_H.md'), CHARTER);
  const r = await th.launch(root, { now: () => LAUNCH, fetchImpl: net({ usgs: quakeBody(), ...replies }) });
  assert.strictEqual(r.ok, true, r.why);
  return root;
}
const call = (root, d) => JSON.parse(fs.readFileSync(path.join(root, 'state', 'thesis_h', 'solar', `${d}.json`), 'utf8'));
const has = (root, ...a) => fs.existsSync(path.join(root, 'state', 'thesis_h', ...a));
const runs = root => fs.readFileSync(path.join(root, 'state', 'thesis_h', 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

beforeEach(() => th._reset());

// ── the lock ──────────────────────────────────────────────────────────

test('launch refuses a charter without the signature or Amendment 1', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'THESIS_H.md'), '# Thesis H\n\nInitials: \\_\\_\n');
  const r = await th.launch(root, { now: () => LAUNCH, fetchImpl: net({ usgs: quakeBody() }) });
  assert.strictEqual(r.ok, false);
  assert.ok(!has(root, 'lock.jsonl'));
});

test('launch records the full-file hash, a frozen copy, and refuses a second launch', async () => {
  const root = await launched();
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'state', 'thesis_h', 'lock.jsonl'), 'utf8').trim());
  assert.strictEqual(lock.hash, require('node:crypto').createHash('sha256').update(CHARTER).digest('hex'));
  assert.ok(has(root, 'charter', lock.hash + '.md'));
  const info = JSON.parse(fs.readFileSync(path.join(root, 'state', 'thesis_h', 'launch.json'), 'utf8'));
  assert.strictEqual(info.verdict_opens.slice(0, 10), '2028-11-25');   // 24 months + 10 days
  assert.strictEqual(info.jester_seed, '20261114');
  const again = await th.launch(root, { now: () => LAUNCH + 1000, fetchImpl: net({ usgs: quakeBody() }) });
  assert.strictEqual(again.ok, false);
  assert.match(again.why, /already launched/);
});

test('the warm-up reads the 30 days before launch, once, and freezes it', async () => {
  const f = net({ usgs: quakeBody() });
  const root = tmp();
  fs.writeFileSync(path.join(root, 'THESIS_H.md'), CHARTER);
  await th.launch(root, { now: () => LAUNCH, fetchImpl: f });
  const u = new URL(f.calls[0]);
  assert.strictEqual(u.searchParams.get('starttime'), '2026-10-16T00:00:00');
  assert.strictEqual(u.searchParams.get('endtime'), '2026-11-15T03:00:00');
  assert.strictEqual(u.searchParams.get('minmagnitude'), '6');
  assert.strictEqual(fs.readdirSync(path.join(root, 'state', 'thesis_h', 'warmup')).filter(n => n.endsWith('.json')).length, 1);
});

test('a changed charter stops every run and says so on the page', async () => {
  const root = await launched();
  fs.appendFileSync(path.join(root, 'THESIS_H.md'), '\nA quiet edit.\n');
  const f = net({ kp: kpBody('2026-11-15', [1, 1, 1, 1, 1, 1, 1, 1]), flares: [], ssn: [], usgs: quakeBody() });
  const r = await th.tick(root, { now: () => at('2026-11-16T00:30:05Z'), fetchImpl: f });
  assert.strictEqual(r.refused, true);
  assert.strictEqual(f.calls.length, 0, 'nothing is read when the lock fails');
  assert.ok(!has(root, 'solar', '2026-11-15.json'));
  const s = th.statusData(root, at('2026-11-16T00:31:00Z'));
  assert.strictEqual(s.hash_ok, false);
});

test('a re-lock takes an appended, initialed amendment and refuses an edit above it', async () => {
  const root = await launched();
  const file = path.join(root, 'THESIS_H.md');
  fs.writeFileSync(file, CHARTER.replace('Kp pinned', 'Kp moved'));
  assert.strictEqual(th.relock(root, { amendment: '2', initials: 'CM', date: '2026-11-16' }).ok, false);
  fs.writeFileSync(file, CHARTER + '\n## Amendment 2\n\nDate: 2026-11-16 · Initials: CM\n\n1. A ruling.\n');
  const r = th.relock(root, { amendment: '2', initials: 'CM', date: '2026-11-16' });
  assert.strictEqual(r.ok, true, r.why);
  assert.strictEqual(th.check(root).ok, true);
});

// ── the solar call ────────────────────────────────────────────────────

async function callFor(values, flares, when = '2026-11-16T00:30:05Z') {
  const root = await launched();
  const f = net({ kp: kpBody('2026-11-15', values), flares: flareBody(flares), ssn: [{ Obsdate: '2026-11-14T00:00:00', swpc_ssn: 90 }], usgs: quakeBody() });
  await th.tick(root, { now: () => at(when), fetchImpl: f });
  return { root, c: has(root, 'solar', '2026-11-15.json') ? call(root, '2026-11-15') : null };
}

test('nothing is called before 00:30 UTC on the day after', async () => {
  const { c } = await callFor([1, 1, 1, 1, 1, 1, 1, 1], [], '2026-11-16T00:29:50Z');
  assert.strictEqual(c, null);
});

test('Kp 7.00 is a trigger; 6.67 is not (Amendment 1)', async () => {
  assert.strictEqual((await callFor([2, 3, 4, 7.00, 5, 3, 2, 1], [])).c.call, 'TRIGGER');
  th._reset();
  assert.strictEqual((await callFor([2, 3, 4, 6.67, 5, 3, 2, 1], [])).c.call, 'QUIET');
});

test('an X1.0 flare peaking that day is a trigger; M9.9 or an X flare the day before is not', async () => {
  assert.strictEqual((await callFor([1, 1, 1, 1, 1, 1, 1, 1], [['2026-11-15T13:02:00Z', 'X1.0']])).c.call, 'TRIGGER');
  th._reset();
  assert.strictEqual((await callFor([1, 1, 1, 1, 1, 1, 1, 1], [['2026-11-15T13:02:00Z', 'M9.9'], ['2026-11-14T23:59:00Z', 'X3.1']])).c.call, 'QUIET');
});

test('Amendment 2 item 1: an incomplete 00:30 read waits; the first complete read that day counts, marked late', async () => {
  const { root, c } = await callFor([1, 1, 1, 1, 1, 1, 1], []);
  assert.strictEqual(c, null, 'no call from 7 of 8 values with none at 7');
  th._reset();
  await th.tick(root, { now: () => at('2026-11-16T06:00:00Z'), fetchImpl: net({ kp: kpBody('2026-11-15', [1, 1, 1, 1, 1, 1, 1, 2]), flares: [], ssn: [], usgs: quakeBody() }) });
  const d = call(root, '2026-11-15');
  assert.strictEqual(d.call, 'QUIET');
  assert.strictEqual(d.late, true);
  assert.strictEqual(d.kp.read_at, '2026-11-16T06:00:00.000Z');
});

test('Amendment 2 item 1: an on-time complete read is not marked late', async () => {
  const { c } = await callFor([1, 1, 1, 1, 1, 1, 1, 1], []);
  assert.strictEqual(c.call, 'QUIET');
  assert.strictEqual(c.late, false);
});

test('Amendment 2 item 1: a first read later on the call day counts, marked late', async () => {
  const { c } = await callFor([1, 1, 1, 1, 1, 1, 1, 1], [], '2026-11-16T03:10:00Z');
  assert.strictEqual(c.call, 'QUIET');
  assert.strictEqual(c.late, true);
});

test('Amendment 2 item 1: no complete read by midnight UTC on the call day, and the day abstains', async () => {
  const { root } = await callFor([1, 1, 1, 1, 1, 1, 1], []);
  th._reset();
  // A complete read just after midnight is too late for Nov 15 and must not be used.
  await th.tick(root, { now: () => at('2026-11-17T00:10:00Z'), fetchImpl: net({ kp: kpBody('2026-11-15', [1, 1, 1, 1, 1, 1, 1, 1]), flares: [], ssn: [], usgs: quakeBody() }) });
  const d = call(root, '2026-11-15');
  assert.strictEqual(d.call, 'ABSTAIN');
  assert.match(d.reasons.join(' '), /midnight UTC/);
});

test('a Kp of 7 or an X flare settles the call at 00:30 even before all 8 Kp values are out', async () => {
  assert.strictEqual((await callFor([1, 1, 1, 7.33, 1, 1, 1], [])).c.call, 'TRIGGER');
  th._reset();
  assert.strictEqual((await callFor([1, 1, 1, 1, 1, 1, 1], [['2026-11-15T13:02:00Z', 'X2.0']])).c.call, 'TRIGGER');
});

test('one source down all day abstains the day, even if the other shows a trigger', async () => {
  const root = await launched();
  const half = net({ kp: null, flares: flareBody([['2026-11-15T13:02:00Z', 'X2.0']]), ssn: [], usgs: quakeBody() });
  await th.tick(root, { now: () => at('2026-11-16T00:30:05Z'), fetchImpl: half });
  assert.ok(!has(root, 'solar', '2026-11-15.json'), 'still retrying during the call day');
  th._reset();
  await th.tick(root, { now: () => at('2026-11-17T00:00:30Z'), fetchImpl: half });
  assert.strictEqual(call(root, '2026-11-15').call, 'ABSTAIN');
});

test('a flare with no readable class on an otherwise quiet day waits on ruling R11', async () => {
  const { c } = await callFor([1, 1, 1, 1, 1, 1, 1, 1], [['2026-11-15T13:02:00Z', '']]);
  assert.strictEqual(c.call, 'PENDING');
  assert.match(c.reasons.join(' '), /R11/);
});

test('a frozen call is never rewritten, and the raw bodies are kept', async () => {
  const { root, c } = await callFor([2, 3, 4, 7.33, 5, 3, 2, 1], []);
  const before = fs.readFileSync(path.join(root, 'state', 'thesis_h', 'solar', '2026-11-15.json'), 'utf8');
  th._reset();
  await th.tick(root, { now: () => at('2026-11-16T09:00:00Z'), fetchImpl: net({ kp: kpBody('2026-11-15', [1, 1, 1, 1, 1, 1, 1, 1]), flares: [], ssn: [], usgs: quakeBody() }) });
  assert.strictEqual(fs.readFileSync(path.join(root, 'state', 'thesis_h', 'solar', '2026-11-15.json'), 'utf8'), before);
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, c.kp.raw))).toString());
  assert.strictEqual(raw[3].Kp, 7.33);
});

test('a failed source writes no call and is retried; after midnight UTC on the call day, the day abstains', async () => {
  const root = await launched();
  const down = net({ kp: null, flares: null, ssn: null, usgs: quakeBody() });
  await th.tick(root, { now: () => at('2026-11-16T00:30:05Z'), fetchImpl: down });
  assert.ok(!has(root, 'solar', '2026-11-15.json'));
  assert.ok(runs(root).some(r => r.kind === 'solar_read_failed'));
  th._reset();
  await th.tick(root, { now: () => at('2026-11-17T00:00:30Z'), fetchImpl: down });
  assert.strictEqual(call(root, '2026-11-15').call, 'ABSTAIN');
});

test('nothing before launch is ever called (forward only)', async () => {
  const { root } = await callFor([1, 1, 1, 1, 1, 1, 1, 1], []);
  assert.ok(!has(root, 'solar', '2026-11-14.json'));
});

// ── the quake snapshot ────────────────────────────────────────────────

test('the daily snapshot reads the 45 days before the day, once, from the day after launch', async () => {
  const root = await launched();
  const f = net({ kp: kpBody('2026-11-15', [1, 1, 1, 1, 1, 1, 1, 1]), flares: [], ssn: [], usgs: quakeBody([
    { id: 'us1', properties: { time: at('2026-11-10T01:00:00Z'), mag: 6.1, type: 'earthquake', status: 'reviewed' }, geometry: { coordinates: [140, 35, 10] } }]) });
  await th.tick(root, { now: () => at('2026-11-16T00:30:05Z'), fetchImpl: f });
  const u = new URL(f.calls.find(c => c.includes('fdsnws')));
  assert.strictEqual(u.searchParams.get('starttime'), '2026-10-02T00:00:00');
  assert.strictEqual(u.searchParams.get('endtime'), '2026-11-16T00:00:00');
  const snap = JSON.parse(fs.readFileSync(path.join(root, 'state', 'thesis_h', 'quakes', '2026-11-16.json'), 'utf8'));
  assert.strictEqual(snap.events[0].id, 'us1');
  // The log keeps the hash, never a count.
  for (const r of runs(root)) assert.ok(!('events' in r) && !('count' in r) && !('n' in r));
});

// ── the page ──────────────────────────────────────────────────────────

test('status.js carries only the whitelisted keys and no quake numbers', async () => {
  const { root } = await callFor([2, 3, 4, 7.00, 5, 3, 2, 1], []);
  const text = fs.readFileSync(path.join(root, 'output', 'stations', 'thesis-h', 'status.js'), 'utf8');
  const m = /^window\.THESIS_H = (.*);\n$/s.exec(text);
  assert.ok(m, 'the page contract is window.THESIS_H = {...};');
  const s = JSON.parse(m[1]);
  for (const k of Object.keys(s)) assert.ok(th.STATUS_KEYS.includes(k), `unexpected key ${k}`);
  assert.strictEqual(s.trigger_days, 1);
  assert.strictEqual(s.episodes, '1 (provisional)');
  assert.doesNotMatch(text, /mag|quake_count|mainshock|rate_ratio|score/i);
});

test('Amendment 2 item 2: an abstained or pending day breaks the quiet run', () => {
  const d = (n, c) => ({ day: `2027-02-${String(n).padStart(2, '0')}`, call: c });
  assert.deepStrictEqual(th.provisionalEpisodes([d(1, 'TRIGGER'), d(2, 'QUIET'), d(3, 'ABSTAIN'), d(4, 'QUIET'), d(5, 'QUIET'), d(6, 'TRIGGER')]), ['2027-02-01']);
  assert.deepStrictEqual(th.provisionalEpisodes([d(1, 'TRIGGER'), d(2, 'QUIET'), d(3, 'PENDING'), d(4, 'QUIET'), d(5, 'QUIET'), d(6, 'QUIET'), d(7, 'TRIGGER')]), ['2027-02-01', '2027-02-07']);
});

test('provisional episodes need 3 quiet days before a trigger', () => {
  const d = (n, c) => ({ day: `2027-01-${String(n).padStart(2, '0')}`, call: c });
  const eps = th.provisionalEpisodes([d(1, 'TRIGGER'), d(2, 'TRIGGER'), d(3, 'QUIET'), d(4, 'QUIET'), d(5, 'TRIGGER'),
                                      d(6, 'QUIET'), d(7, 'QUIET'), d(8, 'QUIET'), d(9, 'TRIGGER')]);
  assert.deepStrictEqual(eps, ['2027-01-01', '2027-01-09']);
});

// ── the sealed look ───────────────────────────────────────────────────

test('the verdict will not open early, or while a ruling is pending', async () => {
  const root = await launched();
  assert.match(verdict.open(root, { now: at('2027-06-01T00:00:00Z') }).why, /sealed until 2028-11-25/);
  assert.match(verdict.open(root, { now: at('2029-01-01T00:00:00Z') }).why, /rulings still pending/);
});

test('Amendment 2 settles R1-R10; only R11 is still open', () => {
  assert.deepStrictEqual(Object.keys(verdict.SETTLED), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10']);
  for (const v of Object.values(verdict.SETTLED)) assert.match(v, /^Amendment 2 item \d+:/);
  assert.deepStrictEqual(verdict.PENDING_RULINGS.map(r => r.split(' ')[0]), ['R11']);
});

test('rule 7 throws out a quake with an equal or bigger one within 300 km and 30 days before it', () => {
  const t0 = at('2027-03-01T00:00:00Z'), D = 86400000;
  const q = (id, dt, mag, lat, lon) => ({ id, time: t0 + dt, mag, lat, lon });
  const kept = verdict.mainshocks([
    q('main', 0, 7.0, 38, 142), q('after', 2 * D, 6.4, 38.5, 142.5),     // ~70 km, smaller, 2 days: out
    q('far', 3 * D, 6.2, 10, 120),                                        // far away: in
    q('bigger', 5 * D, 7.2, 38.2, 142.1),                                 // bigger than the earlier one: in
    q('late', 40 * D, 6.0, 38, 142),                                      // more than 30 days after the last big one nearby: in
  ]).map(x => x.id);
  assert.deepStrictEqual(kept, ['main', 'far', 'bigger', 'late']);
});

test('the exact binomial interval matches the published Clopper-Pearson values', () => {
  const ci = verdict.clopperPearson(5, 10);
  assert.ok(Math.abs(ci.lower - 0.1871) < 1e-4 && Math.abs(ci.upper - 0.8129) < 1e-4);
  assert.ok(Math.abs(verdict.clopperPearson(0, 10).upper - 0.3085) < 1e-4);
});

test('the ladder is checked top to bottom', () => {
  const base = { scoredEpisodes: 20, windowsTotal: 100, windowsAbstained: 0, jesterBeatShare: 0.99 };
  assert.strictEqual(verdict.ladder({ ...base, scoredEpisodes: 9, real: { lower: 3, upper: 4 } }), 'UNTESTED');
  assert.strictEqual(verdict.ladder({ ...base, windowsAbstained: 21, real: { lower: 3, upper: 4 } }), 'UNTESTED');
  assert.strictEqual(verdict.ladder({ ...base, squire: { lower: 1.1, upper: 3 }, real: { lower: 3, upper: 4 } }), 'WE BROKE IT');
  assert.strictEqual(verdict.ladder({ ...base, squire: { lower: 0.5, upper: 1.5 }, real: { lower: 1.2, upper: 4 } }), 'PASS');
  assert.strictEqual(verdict.ladder({ ...base, jesterBeatShare: 0.9, squire: { lower: 0.5, upper: 1.5 }, real: { lower: 1.2, upper: 1.9 } }), 'KILL');
  assert.strictEqual(verdict.ladder({ ...base, squire: { lower: 0.5, upper: 1.5 }, real: { lower: 0.7, upper: 2.6 } }), 'UNTESTED');
});
