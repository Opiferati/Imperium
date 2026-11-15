'use strict';
// ══════════════════════════════════════════════════════════════════════
// THESIS H — Sunspots and Earthquakes (built and launched 2026-11-15)
//
// Charter: THESIS_H.md at the Imperium root, a byte-for-byte snapshot of the
// Claude Doc "Thesis H Charter: Sunspots and Earthquakes" (signed CM 11/14/2026,
// Amendment 1 CM 2026-11-15, Amendment 2 CM 2026-11-15). The lock is the SHA-256
// of that whole file, so it covers every amendment. Every run checks it and refuses
// on a mismatch; an amendment is taken in only by an append-only re-lock.
//
// What this file does, and nothing more:
//   1. The solar call (rules 1-2). At 00:30 UTC on day t+1 it reads the NOAA
//      planetary Kp product and the GOES X-ray flare list, freezes both raw
//      bodies, and freezes one call for day t: TRIGGER, QUIET, ABSTAIN, or
//      PENDING (a case the charter does not settle; it waits for a ruling).
//      Amendment 2 item 1: if the 00:30 read fails or can't settle the call, the
//      first read later that same UTC day (t+1) that can counts, marked late;
//      none by midnight UTC and the day abstains.
//   2. The quake snapshot (rules 6-8). Once a UTC day at 00:30 it reads the
//      USGS M6+ catalog for the 45 days before that day and freezes it. The
//      verdict later takes, for each window, the first snapshot taken 10 days
//      after the window closed; every later snapshot is a revision, display only.
//      45 days covers a 3-day window plus the 30-day aftershock look-back.
//   3. The catalog warm-up, once, at launch: M6+ quakes from the 30 days
//      before launch.
//   4. status.js for the station page. Display only: no quake count, no score.
//
// It never computes the score. Episodes, windows, controls and the verdict are
// recomputed from frozen data, once, at the one look (thesis-h-verdict.js).
//
// Laws kept here: forward-only (nothing before launch is ever called); no mock
// data (a failed source writes nothing and is retried, then abstains); frozen on
// first sight (every file is written with flag 'wx', never overwritten);
// decide at t, fill at t+1 (the call for day t uses only reads made at or after
// 00:30 UTC on t+1, and the quakes are read days later still); append-only
// logs; provenance on every run (commit, charter hash, runner hash, data hashes).
// Never touches money, a broker, or the network beyond the four NOAA/USGS URLs.
// ══════════════════════════════════════════════════════════════════════

const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const zlib   = require('node:zlib');

const THESIS       = 'THESIS_H';
const CHARTER_FILE = 'THESIS_H.md';
const DIR          = path.join('state', 'thesis_h');
const OUT_DIR      = path.join('output', 'stations', 'thesis-h');
const REGISTER_ID  = 'thesis-h-charter-1';
const SIGNED       = 'CM 11/14/2026';
const SIGNED_DATE  = '2026-11-14';

// Pinned at build (the charter: "exact file to be pinned at build").
const URLS = Object.freeze({
  kp:     'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
  flares: 'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json',
  ssn:    'https://services.swpc.noaa.gov/json/solar-cycle/swpc_observed_ssn.json',
  usgs:   'https://earthquake.usgs.gov/fdsnws/event/1/query',
});

const DAY_MS        = 86400000;
const CALL_OFFSET   = 30 * 60000;    // rule 2: the call for day t is made at 00:30 UTC on t+1
const ON_TIME_MS    = 60000;         // "at 00:30" read to the minute: 00:30:00-00:30:59
const KP_TRIGGER    = 7.00;          // Amendment 1: one of the eight values >= 7.00; 6.67 does not count
const SNAPSHOT_DAYS = 45;            // 3-day window + 30-day look-back + slack
const WARMUP_DAYS   = 30;            // "quakes from the 30 days before launch"
const RETRY_MS      = 5 * 60000;     // a failed read is retried every 5 minutes, each failure logged
const STATUS_EVERY  = 10 * 60000;
const FETCH_TIMEOUT = 20000;

