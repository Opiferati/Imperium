'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE NORNS: Trial 0 runner. "Does the clock hold?"
//
// Charter: TRIAL_0.md at the Imperium root (exported from the signed Claude Doc "Trial 0 charter:
// Does the clock hold?", signed CM 11/16/2026, Choice 1 = A, Choice 2 = A). Built 2026-11-16,
// before launch. Plain code, standalone, started by hand. NOT wired into the Warden (rule 1).
//
// Commands (from the Imperium root, in WSL):
//   node runners/norns.js dryrun    zero model calls: lays the Loom on a throwaway sim board, builds
//                                   all 21 turns' gate reads and prompts, counts calls, checks the
//                                   fuse, runs the open-gate check and a seed replay. Never graded.
//   node runners/norns.js status    prints where things stand. Writes nothing.
//   node runners/norns.js launch    Opie's go. One launch, ever. Refuses unless the Norns code and
//                                   the charter are committed, it's not 6 to 8 PM ET, and today's
//                                   spend plus the $0.25 fuse fits under the $2 wall.
//
// Who knows the time: only runners/norns/clock.js reads the computer's clock. The sim clock lives
// there too. The board sees only sim time, through the gate in runners/blackboard.js.
//
// Isolation (build list item 1): every write goes through guard(). Allowed: state/norns,
// data/norns, output/trials/norns, and INSERTs into data/imperial-ledger.db tagged norns:trial-0.
// Never blackboard.db, message_bus.db, state/thesis_h or state/trial_ix.
// ══════════════════════════════════════════════════════════════════════

const fs     = require('node:fs');
const path   = require('node:path');
const https  = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const clock  = require('./norns/clock.js');
const grader = require('./norns/grader.js');
const { board } = require('./blackboard.js');

const ROOT = process.env.NORNS_ROOT || path.resolve(__dirname, '..');
const CHARTER_FILE  = 'TRIAL_0.md';
const SCENARIO_FILE = 'runners/norns/trial-0.scenario.json';
const AGENT_ID = 'norns:trial-0';
const FUSE_USD = 0.25;                         // Money: hard fuse for the whole run
const QUIET_ET = [18, 20];                     // never between 6 and 8 PM ET
const API_TIMEOUT_MS = 8 * 60_000;             // same as the Warden
const CODE_FILES = Object.freeze(['runners/norns.js', 'runners/norns/clock.js', 'runners/norns/grader.js',
  SCENARIO_FILE, 'runners/blackboard.js', CHARTER_FILE]);
const WATCHED = Object.freeze(['data/blackboard.db', 'data/message_bus.db', 'state/thesis_h', 'state/trial_ix']);

// Copied from warden.js PRICING (2026-11-16). A test checks these still match warden.js.
const PRICING = Object.freeze({
  'claude-sonnet-5-5': { input: 2.0,  output: 10.0 },
  'claude-haiku-5-5':  { input: 0.10, output: 0.50 },
  'claude-opus-5-5':   { input: 4.0,  output: 20.0 },
});
function estimateCost(model, inTok, outTok) {
  let p = PRICING[model] || PRICING['claude-opus-5-5'];
  if (model === 'claude-haiku-5-5' && inTok > 100_000) p = { input: 0.50, output: 2.50 };
  return (inTok * p.input + outTok * p.output) / 1_000_000;
}

// ── isolation ────────────────────────────────────────────────────────
const ALLOWED = Object.freeze(['state/norns', 'data/norns', 'output/trials/norns']);
const FORBIDDEN = WATCHED;

function rel(root, p) { return path.relative(root, path.resolve(root, p)).split(path.sep).join('/'); }