// ── small helpers ─────────────────────────────────────────────────────
const sha256  = b => crypto.createHash('sha256').update(b).digest('hex');
const dayOf   = ms => new Date(ms).toISOString().slice(0, 10);
const dayMs   = d => Date.parse(d + 'T00:00:00Z');
const addDays = (d, n) => dayOf(dayMs(d) + n * DAY_MS);
const iso     = ms => new Date(ms).toISOString();
const stamp   = ms => iso(ms).replace(/[-:.]/g, '');
const utcText = ms => iso(ms).slice(0, 16).replace('T', ' ') + ' UTC';
const p       = (root, ...a) => path.join(root, DIR, ...a);

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function readLines(f) {
  let t = '';
  try { t = fs.readFileSync(f, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of t.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* skip */ } }
  return out;
}

/** Frozen on first sight: write once, never overwrite. Returns false if it already existed. */
function freeze(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, data, { flag: 'wx' }); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}
function freezeJson(file, obj) { return freeze(file, JSON.stringify(obj, null, 1) + '\n'); }

/** Append-only. */
function append(root, entry) {
  const f = p(root, 'runs.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(entry) + '\n');
}

function headCommit(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(4).trim();
    try { return fs.readFileSync(path.join(root, '.git', ref), 'utf8').trim(); }
    catch {
      const packed = fs.readFileSync(path.join(root, '.git', 'packed-refs'), 'utf8');
      const line = packed.split('\n').find(l => l.endsWith(' ' + ref));
      return line ? line.split(' ')[0] : null;
    }
  } catch { return null; }
}

function codeHashes(root) {
  const h = {};
  for (const f of ['runners/thesis-h.js', 'runners/thesis-h-verdict.js']) {
    try { h[f] = sha256(fs.readFileSync(path.join(root, f))); } catch { h[f] = null; }
  }
  return h;
}

function provenance(root, lock) {
  return { commit: headCommit(root), charter_hash: lock ? lock.hash : null, code: codeHashes(root) };
}

// ── the lock ──────────────────────────────────────────────────────────
/** The recorded hash is the last line of the append-only lock log. */
function check(root) {
  const lines = readLines(p(root, 'lock.jsonl'));
  if (!lines.length) return { ok: false, launched: false, why: 'not launched: no lock recorded' };
  const want = lines[lines.length - 1].hash;
  let buf;
  try { buf = fs.readFileSync(path.join(root, CHARTER_FILE)); }
  catch { return { ok: false, launched: true, hash: want, why: `${CHARTER_FILE} is missing` }; }
  const got = sha256(buf);
  if (got !== want) return { ok: false, launched: true, hash: want, found: got, why: 'charter changed since the hash was recorded' };
  return { ok: true, launched: true, hash: want };
}

/** An amendment re-lock. Guarded: the new charter must be the old one byte for
 *  byte with text appended after it (no edits, no deletions), and the appended
 *  text must carry the amendment heading and the initials given. */
function relock(root, { amendment, initials, date, now = Date.now() } = {}) {
  const lines = readLines(p(root, 'lock.jsonl'));
  if (!lines.length) return { ok: false, why: 'not launched' };
  if (!amendment || !initials || !date) return { ok: false, why: 'a re-lock needs --amendment, --initials and --date' };
  const last = lines[lines.length - 1];
  let oldBuf;
  try { oldBuf = fs.readFileSync(p(root, 'charter', last.hash + '.md')); }
  catch { return { ok: false, why: 'the locked snapshot is missing from state/thesis_h/charter' }; }
  const newBuf = fs.readFileSync(path.join(root, CHARTER_FILE));
  if (newBuf.length <= oldBuf.length || !newBuf.subarray(0, oldBuf.length).equals(oldBuf)) {
    return { ok: false, why: 'the new charter is not the old one with text appended: something above was edited or removed' };
  }
  const added = newBuf.subarray(oldBuf.length).toString('utf8');
  if (!new RegExp(`##\\s*Amendment\\s+${amendment}\\b`).test(added)) return { ok: false, why: `the added text has no "Amendment ${amendment}" heading` };
  if (!added.includes(initials)) return { ok: false, why: `the added text does not carry the initials ${initials}` };
  if (!added.includes(date)) return { ok: false, why: `the added text does not carry the date ${date}` };
  const hash = sha256(newBuf);
  freeze(p(root, 'charter', hash + '.md'), newBuf);
  const row = { at: iso(now), kind: 'relock', hash, previous: last.hash, amendment, initials, date, bytes: newBuf.length };
  fs.appendFileSync(p(root, 'lock.jsonl'), JSON.stringify(row) + '\n');
  append(root, { ...row, ...provenance(root, { hash }) });
  return { ok: true, hash, previous: last.hash };
}