/** Refuse any write outside the Norns' own folders. Returns the absolute path. */
function guard(root, p, real = clock.real) {
  const r = rel(root, p);
  const bad = FORBIDDEN.find(f => r === f || r.startsWith(f + '/') || r.startsWith(f + '-'));
  const ok = !r.startsWith('..') && ALLOWED.some(a => r === a || r.startsWith(a + '/'));
  if (bad || !ok) {
    try {
      fs.mkdirSync(path.join(root, 'state', 'norns'), { recursive: true });
      fs.appendFileSync(path.join(root, 'state', 'norns', 'guard.jsonl'),
        JSON.stringify({ at: real.nowIso(), refused: r }) + '\n');
    } catch { /* the refusal still stands */ }
    throw new Error(`norns: write refused outside the Norns' folders: ${r}`);
  }
  return path.resolve(root, p);
}
function writeNew(root, p, data, real) {        // freeze: first write wins, never overwritten
  const abs = guard(root, p, real);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data, { flag: 'wx' });
  return abs;
}
function appendLine(root, p, obj, real) {        // logs are append-only
  const abs = guard(root, p, real);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(obj) + '\n');
}
/** A sim board file: guarded, and it must not exist yet (a fresh board every time). */
function newBoardFile(root, p, real) {
  const abs = guard(root, p, real);
  if (fs.existsSync(abs)) throw new Error(`norns: ${p} already exists; a sim board is never reused`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const fileHash = (root, p) => { try { return sha256(fs.readFileSync(path.join(root, p))); } catch { return null; } };
const readLines = (root, p) => { try { return fs.readFileSync(path.join(root, p), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const compact = iso => iso.replace(/[-:]/g, '').toLowerCase();   // 2026-11-16T21:30:00Z -> 20261116t213000z

function headCommit(root) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { stdio: 'pipe' }).toString().trim(); }
  catch { return null; }
}
/** Build list item 7: the code the run uses must be committed, so the run can name it. */
function uncommitted(root) {
  try {
    const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...CODE_FILES], { stdio: 'pipe' })
      .toString().split('\n').filter(Boolean);
    const tracked = new Set(execFileSync('git', ['-C', root, 'ls-files', '--', ...CODE_FILES], { stdio: 'pipe' })
      .toString().split('\n').filter(Boolean));
    return [...new Set([...dirty.map(l => l.slice(3)), ...CODE_FILES.filter(f => !tracked.has(f))])];
  } catch (e) { return [`git: ${e.message}`]; }
}

// ── the scenario and the prompt ──────────────────────────────────────
function loadScenario(srcRoot = ROOT) {
  const buf = fs.readFileSync(path.join(srcRoot, SCENARIO_FILE));
  return { sc: JSON.parse(buf.toString('utf8')), hash: sha256(buf) };
}
/** Choice 1 = A: EDICTS.md + the Ministry of Intelligence SOUL.md + the Norns add-on, word for word. */
function systemPrompt(srcRoot, sc) {
  const parts = sc.prompt_files.map(f => fs.readFileSync(path.join(srcRoot, f), 'utf8').trim());
  const hashes = Object.fromEntries(sc.prompt_files.map(f => [f, fileHash(srcRoot, f)]));
  return { text: [...parts, sc.add_on].join('\n\n'), hashes };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const hhmm = d => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
/** "Tuesday 4 March 2031, 13:00" */
function longLabel(iso) {
  const d = new Date(Date.parse(iso));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hhmm(d)}`;
}
/** "Tue 4 Mar 2031, 13:00" */
function shortLabel(iso) {
  const d = new Date(Date.parse(iso));
  return `${DAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}, ${hhmm(d)}`;
}
const nornsLine = iso => `NORNS: it is now ${longLabel(iso)}`;

/** Rule 5: 3 turns a day at the scenario's hours, for the scenario's days. 21 sim times. */
function schedule(sc) {
  const start = Date.parse(sc.start);
  const day0 = start - (start % 86_400_000);
  const out = [];
  for (let d = 0; d < sc.days; d++)
    for (const h of sc.turn_hours) out.push(clock.isoOf(day0 + d * 86_400_000 + h * 3_600_000));
  if (out[0] !== sc.start || out[out.length - 1] !== sc.end) throw new Error('norns: schedule does not match the scenario start and end');
  return out;
}

/** Rule 6: the Norns line, the notes visible now, the last N replies, the task. Nothing else. */
function userPrompt(sc, simAt, notes, notebook) {
  const board = notes.length ? notes.map(n => `- [${shortLabel(n.at)}] ${n.text}`).join('\n') : '(nothing on the board)';
  const book = notebook.length
    ? notebook.map(e => `[${shortLabel(e.sim_at)}]\n${e.reply.trim()}`).join('\n\n')
    : '(empty)';
  return `${nornsLine(simAt)}\n\nTHE BOARD (notes visible now):\n${board}\n\n`
    + `YOUR NOTEBOOK (your last ${sc.notebook_size} replies, oldest first):\n${book}\n\nTHE TASK: ${sc.task}`;
}
/** Rule 3: the request carries no tool list at all. */
function request(sc, system, user) {
  return { model: sc.model, max_tokens: sc.max_tokens, system, messages: [{ role: 'user', content: user }] };
}
/** The fuse's view of one call: input priced at one token per two bytes (generous), full output. */
function worstCaseUsd(req) {
  const inTok = Math.ceil(Buffer.byteLength(req.system + req.messages.map(m => m.content).join('')) / 2) + 50;
  return estimateCost(req.model, inTok, req.max_tokens);
}

// ── the Loom: lay the week face-down ─────────────────────────────────
/** mulberry32: a small seeded random number source, so a run can be replayed exactly. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** The seed's one job: the order the Loom lays the notes in. Shuffled on purpose, so row ids say
 *  nothing about time and the gate has to work from the stamps alone. */
function layingOrder(sc) {
  const rnd = seeded(sc.seed);
  const items = sc.loom.map((n, i) => i);
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  return items;
}
const strangerRun = (sc, runId) => `${runId}${sc.stranger.run_suffix}`;

/** Post the whole week face-down at launch, plus the stranger under another run's tag. */
function layLoom(file, sc, runId) {
  const order = layingOrder(sc);
  const loomClock = clock.simClock(sc.start);
  const bb = board(null, file, { clock: loomClock, run: runId, loom: true });
  const laid = [];
  try {
    for (const i of order) {
      const n = sc.loom[i];
      const r = bb.post({ topic: n.topic, author: sc.loom_author, value: n.text, at: n.at });
      laid.push({ id: r.id, at: r.at, topic: n.topic });
    }
  } finally { bb.close(); }
  const other = board(null, file, { clock: loomClock, run: strangerRun(sc, runId), loom: true });
  try {
    const r = other.post({ topic: sc.stranger.topic, author: sc.loom_author, value: sc.stranger.text, at: sc.stranger.at });
    laid.push({ id: r.id, at: r.at, topic: sc.stranger.topic, run: strangerRun(sc, runId) });
  } finally { other.close(); }
  return { order, laid };
}

/** One gate read: the notes this run can see at the clock's NOW, in sim-time order. */
function visible(bb) {
  return bb.query({ limit: 1000 })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id))
    .map(n => ({ id: n.id, at: n.at, topic: n.topic, text: n.value }));
}
/** A reading handle on the run's board: gated, never a loom handle. */
function readerFor(file, sc, runId) {
  const simClock = clock.simClock(sc.start);
  return { simClock, bb: board(null, file, { clock: simClock, run: runId }) };
}
/** Every turn's gate read, with no model in the loop (dry run and seed replay). */
function gateReads(file, sc, runId, turns) {
  const { simClock, bb } = readerFor(file, sc, runId);
  try { return turns.map(t => { simClock.set(t); return visible(bb); }); }
  finally { bb.close(); }
}

/** The Squire, as the open-gate check (Controls table). The same prompts built with the gate OFF:
 *  every row in the sim file, every run, every time. The detectors must find both planted words. */
function openGate(file, sc, system, turns) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  let rows;
  try { rows = db.prepare('SELECT * FROM notes ORDER BY at, id').all(); } finally { db.close(); }
  const all = rows.map(r => ({ id: r.id, at: r.at, topic: r.topic, text: JSON.parse(r.value) }));
  const calls = turns.map((t, i) => {
    const user = userPrompt(sc, t, all, []);
    return { label: `gate-off turn ${i + 1}`, sim_at: t, prompt: { system, user }, request: request(sc, system, user), reply: null };
  });
  return grader.openGateCheck(calls, sc);
}

/** Seed replay (machinery check): rebuild the board from the seed in a fresh file, redo every gate
 *  read with zero model calls, and compare with the run's lists exactly. */
function seedReplay(root, sc, runId, turns, recorded, replayRel, real) {
  const file = newBoardFile(root, replayRel, real);
  layLoom(file, sc, runId);
  const rebuilt = gateReads(file, sc, runId, turns);
  const mismatches = [];
  for (let i = 0; i < recorded.length; i++)
    if (JSON.stringify(rebuilt[i]) !== JSON.stringify(recorded[i])) mismatches.push(i + 1);
  if (rebuilt.length < recorded.length) mismatches.push('length');
  return { match: mismatches.length === 0 && recorded.length > 0, compared: recorded.length, mismatches, file: replayRel };
}

// ── L5: the live records, fingerprinted before and after ──────────────
function walk(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return [[abs, 'missing']]; }
  if (!st.isDirectory()) return [[abs, null]];
  return fs.readdirSync(abs).sort().flatMap(n => walk(path.join(abs, n)));
}
function snapshot(root, watched = WATCHED) {
  const out = {};
  for (const w of watched)
    for (const [abs, flag] of walk(path.join(root, w))) {
      const k = rel(root, abs);
      out[k] = flag === 'missing' ? 'missing' : (() => { try { return sha256(fs.readFileSync(abs)); } catch { return 'unreadable'; } })();
    }
  return out;
}

// ── money: real time, because the money is real (rule 11) ────────────
function quietHour(real) {                      // true inside 6 to 8 PM ET, when the Norns never run
  const h = clock.eastern(real.nowMs()).hour;
  return h >= QUIET_ET[0] && h < QUIET_ET[1];
}
function wallUsd(root) {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(root, 'data', 'imperium-registry.json'), 'utf8'));
    return reg && reg.budget && Number(reg.budget.daily_limit_usd) || 2;
  } catch { return 2; }
}
/** The ledger: INSERT only, tagged norns:trial-0, stamped by the real clock. */
function ledger(root, real = clock.real) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'data', 'imperial-ledger.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const ins = db.prepare('INSERT INTO api_calls (task_id, agent_id, model, input_tokens, output_tokens, cost_usd, called_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const day = db.prepare('INSERT INTO daily_totals (date, total_usd, total_calls) VALUES (?, ?, 1) ON CONFLICT(date) DO UPDATE SET total_usd = total_usd + excluded.total_usd, total_calls = total_calls + 1');
  const spent = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_calls WHERE date(called_at) = ?');
  return {
    log(taskId, agentId, model, inTok, outTok, cost) {
      if (agentId !== AGENT_ID) throw new Error(`norns: ledger rows must be tagged ${AGENT_ID}`);
      const iso = real.nowIso();
      ins.run(taskId, agentId, model, inTok, outTok, cost, iso.replace('T', ' ').replace('Z', ''));
      day.run(iso.slice(0, 10), cost);
    },
    spentToday: () => spent.get(real.nowIso().slice(0, 10)).total,
    close: () => db.close(),
  };
}

// ── the API (own call; the Warden's retries and timeout) ─────────────
function loadEnv(root) {                        // reads .env into process.env; never prints it
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('='); if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch { /* no .env */ }
}
function apiCall(payload, real = clock.real) {
  if (grader.hasTools(payload)) return Promise.reject(new Error('norns: refusing a request that carries tools'));
  const apiRetry = require(path.join(__dirname, 'api-retry.js'));
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Promise.reject(new Error('ANTHROPIC_API_KEY not set'));
  const body = JSON.stringify(payload);
  const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } };
  let lastHeaders = {};
  const once = () => new Promise(done => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        lastHeaders = res.headers || {};
        let parsed; try { parsed = JSON.parse(data); } catch { parsed = { error: { type: res.statusCode >= 500 ? 'api_error' : 'invalid_response', message: data.slice(0, 200) } }; }
        done({ status: res.statusCode, body: parsed, headers: res.headers });
      });
      res.on('error', error => done({ error }));
    });
    req.setTimeout(API_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('API call timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', error => done({ error }));
    req.write(body); req.end();
  });
  return apiRetry.withRetries(once, { log: m => console.warn(`[NORNS] ${m}`), now: real.nowMs })
    .then(b => ({ body: b, requestId: lastHeaders['request-id'] || null }));
}
const replyText = body => (body && Array.isArray(body.content)
  ? body.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : null);

// ── one call, with the fuse and the quiet hours checked first ─────────
async function oneCall(ctx, label, simAt, req) {
  const { root, real, sc, runId, api, led, spent } = ctx;
  const prompt = { system: req.system, user: req.messages[0].content };
  const row = { at: real.nowIso(), kind: 'call', run: runId, label, sim_at: simAt,
    prompt_hash: sha256(JSON.stringify(prompt)), prompt, request: req, worst_case_usd: worstCaseUsd(req) };
  if (spent.usd + row.worst_case_usd > FUSE_USD + 1e-12) return { stop: 'fuse', row: { ...row, refused: 'fuse' } };
  if (quietHour(real)) return { stop: 'quiet hours (6 to 8 PM ET)', row: { ...row, refused: 'quiet hours' } };
  try {
    const { body, requestId } = await api(req, real);
    if (!body || body.type === 'error' || body.error) {      // an API refusal is a failed call: that turn abstains
      const e = (body && body.error) || {};
      return { row: { ...row, reply: null, request_id: requestId, error: `${e.type || 'error'}: ${String(e.message || '').slice(0, 200)}`,
        done_at: real.nowIso() } };
    }
    const u = (body && body.usage) || {};
    const cost = estimateCost(sc.model, u.input_tokens || 0, u.output_tokens || 0);
    spent.usd += cost;
    led.log(runId, AGENT_ID, sc.model, u.input_tokens || 0, u.output_tokens || 0, cost);
    return { row: { ...row, reply: replyText(body), message_id: body && body.id || null, request_id: requestId,
      stop_reason: body && body.stop_reason || null, usage: u, cost_usd: cost, done_at: real.nowIso() } };
  } catch (e) {
    return { row: { ...row, reply: null, error: String(e && e.message || e).slice(0, 300), done_at: real.nowIso() } };
  }
}

// ── the run: one launch, one look ────────────────────────────────────
const RUN_LOG = 'output/trials/norns/trial-0/runs.jsonl';
const VERDICT = 'state/norns/trial-0/verdict.json';
const MARKER  = 'state/norns/trial-0/launched.json';

/** Lay the Loom, check the detector, make 22 calls through the gate, replay the seed, grade once,
 *  seal. `api` and `led` are passed in so tests can run it with no network (test fixtures only). */
async function runTrial(o) {
  const { root, srcRoot = root, real = clock.real, api = apiCall, led, runId } = o;
  const launchIso = o.launchIso || real.nowIso();
  const log = obj => appendLine(root, RUN_LOG, obj, real);
  const { sc, hash: scHash } = loadScenario(srcRoot);
  const sys = systemPrompt(srcRoot, sc);
  const turns = schedule(sc);
  const l5 = { before: snapshot(root) };
  const boardRel = `data/norns/trial-0-${runId}.db`;
  const file = newBoardFile(root, boardRel, real);
  log({ at: real.nowIso(), kind: 'start', run: runId, commit: o.commit || null, charter_hash: o.charterHash || null,
    scenario_hash: scHash, prompt_hashes: sys.hashes, seed: sc.seed, model: sc.model, board: boardRel,
    stranger_run: strangerRun(sc, runId) });
  const laid = layLoom(file, sc, runId);
  log({ at: real.nowIso(), kind: 'loom', run: runId, ...laid });
  const gate = openGate(file, sc, sys.text, turns);
  log({ at: real.nowIso(), kind: 'open-gate', run: runId, ...gate });

  const rec = { scenario: sc, turns: [], benchmark: null, openGate: gate, l5, realLaunchIso: launchIso,
    realEtDate: clock.eastern(Date.parse(launchIso)).date };
  const lists = [];
  const spent = { usd: 0 };
  let stopped = gate.ok ? null : 'open-gate check failed: no model calls made';
  if (!stopped) {
    const ctx = { root, real, sc, runId, api, led, spent };
    const b = await oneCall(ctx, 'benchmark', null, request(sc, sys.text, sc.benchmark_question));
    log(b.row);
    if (b.stop) stopped = b.stop;
    else rec.benchmark = { prompt: b.row.prompt, request: b.row.request, reply: b.row.reply ?? null, error: b.row.error ?? null };
    const { simClock, bb } = readerFor(file, sc, runId);
    const notebook = [];
    try {
      for (let i = 0; i < turns.length && !stopped; i++) {
        simClock.set(turns[i]);                                   // jump; due notes flip face-up
        const notes = visible(bb);
        lists.push(notes);
        const user = userPrompt(sc, turns[i], notes, notebook.slice(-sc.notebook_size));
        const r = await oneCall(ctx, `turn ${i + 1}`, turns[i], request(sc, sys.text, user));
        log({ ...r.row, turn: i + 1, visible_ids: notes.map(n => n.id) });
        if (r.stop) { stopped = r.stop; break; }                  // refused before sending: not a turn that ran
        rec.turns.push({ n: i + 1, sim_at: turns[i], prompt: r.row.prompt, request: r.row.request,
          reply: r.row.reply ?? null, error: r.row.error ?? null });
        if (typeof r.row.reply === 'string') notebook.push({ sim_at: turns[i], reply: r.row.reply });  // fills at t+1
      }
    } finally { bb.close(); }
  }
  l5.after = snapshot(root);
  rec.replay = seedReplay(root, sc, runId, turns.slice(0, lists.length), lists, `data/norns/trial-0-${runId}-replay.db`, real);
  log({ at: real.nowIso(), kind: 'replay', run: runId, ...rec.replay });

  const result = grader.grade(rec);                               // the one look
  const sealed = { at: real.nowIso(), kind: 'verdict', run: runId, verdict: result.verdict, reasons: result.reasons,
    stopped, spent_usd: +spent.usd.toFixed(6), commit: o.commit || null, charter_hash: o.charterHash || null, ...result };
  writeNew(root, VERDICT, JSON.stringify(sealed, null, 2), real);  // seals: a second verdict cannot be written
  writeNew(root, 'output/trials/norns/trial-0/verdict.json', JSON.stringify(sealed, null, 2), real);
  log({ at: sealed.at, kind: 'verdict', run: runId, verdict: sealed.verdict, reasons: sealed.reasons, stopped });
  return sealed;
}

// ── the dry run: zero model calls (build list item 6) ────────────────
function dryRun({ root = ROOT, srcRoot = ROOT, real = clock.real } = {}) {
  const { sc, hash: scHash } = loadScenario(srcRoot);
  const sys = systemPrompt(srcRoot, sc);
  const turns = schedule(sc);
  const at = real.nowIso();
  const label = `dry-${compact(at)}`;
  const boardRel = `data/norns/dry/trial-0-${label}.db`;
  const file = newBoardFile(root, boardRel, real);
  const laid = layLoom(file, sc, label);
  const gate = openGate(file, sc, sys.text, turns);
  const lists = gateReads(file, sc, label, turns);
  const calls = [{ label: 'benchmark', sim_at: null, prompt: { system: sys.text, user: sc.benchmark_question },
    request: request(sc, sys.text, sc.benchmark_question), reply: null }];
  lists.forEach((notes, i) => {
    const user = userPrompt(sc, turns[i], notes, []);
    calls.push({ label: `turn ${i + 1}`, sim_at: turns[i], prompt: { system: sys.text, user }, request: request(sc, sys.text, user), reply: null });
  });
  // The dry notebook is empty, so price each turn as if its notebook were full: up to six earlier
  // replies of up to max_tokens each, counted in tokens (an exact upper bound, no guessing).
  const worst = calls.map((c, i) => {
    const notebookTok = i <= 1 ? 0 : Math.min(i - 1, sc.notebook_size) * sc.max_tokens;
    const inTok = Math.ceil(Buffer.byteLength(c.prompt.system + c.prompt.user) / 2) + 50 + notebookTok;
    return estimateCost(sc.model, inTok, sc.max_tokens);
  });
  const worstRun = worst.reduce((a, b) => a + b, 0);
  const checks = grader.detect(calls, sc);
  const canaryTurns = lists.map((l, i) => (l.some(n => n.topic === 'hollowmere.roads') ? i + 1 : null)).filter(Boolean);
  const replay = seedReplay(root, sc, label, turns, lists, `data/norns/dry/trial-0-${label}-replay.db`, real);
  const summary = { at, kind: 'dry-run', label, model_calls: 0, calls_planned: calls.length, turns: turns.length,
    scenario_hash: scHash, prompt_hashes: sys.hashes, seed: sc.seed, laying_order: laid.order, board: boardRel,
    open_gate: gate, replay: { match: replay.match, compared: replay.compared, mismatches: replay.mismatches },
    build_checks: { L1: checks.L1.length, L1b: checks.L1b.length, L2: checks.L2.length, L3: checks.L3.length, L6: checks.L6.length },
    canary_visible_from_turn: canaryTurns[0] || null, canary_turns: canaryTurns.length,
    fuse: { worst_run_usd: +worstRun.toFixed(5), worst_call_usd: +Math.max(...worst).toFixed(5), fuse_usd: FUSE_USD, fits: worstRun <= FUSE_USD },
    note: 'Build check only. Never graded; not a verdict.' };
  appendLine(root, 'output/trials/norns/trial-0/dryruns.jsonl', summary, real);
  writeNew(root, `output/trials/norns/trial-0/dry/${label}-prompts.json`,
    JSON.stringify({ system_hash: sha256(sys.text), calls: calls.map(c => ({ label: c.label, sim_at: c.sim_at, user: c.prompt.user })) }, null, 2), real);
  return { ...summary, calls, lists };
}

// ── the lock and the launch ──────────────────────────────────────────
function lockCheck(root) {
  const lines = readLines(root, 'state/norns/lock.jsonl');
  if (!lines.length) return { ok: false, launched: false, why: 'not launched: no lock recorded' };
  const last = lines[lines.length - 1];
  const got = fileHash(root, CHARTER_FILE);
  if (!got) return { ok: false, launched: true, why: `${CHARTER_FILE} is missing` };
  if (got !== last.hash) return { ok: false, launched: true, why: 'charter changed since the hash was recorded' };
  return { ok: true, launched: true, hash: last.hash, run: last.run };
}

/** Opie's go. One launch, ever (rule 10). Nothing is spent unless every check passes. */
async function launch({ root = ROOT, real = clock.real, api = apiCall, ledgerFactory = ledger,
                        git = { commit: headCommit, dirty: uncommitted } } = {}) {
  if (fs.existsSync(path.join(root, MARKER)) || readLines(root, 'state/norns/lock.jsonl').length)
    return { ok: false, why: 'already launched: one run, one look (rule 10)' };
  let buf;
  try { buf = fs.readFileSync(path.join(root, CHARTER_FILE)); } catch { return { ok: false, why: `${CHARTER_FILE} not found` }; }
  const text = buf.toString('utf8');
  if (!/Initials:[\s\\_]*CM\b/.test(text) || !/Date:[\s\\_]*11\/16\/2026/.test(text))
    return { ok: false, why: 'charter file lacks the initials and date' };
  const dirty = git.dirty(root);
  if (dirty.length) return { ok: false, why: `commit first (build list item 7): ${dirty.join(', ')}` };
  const commit = git.commit(root);
  if (!commit) return { ok: false, why: 'no git commit to record' };
  if (quietHour(real)) return { ok: false, why: 'never between 6 and 8 PM ET' };
  loadEnv(root);
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, why: 'ANTHROPIC_API_KEY not set' };
  const { sc, hash: scHash } = loadScenario(root);
  const led = ledgerFactory(root, real);
  try {
    const spentToday = led.spentToday(), wall = wallUsd(root);
    if (spentToday + FUSE_USD > wall + 1e-9)
      return { ok: false, why: `start check: today's spend $${spentToday.toFixed(4)} plus the $${FUSE_USD} fuse does not fit under the $${wall} wall` };
    const hash = sha256(buf);
    const at = real.nowIso();
    const runId = `t0-${sc.seed}-${compact(at)}`;
    writeNew(root, MARKER, JSON.stringify({ at, run: runId, hash, commit }, null, 2), real);   // one launch: 'wx'
    try { writeNew(root, `state/norns/charter/${hash}.md`, buf, real); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const sys = systemPrompt(root, sc);
    const row = { at, kind: 'launch', run: runId, hash, commit, bytes: buf.length, scenario: scHash, prompt_hashes: sys.hashes };
    appendLine(root, 'state/norns/lock.jsonl', row, real);
    appendLine(root, RUN_LOG, row, real);
    const lock = lockCheck(root);
    if (!lock.ok) return { ok: false, why: `lock: ${lock.why}` };
    let sealed;
    try { sealed = await runTrial({ root, srcRoot: root, real, api, led, runId, commit, charterHash: hash, launchIso: at }); }
    catch (e) {                                   // never restarted (rule 10); the log keeps what happened
      appendLine(root, RUN_LOG, { at: real.nowIso(), kind: 'crash', run: runId, error: String(e && e.message || e) }, real);
      return { ok: false, run: runId, why: `the run crashed before sealing a verdict: ${e && e.message}` };
    }
    return { ok: true, run: runId, verdict: sealed.verdict, reasons: sealed.reasons };
  } finally { led.close(); }
}