// ── reading the sources ───────────────────────────────────────────────
async function get(url, fetchImpl, now) {
  const read_at = now();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return { ok: false, read_at, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    let json;
    try { json = JSON.parse(buf.toString('utf8')); } catch { return { ok: false, read_at, error: 'not JSON' }; }
    return { ok: true, read_at, buf, json, sha256: sha256(buf), bytes: buf.length };
  } catch (e) { return { ok: false, read_at, error: e.message }; }
}

/** Kp values by UTC day. Handles the 2026 object format and the older array-of-arrays. */
function kpByDay(json) {
  const rows = Array.isArray(json) ? json : [];
  const out = {};
  const seen = new Set();
  for (const r of rows) {
    let tag, kp;
    if (Array.isArray(r)) { tag = r[0]; kp = r[1]; } else if (r && typeof r === 'object') { tag = r.time_tag; kp = r.Kp ?? r.kp; }
    if (typeof tag !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(tag)) continue;  // header row
    const v = Number(kp);
    if (!Number.isFinite(v) || seen.has(tag)) continue;
    seen.add(tag);
    (out[tag.slice(0, 10)] ||= []).push({ time_tag: tag, kp: v });
  }
  return out;
}

/** X1.0 or above, by the class letter (X) and its number. */
function flareClass(c) {
  const m = /^([ABCMX])(\d+(?:\.\d+)?)/.exec(String(c || '').trim().toUpperCase());
  return m ? { letter: m[1], n: Number(m[2]) } : null;
}
const isX1 = c => { const f = flareClass(c); return !!f && f.letter === 'X' && f.n >= 1.0; };

/** Flares that peaked on day t, from the 7-day list. */
function flaresOn(json, t) {
  const rows = Array.isArray(json) ? json : [];
  const on = rows.filter(r => r && typeof r.max_time === 'string' && r.max_time.slice(0, 10) === t);
  return {
    x: on.filter(r => isX1(r.max_class)).map(r => ({ max_time: r.max_time, max_class: r.max_class, satellite: r.satellite ?? null })),
    unclassified: on.filter(r => !flareClass(r.max_class)).map(r => ({ max_time: r.max_time, max_class: r.max_class ?? null })),
    count: on.length,
  };
}

/** Which UTC days a read can speak for. Kp: days with values in it. Flares: the
 *  7-day list covers the read day and the 6 before it. */
function covers(source, read, t) {
  if (source === 'kp') return (read.kp_days || []).includes(t);
  return t <= read.read_day && t >= addDays(read.read_day, -6);
}

/**
 * The call for day t. Rule 2 and Amendment 2 item 1: the reads that count are
 * those made from 00:30 UTC on t+1 up to midnight UTC ending t+1. For each
 * source the first such read that can settle the call counts; one made after
 * 00:30:59 is marked late. A source with no such read by midnight abstains the
 * day. A Kp read settles the call when it holds all 8 values for t, or a value
 * of 7.00 or more (the day is then a trigger whatever the rest), or when the
 * flare list already shows an X1.0+ flare that day (rule 1: either is enough).
 * The one case the amendments do not settle (a flare with no readable class on
 * a day nothing else triggers) stays PENDING with its reason.
 */