function status(root = ROOT) {
  const lock = lockCheck(root);
  const verdict = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, VERDICT), 'utf8')); } catch { return null; } })();
  return { lock, launched: fs.existsSync(path.join(root, MARKER)), verdict: verdict ? verdict.verdict : null,
    dry_runs: readLines(root, 'output/trials/norns/trial-0/dryruns.jsonl').length };
}

module.exports = { ROOT, CHARTER_FILE, SCENARIO_FILE, AGENT_ID, FUSE_USD, QUIET_ET, CODE_FILES, WATCHED, PRICING,
  ALLOWED, FORBIDDEN, estimateCost, guard, writeNew, appendLine, newBoardFile, loadScenario, systemPrompt, schedule,
  longLabel, shortLabel, nornsLine, userPrompt, request, worstCaseUsd, seeded, layingOrder, strangerRun, layLoom,
  visible, readerFor, gateReads, openGate, seedReplay, snapshot, quietHour, wallUsd, ledger, apiCall, replyText,
  oneCall, runTrial, dryRun, lockCheck, launch, status, uncommitted, headCommit };

if (require.main === module) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === 'dryrun') {
      const s = dryRun();
      const { calls, lists, ...shown } = s;
      console.log(JSON.stringify(shown, null, 2));
    } else if (cmd === 'launch') {
      const r = await launch();
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exitCode = 1;
    } else if (cmd === 'status') {
      console.log(JSON.stringify(status(), null, 2));
    } else {
      console.log('usage: node runners/norns.js dryrun | status | launch');
      process.exitCode = 2;
    }
  })().catch(e => { console.error(`[NORNS] ${e.message}`); process.exitCode = 1; });
}