function decide(t, kpRead, kpJson, flRead, flJson) {
  const callAt = dayMs(t) + DAY_MS + CALL_OFFSET;
  const late   = r => !!r && r.read_at - callAt >= ON_TIME_MS;
  const kpVals = kpJson ? (kpByDay(kpJson)[t] || []) : null;
  const kpMax  = kpVals && kpVals.length ? Math.max(...kpVals.map(v => v.kp)) : null;
  const fl     = flJson ? flaresOn(flJson, t) : null;
  const kpHit  = kpMax !== null && kpMax >= KP_TRIGGER;
  const flHit  = !!fl && fl.x.length > 0;
  const reasons = [];

  let call;
  if (!kpRead || !flRead) {
    call = 'ABSTAIN';
    const missing = [!kpRead && 'Kp', !flRead && 'flare list'].filter(Boolean).join(' and ');
    reasons.push(`no ${missing} read that could settle the call by midnight UTC on the call day (Amendment 2, item 1)`);
  } else if (fl.unclassified.length && !kpHit && !flHit) {
    call = 'PENDING';
    reasons.push('a flare peaked this day with no readable class (R11, waits on a ruling)');
  } else call = (kpHit || flHit) ? 'TRIGGER' : 'QUIET';
  const isLate = late(kpRead) || late(flRead);
  return {
    call, reasons, late: isLate,
    kp: kpRead ? { read_at: iso(kpRead.read_at), sha256: kpRead.sha256, raw: kpRead.raw, values: kpVals, count: kpVals.length, max: kpMax, late: late(kpRead) } : null,
    flares: flRead ? { read_at: iso(flRead.read_at), sha256: flRead.sha256, raw: flRead.raw, x: fl.x, unclassified: fl.unclassified, peaked_this_day: fl.count, late: late(flRead) } : null,
    trigger: { kp: kpHit, flare: flHit },
  };
}

// ── state that lives only in memory (retry pacing) ────────────────────
const lastTry = new Map();
function paced(key, now) {
  const t = lastTry.get(key) || 0;
  if (now - t < RETRY_MS) return false;
  lastTry.set(key, now);
  return true;
}

// ── launch ────────────────────────────────────────────────────────────
/**
 * Launch, once. Guarded: refuses if a lock already exists. Records the hash of
 * THESIS_H.md, a frozen copy of it, launch.json, the warm-up quakes, and the
 * Attempt Register entry. Returns what it did.
 */
async function launch(root, { now = Date.now, fetchImpl = globalThis.fetch, attempts } = {}) {
  if (fs.existsSync(p(root, 'lock.jsonl')) || fs.existsSync(p(root, 'launch.json'))) {
    return { ok: false, why: 'already launched: the lock exists. A second launch is refused.' };
  }
  let buf;
  try { buf = fs.readFileSync(path.join(root, CHARTER_FILE)); }
  catch { return { ok: false, why: `${CHARTER_FILE} not found` }; }
  const text = buf.toString('utf8');
  if (!/Initials:\s*CM/.test(text) || !text.includes('11/14/2026')) return { ok: false, why: 'the charter snapshot does not carry the signature (CM, 11/14/2026)' };
  if (!/## Amendment 1[\s\S]*Initials:\s*CM/.test(text)) return { ok: false, why: 'the charter snapshot does not carry Amendment 1 with initials' };

  const at = now();
  const hash = sha256(buf);
  const launchDay = dayOf(at);
  const opens = new Date(at); opens.setUTCMonth(opens.getUTCMonth() + 24); opens.setUTCDate(opens.getUTCDate() + 10);
  const lock = { at: iso(at), kind: 'launch', hash, bytes: buf.length, file: CHARTER_FILE, signed: SIGNED, amendments: [1] };

  freeze(p(root, 'charter', hash + '.md'), buf);
  fs.mkdirSync(p(root), { recursive: true });
  fs.writeFileSync(p(root, 'lock.jsonl'), JSON.stringify(lock) + '\n', { flag: 'wx' });
  const info = {
    thesis: THESIS, charter_hash: hash, launched_at: iso(at), launch_date: launchDay,
    first_call_day: launchDay,            // the first day whose call is made after launch (at 00:30 UTC tomorrow)
    first_snapshot_day: addDays(launchDay, 1),
    verdict_opens: iso(opens.getTime()),  // 24 months after launch plus the 10-day settling wait
    halfway_report: dayOf(new Date(at).setUTCMonth(new Date(at).getUTCMonth() + 12)),
    jester_seed: SIGNED_DATE.replace(/-/g, ''),
    register_id: REGISTER_ID, urls: URLS, commit: headCommit(root), code: codeHashes(root),
  };
  freezeJson(p(root, 'launch.json'), info);
  append(root, { at: iso(at), kind: 'launch', ...provenance(root, lock), launch: info });

  // The catalog warm-up: the 30 UTC days before the launch day, through the launch moment.
  const wStart = addDays(launchDay, -WARMUP_DAYS) + 'T00:00:00';
  const wEnd = iso(at).slice(0, 19);
  const warm = await quakeRead(root, { start: wStart, end: wEnd, file: p(root, 'warmup', `${wStart.slice(0, 10)}_to_${wEnd.replace(/:/g, '')}.json`), label: 'warmup', now, fetchImpl, lock });

  let register = null;
  if (attempts) {
    register = attempts.record(root, {
      id: REGISTER_ID, kind: 'tested_idea', station: 'thesis-h', thesis: THESIS, dated: SIGNED_DATE,
      outcome: 'RUNNING',
      what: 'Thesis H charter (solar activity vs M6+ quakes) signed',
      evidence: `Signed CM 11/14/2026, Amendment 1 CM 2026-11-15. Launched ${iso(at)}; charter hash ${hash}; state/thesis_h/launch.json.`,
    });
  }
  writeStatus(root, { now: at, force: true });
  return { ok: true, hash, launched_at: iso(at), verdict_opens: info.verdict_opens, warmup: warm, register };
}

// ── the quake reads ───────────────────────────────────────────────────
async function quakeRead(root, { start, end, file, label, now, fetchImpl, lock }) {
  const q = new URLSearchParams({ format: 'geojson', starttime: start, endtime: end, minmagnitude: '6', orderby: 'time-asc' });
  const url = `${URLS.usgs}?${q}`;
  const r = await get(url, fetchImpl, now);
  if (!r.ok || !r.json || !Array.isArray(r.json.features)) {
    const error = r.ok ? 'no features array' : r.error;
    append(root, { at: iso(r.read_at), kind: `${label}_failed`, start, end, error, ...provenance(root, lock) });
    return { ok: false, error };
  }
  const raw = path.join(path.dirname(file), 'raw', path.basename(file, '.json') + `-${stamp(r.read_at)}.geojson.gz`);
  freeze(raw, zlib.gzipSync(r.buf));
  const events = r.json.features.map(f => {
    const pr = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [];
    return { id: f.id, time: pr.time, iso: Number.isFinite(pr.time) ? iso(pr.time) : null, mag: pr.mag, magType: pr.magType ?? null,
             type: pr.type ?? null, status: pr.status ?? null, updated: pr.updated ?? null, lon: c[0], lat: c[1], depth: c[2], place: pr.place ?? null };
  });
  const wrote = freezeJson(file, { thesis: THESIS, kind: label, start, end, url, read_at: iso(r.read_at), sha256: r.sha256,
                                   raw: path.relative(root, raw).split(path.sep).join('/'), events });
  // The log carries the hash, never the count: nothing in a log can show a quake tally before the one look.
  append(root, { at: iso(r.read_at), kind: label, start, end, sha256: r.sha256, frozen: wrote, ...provenance(root, lock) });
  return { ok: true, frozen: wrote, sha256: r.sha256 };
}

// ── the solar call ────────────────────────────────────────────────────
function readsFile(root) { return p(root, 'solar', 'reads.jsonl'); }

/** Every day from the first call day through yesterday that has no frozen call yet. */
function openDays(root, info, at) {
  const out = [];
  const yesterday = addDays(dayOf(at), -1);
  for (let d = info.first_call_day; d <= yesterday; d = addDays(d, 1)) {
    if (at < dayMs(d) + DAY_MS + CALL_OFFSET) continue;
    if (!fs.existsSync(p(root, 'solar', `${d}.json`))) out.push(d);
  }
  return out;
}

async function solarStep(root, info, lock, { now, fetchImpl }) {
  const at = now();
  const open = openDays(root, info, at);
  if (!open.length) return null;
  if (!paced('solar:' + root, at)) return null;

  // Read both sources once; freeze each good body; note which days each can speak for.
  const runDay = dayOf(at);
  const fresh = {};
  for (const src of ['kp', 'flares']) {
    const r = await get(URLS[src], fetchImpl, now);
    if (!r.ok) { append(root, { at: iso(r.read_at), kind: 'solar_read_failed', source: src, error: r.error, open_days: open, ...provenance(root, lock) }); continue; }
    const raw = p(root, 'raw', runDay, `${src}-${stamp(r.read_at)}.json.gz`);
    freeze(raw, zlib.gzipSync(r.buf));
    const row = { source: src, read_at: r.read_at, read_day: dayOf(r.read_at), sha256: r.sha256, bytes: r.bytes,
                  raw: path.relative(root, raw).split(path.sep).join('/') };
    if (src === 'kp') row.kp_days = Object.keys(kpByDay(r.json)).sort();
    fs.mkdirSync(path.dirname(readsFile(root)), { recursive: true });
    fs.appendFileSync(readsFile(root), JSON.stringify(row) + '\n');
    fresh[src] = { row, json: r.json };
    append(root, { at: iso(r.read_at), kind: 'solar_read', source: src, sha256: r.sha256, ...provenance(root, lock) });
  }
  // The sunspot number: display only, never grades. Only its hash and the latest value are kept.
  if (fresh.kp || fresh.flares) {
    const s = await get(URLS.ssn, fetchImpl, now);
    if (s.ok && Array.isArray(s.json)) {
      const last = s.json.filter(x => x && typeof x.Obsdate === 'string').sort((a, b) => a.Obsdate < b.Obsdate ? -1 : 1).pop();
      append(root, { at: iso(s.read_at), kind: 'ssn_read', sha256: s.sha256, latest: last ? { date: last.Obsdate.slice(0, 10), ssn: last.swpc_ssn } : null, display_only: true });
    } else append(root, { at: iso(s.read_at), kind: 'ssn_read_failed', error: s.ok ? 'not a list' : s.error, display_only: true });
  }

  const reads = readLines(readsFile(root));
  const bodyOf = (src, r) => {
    if (fresh[src] && fresh[src].row.sha256 === r.sha256 && fresh[src].row.read_at === r.read_at) return fresh[src].json;
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, r.raw))).toString('utf8'));
  };
  const results = [];
  for (const t of open) {
    const callAt = dayMs(t) + DAY_MS + CALL_OFFSET;
    const dayEnd = dayMs(t) + 2 * DAY_MS;          // Amendment 2 item 1: "later that same day", midnight UTC
    const inDay = src => reads.filter(r => r.source === src && r.read_at >= callAt && r.read_at < dayEnd && covers(src, r, t))
                              .sort((a, b) => a.read_at - b.read_at);
    const f = inDay('flares')[0] || null;
    const fJson = f ? bodyOf('flares', f) : null;
    const flareSettles = !!fJson && flaresOn(fJson, t).x.length > 0;
    let k = null, kJson = null;
    for (const r of inDay('kp')) {
      const j = bodyOf('kp', r), vals = kpByDay(j)[t] || [];
      if (vals.length >= 8 || vals.some(v => v.kp >= KP_TRIGGER) || flareSettles) { k = r; kJson = j; break; }
    }
    if ((!k || !f) && at < dayEnd) continue;       // keep retrying until midnight UTC on the call day
    const d = decide(t, k, kJson, f, fJson);
    const rec = { thesis: THESIS, day: t, call: d.call, reasons: d.reasons, frozen_at: iso(at), call_time: iso(callAt),
                  kp: d.kp, flares: d.flares, trigger: d.trigger, late: d.late, ...provenance(root, lock) };
    const wrote = freezeJson(p(root, 'solar', `${t}.json`), rec);
    append(root, { at: iso(at), kind: 'solar_call', day: t, call: d.call, reasons: d.reasons, late: d.late, frozen: wrote,
                   kp_sha256: d.kp && d.kp.sha256, flares_sha256: d.flares && d.flares.sha256, ...provenance(root, lock) });
    results.push({ day: t, call: d.call });
  }
  return results;
}

// ── the daily quake snapshot ──────────────────────────────────────────
async function quakeStep(root, info, lock, { now, fetchImpl }) {
  const at = now();
  const D = dayOf(at);
  if (D < info.first_snapshot_day || at < dayMs(D) + CALL_OFFSET) return null;
  const file = p(root, 'quakes', `${D}.json`);
  if (fs.existsSync(file)) return null;
  // A snapshot for an earlier day that never happened is marked missed, once, so the gap is on the record.
  const prev = addDays(D, -1);
  if (prev >= info.first_snapshot_day && !fs.existsSync(p(root, 'quakes', `${prev}.json`))) {
    if (freezeJson(p(root, 'quakes', `${prev}.json`), { thesis: THESIS, kind: 'snapshot', day: prev, missed: true, noted_at: iso(at) }))
      append(root, { at: iso(at), kind: 'snapshot_missed', day: prev, ...provenance(root, lock) });
  }
  if (!paced('quakes:' + root, at)) return null;
  return quakeRead(root, { start: addDays(D, -SNAPSHOT_DAYS) + 'T00:00:00', end: D + 'T00:00:00', file, label: 'snapshot', now, fetchImpl, lock });
}

// ── status.js (display only) ──────────────────────────────────────────
let lastStatusAt = 0;

/** Display-only episode count: a new episode on a TRIGGER day with at least 3
 *  QUIET days before it (or with no earlier trigger day). Days that abstained or
 *  wait on a ruling are not quiet and break the run (Amendment 2, item 2). */
function provisionalEpisodes(calls) {
  const eps = [];
  let quietRun = Infinity;
  for (const c of calls) {
    if (c.call === 'TRIGGER') { if (quietRun >= 3) eps.push(c.day); quietRun = 0; }
    else if (c.call === 'QUIET') quietRun += 1;
    else quietRun = 0;
  }
  return eps;
}

function statusData(root, at) {
  const info = readJson(p(root, 'launch.json'));
  if (!info) return null;
  const lk = check(root);
  const calls = [];
  for (let d = info.first_call_day; d < dayOf(at); d = addDays(d, 1)) {
    const c = readJson(p(root, 'solar', `${d}.json`));
    if (c) calls.push({ day: d, call: c.call, frozen_at: c.frozen_at });
  }
  const eps = provisionalEpisodes(calls);
  const today = dayOf(at);
  const windows = eps.map(e => ({ start: addDays(e, 1), end: addDays(e, 3), closes: addDays(e, 4), settled: addDays(e, 14) }));
  const inProgress = windows.filter(w => today >= w.start && today <= w.end);
  const settling = windows.filter(w => today >= w.closes && today < w.settled);
  const runs = readLines(p(root, 'runs.jsonl'));
  const health = (okKind, failKind, extra) => {
    const ok = runs.filter(x => x.kind === okKind && (!extra || extra(x))).pop();
    const bad = runs.filter(x => x.kind === failKind && (!extra || extra(x))).pop();
    if (!ok && !bad) return 'No read yet';
    if (bad && (!ok || Date.parse(bad.at) > Date.parse(ok.at))) return `Failed ${utcText(Date.parse(bad.at))}` + (ok ? `; last good ${utcText(Date.parse(ok.at))}` : '');
    return utcText(Date.parse(ok.at));
  };
  const last = calls[calls.length - 1];
  const abst = calls.filter(c => c.call === 'ABSTAIN').length;
  const pend = calls.filter(c => c.call === 'PENDING').length;
  return {
    thesis: THESIS,
    launched_at: utcText(Date.parse(info.launched_at)),
    charter_hash: lk.hash ? lk.hash.slice(0, 16) + '…' : null,
    hash_ok: lk.ok,
    hash_check: lk.ok ? `Matches (checked ${utcText(at)})` : `MISMATCH: ${lk.why}`,
    commit: (headCommit(root) || '').slice(0, 7) || null,
    register_id: info.register_id,
    verdict_opens: info.verdict_opens.slice(0, 10),
    days_watched: calls.length,
    trigger_days: calls.filter(c => c.call === 'TRIGGER').length,
    episodes: `${eps.length} (provisional)`,
    windows_open: inProgress.length ? `1, ${inProgress[0].start} to ${inProgress[0].end}` + (settling.length ? `; ${settling.length} settling` : '')
                : settling.length ? `None open; ${settling.length} settling for the 10-day wait` : 'None',
    abstentions: `${abst} day${abst === 1 ? '' : 's'} abstained; ${pend} waiting on a ruling`,
    last_trigger_call: last ? `${last.day}: ${last.call}` : `First call due ${utcText(dayMs(info.first_call_day) + DAY_MS + CALL_OFFSET)}`,
    strong_form: 'Sealed until the one look',
    halfway: `Due ${info.halfway_report} (display only)`,
    sources: {
      kp: health('solar_read', 'solar_read_failed', x => x.source === 'kp'),
      flares: health('solar_read', 'solar_read_failed', x => x.source === 'flares'),
      ssn: health('ssn_read', 'ssn_read_failed'),
      usgs: health('snapshot', 'snapshot_failed') === 'No read yet' ? (health('warmup', 'warmup_failed') === 'No read yet' ? 'No read yet' : `Warm-up read ${health('warmup', 'warmup_failed')}; daily snapshots start ${info.first_snapshot_day}`) : health('snapshot', 'snapshot_failed'),
    },
    verdict: null,
    written_at: iso(at),
  };
}

// The only keys status.js may ever carry. A quake count or a score has no key here.
const STATUS_KEYS = ['thesis', 'launched_at', 'charter_hash', 'hash_ok', 'hash_check', 'commit', 'register_id', 'verdict_opens',
  'days_watched', 'trigger_days', 'episodes', 'windows_open', 'abstentions', 'last_trigger_call', 'strong_form', 'halfway',
  'sources', 'verdict', 'written_at'];

function writeStatus(root, { now = Date.now(), force = false } = {}) {
  if (!force && now - lastStatusAt < STATUS_EVERY) return false;
  const s = statusData(root, now);
  if (!s) return false;
  for (const k of Object.keys(s)) if (!STATUS_KEYS.includes(k)) delete s[k];
  const dir = path.join(root, OUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'status.js'), tmp = f + '.tmp';
  fs.writeFileSync(tmp, 'window.THESIS_H = ' + JSON.stringify(s) + ';\n');
  fs.renameSync(tmp, f);
  // The run log leaves the machine with the Drive sync too. It holds hashes and calls, never a quake count.
  try { fs.copyFileSync(p(root, 'runs.jsonl'), path.join(dir, 'runs.jsonl')); } catch { /* no log yet */ }
  lastStatusAt = now;
  return true;
}

// ── the tick ──────────────────────────────────────────────────────────
let refusedLogged = null;
/** Called by the Warden every tick. Cheap when nothing is due. */
async function tick(root, { now = Date.now, fetchImpl = globalThis.fetch } = {}) {
  const info = readJson(p(root, 'launch.json'));
  if (!info) return null;                        // not launched: nothing to do
  const lk = check(root);
  if (!lk.ok) {
    const key = lk.found || lk.why;
    if (refusedLogged !== key) { refusedLogged = key; append(root, { at: iso(now()), kind: 'refused', why: lk.why, recorded: lk.hash, found: lk.found || null }); writeStatus(root, { now: now(), force: true }); }
    return { refused: true, line: `[THESIS H] REFUSED: ${lk.why}` };
  }
  refusedLogged = null;
  const solar = await solarStep(root, info, lk, { now, fetchImpl });
  const quakes = await quakeStep(root, info, lk, { now, fetchImpl });
  const acted = (solar && solar.length) || quakes;
  writeStatus(root, { now: now(), force: !!acted });
  if (solar && solar.length) return { solar, quakes, line: `[THESIS H] call frozen: ${solar.map(s => `${s.day} ${s.call}`).join(', ')}` };
  if (quakes) return { solar, quakes, line: `[THESIS H] quake snapshot ${quakes.ok ? 'frozen' : 'failed: ' + quakes.error}` };
  return null;
}

// Test hook: forget retry pacing and the status throttle.
function _reset() { lastTry.clear(); lastStatusAt = 0; refusedLogged = null; }

module.exports = {
  THESIS, CHARTER_FILE, DIR, URLS, KP_TRIGGER, REGISTER_ID, STATUS_KEYS,
  check, relock, launch, tick, writeStatus, statusData, decide, kpByDay, flaresOn, isX1, provisionalEpisodes, _reset,
};

// CLI: node runners/thesis-h.js launch | check | status | relock --amendment N --initials XX --date YYYY-MM-DD
if (require.main === module) {
  const root = path.join(__dirname, '..');
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = k => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : undefined; };
  (async () => {
    let out;
    if (cmd === 'launch') {
      if (!rest.includes('--confirm')) out = { ok: false, why: 'launch is once and for all: add --confirm' };
      else out = await launch(root, { attempts: require('./attempts.js') });
    } else if (cmd === 'check') out = check(root);
    else if (cmd === 'status') { writeStatus(root, { force: true }); out = statusData(root, Date.now()); }
    else if (cmd === 'relock') out = relock(root, { amendment: arg('amendment'), initials: arg('initials'), date: arg('date') });
    else out = { ok: false, why: 'usage: launch --confirm | check | status | relock --amendment N --initials XX --date YYYY-MM-DD' };
    console.log(JSON.stringify(out, null, 1));
    process.exit(out && out.ok === false ? 1 : 0);
  })();
}
