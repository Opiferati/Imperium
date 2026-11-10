'use strict';
// ══════════════════════════════════════════════════════════════════════
// THESIS_G — THE IMPOSTOR WATCH, POINTED AT THE MINDS
// Signed by Opie 2026-11-10. Bound by all fifteen of the Empire's laws.
//
// The claim: three different model tiers reading the same headlines produce
// INDEPENDENT judgments — a panel of three models disagrees with itself MORE
// than one model disagrees with itself across repeated calls.
//
// This card only COLLECTS AND FREEZES. It computes no verdict and reports no
// result beyond a progress count. The box opens once, at 60 observations,
// from a separate script (law 3: one look, no peeking, no early stopping).
//
// Every constant below is fixed by the signed charter. Changing one requires
// a dated amendment with Opie's initials — never an edit here. That is why
// they are in code sealed by the charter hash and not in the registry, which
// the operator may change at will.
// ══════════════════════════════════════════════════════════════════════

const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const charterMod = require('../../runners/charter.js');

const CHARTER = 'THESIS_G.md';
const LEDGER  = ['library', 'thesis_g.jsonl'];
const LAUNCH  = ['state', 'thesis_g_launch.json'];

// ── Pre-registered by the signed charter ──────────────────────────────
const OBSERVATIONS_NEEDED = 60;
const PROGRESS_AT         = 30;
const PANEL               = ['haiku', 'sonnet', 'opus'];
const BENCH_MODEL         = 'haiku';
const BENCH_N             = 3;
const JESTER_LO           = 20;
const JESTER_HI           = 80;
const STIMULI             = ['stock', 'crypto'];
const MAX_TOKENS          = 64;
const JESTER_SEED         = 'thesis-g-jester-2026-11-10';
const SQUIRE_SEED         = 'thesis-g-squire-2026-11-10';

// Identical for the panel, the benchmark and the squire. If this string ever
// differs between riders the test is comparing prompts, not minds.
const SYSTEM = [
  'You score market mood from a fixed list of news items.',
  'Reply with ONLY a JSON object and nothing else: {"mood": <integer 0-100>}',
  '0 is maximum fear, 50 is neutral, 100 is maximum greed.',
  'Judge only from the items given. Do not search. Do not explain.',
].join('\n');

// ── Plumbing ──────────────────────────────────────────────────────────
const at = (root, parts) => path.join(root, ...parts);

function readLedger(root) {
  try {
    return fs.readFileSync(at(root, LEDGER), 'utf8').split('\n')
      .filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** Append-only (law 14). Nothing here is ever rewritten. */
function append(root, row) {
  const p = at(root, LEDGER);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(row) + '\n');
}

function sd(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
}

/** Display-only descriptive: mean pairwise absolute disagreement. Non-degenerate,
 *  intuitive, and it never enters a verdict. */
function meanPairAbs(xs) {
  let s = 0, k = 0;
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) { s += Math.abs(xs[i] - xs[j]); k++; }
  }
  return k ? s / k : null;
}

function seededInt(seed, lo, hi) {
  const h = crypto.createHash('sha256').update(seed).digest();
  return lo + (h.readUInt32BE(0) % (hi - lo + 1));
}

/** The Jester: three seeded uniform draws. THE CEILING — three minds sharing
 *  nothing at all, including the news. No model call, no cost. */
function jesterScores(day, kind) {
  return [0, 1, 2].map(i => seededInt(`${JESTER_SEED}|${day}|${kind}|${i}`, JESTER_LO, JESTER_HI));
}

/** The stimulus: the drivers the Skald already froze for that date. A thin or
 *  failed reading ABSTAINS — law 5, nothing is filled in or carried forward. */
function driversFor(root, day, kind) {
  let a;
  try { a = JSON.parse(fs.readFileSync(at(root, ['data', 'skald-archive', `${day}.json`]), 'utf8')); }
  catch (e) { return { ok: false, why: `no frozen Skald archive for ${day} (${e.code || e.message})` }; }
  if (a.quality !== 'pass') return { ok: false, why: `the Skald reading for ${day} was "${a.quality}"` };
  const key = `${kind}_drivers`;
  const d = (a.reading || {})[key];
  if (!Array.isArray(d) || !d.length) return { ok: false, why: `no ${key} in the ${day} archive` };
  return { ok: true, drivers: d, skald_model: a.model, skald_score: (a.reading || {})[`${kind}_mood`] };
}

/** The Squire's placebo: a seeded past date, never today's. Tests whether the
 *  disagreement is about THE NEWS or is constitutional noise. */
function placeboDate(root, day, kind) {
  let dates = [];
  try {
    dates = fs.readdirSync(at(root, ['data', 'skald-archive']))
      .filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
      .filter(d => d < day).sort();
  } catch { return null; }
  if (!dates.length) return null;
  return dates[seededInt(`${SQUIRE_SEED}|${day}|${kind}`, 0, dates.length - 1)];
}

/** The prompt, built the same way for every rider. */
function promptFor(drivers) {
  const items = drivers.map((d, i) =>
    `${i + 1}. ${d.event || ''}${d.effect ? ` [${d.effect}]` : ''}`).join('\n');
  return [{ role: 'user', content: `News items:\n${items}\n\nScore the mood.` }];
}

/** Parse the score. An unreadable answer ABSTAINS rather than being guessed at. */
function parseMood(text) {
  const m = String(text || '').match(/"?mood"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i)
         || String(text || '').match(/\b(\d{1,3})\b/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/** Law 2: the hash of the signed body is recorded at launch and checked every run. */
function lock(root, hash, day) {
  const p = at(root, LAUNCH);
  if (fs.existsSync(p)) {
    const l = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (l.charter_hash !== hash) {
      return { ok: false, why: `the charter body has changed since launch `
        + `(locked ${l.charter_hash}, now ${hash}). Changes arrive only as dated `
        + `amendments with initials — never edits.` };
    }
    return { ok: true, launch: l, fresh: false };
  }
  const l = { thesis: 'THESIS_G', charter_hash: hash, launch_date: day,
              launched_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(l, null, 2));
  return { ok: true, launch: l, fresh: true };
}

/** Law 14: every run records the code commit. Pure file reads, no subprocess. */
function headCommit(root) {
  try {
    const h = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (h.startsWith('ref: ')) {
      return fs.readFileSync(path.join(root, '.git', h.slice(5)), 'utf8').trim().slice(0, 12);
    }
    return h.slice(0, 12);
  } catch { return null; }
}

async function run(ctx) {
  const root = ctx.root;

  // Law 1: an unsigned charter does not run. Docked, not failed — this is a
  // legitimate state, not a fault.
  const ch = charterMod.check(root, CHARTER);
  if (!ch.ok) return { status: 'docked', message: ch.why };

  const lk = lock(root, ch.hash, ctx.day);
  if (!lk.ok) return { status: 'error', message: lk.why };

  const commit = headCommit(root);
  const already = new Set(readLedger(root).map(r => `${r.day}|${r.stimulus}`));
  const froze = [], abstained = [];

  for (const kind of STIMULI) {
    if (already.has(`${ctx.day}|${kind}`)) { abstained.push(`${kind}: already frozen`); continue; }

    const st = driversFor(root, ctx.day, kind);
    if (!st.ok) {
      append(root, { kind: 'abstention', day: ctx.day, stimulus: kind,
                     at: ctx.now().toISOString(), why: st.why, charter_hash: ch.hash, commit });
      abstained.push(`${kind}: ${st.why}`);
      continue;
    }

    const msgs = promptFor(st.drivers);
    const spend = { cost_usd: 0, calls: 0 };
    const ask = async (model, messages) => {
      const r = await ctx.infer({ model, system: SYSTEM, messages, max_tokens: MAX_TOKENS });
      spend.cost_usd += r.cost_usd; spend.calls += 1;
      return { model: r.model, mood: parseMood(r.text) };
    };

    let panel, bench, squire = null, squireDate = null;
    try {
      // The Panel: three different tiers, same frozen headlines, fresh context each.
      panel = [];
      for (const m of PANEL) panel.push(await ask(m, msgs));

      // The Benchmark: ONE model, three calls. The floor.
      bench = [];
      for (let i = 0; i < BENCH_N; i++) bench.push(await ask(BENCH_MODEL, msgs));

      // The Squire: the same three tiers on a seeded past date's headlines.
      squireDate = placeboDate(root, ctx.day, kind);
      if (squireDate) {
        const ps = driversFor(root, squireDate, kind);
        if (ps.ok) {
          const pmsgs = promptFor(ps.drivers);
          squire = [];
          for (const m of PANEL) squire.push(await ask(m, pmsgs));
        }
      }
    } catch (e) {
      // A budget refusal abstains. The calls already spent are recorded so the
      // cost is never invisible, but NO partial observation is written: law 5,
      // nothing is filled in or carried forward.
      const why = e.budget ? `abstained — ${e.message}` : `the run failed — ${e.message}`;
      append(root, { kind: 'abstention', day: ctx.day, stimulus: kind,
                     at: ctx.now().toISOString(), why, cost_usd: spend.cost_usd,
                     calls: spend.calls, charter_hash: ch.hash, commit });
      abstained.push(`${kind}: ${why}`);
      if (!e.budget) throw e;
      continue;
    }

    const pm = panel.map(x => x.mood);
    const bm = bench.map(x => x.mood);
    if (pm.some(v => v === null) || bm.some(v => v === null)) {
      const why = 'a model returned an unreadable score';
      append(root, { kind: 'abstention', day: ctx.day, stimulus: kind,
                     at: ctx.now().toISOString(), why, cost_usd: spend.cost_usd,
                     calls: spend.calls, charter_hash: ch.hash, commit });
      abstained.push(`${kind}: ${why}`);
      continue;
    }

    const js = jesterScores(ctx.day, kind);
    const sm = squire && squire.every(x => x.mood !== null) ? squire.map(x => x.mood) : null;

    append(root, {
      kind: 'observation',
      day: ctx.day, stimulus: kind, at: ctx.now().toISOString(),
      charter_hash: ch.hash, commit,
      skald_model: st.skald_model, skald_score: st.skald_score, drivers_n: st.drivers.length,
      panel:     { models: panel.map(x => x.model), scores: pm, sd: sd(pm), pair_abs: meanPairAbs(pm) },
      benchmark: { model: BENCH_MODEL, scores: bm, sd: sd(bm), pair_abs: meanPairAbs(bm) },
      jester:    { scores: js, sd: sd(js), pair_abs: meanPairAbs(js) },
      squire:    sm ? { date: squireDate, models: squire.map(x => x.model), scores: sm,
                        sd: sd(sm), pair_abs: meanPairAbs(sm) } : null,
      squire_why: sm ? null : (squireDate ? 'placebo set unreadable' : 'no earlier archive yet'),
      delta: sd(pm) - sd(bm),
      cost_usd: spend.cost_usd, calls: spend.calls,
    });
    froze.push(kind);
  }

  const rows = readLedger(root);
  const n = rows.filter(r => r.kind === 'observation').length;
  const spent = rows.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);

  // Progress on the floor. Display-only (law 3) and the COUNT ONLY — no delta,
  // no mean, nothing that would let anyone read the answer early. Peeking is not
  // prevented by good intentions, it is prevented by not writing the number down.
  if (ctx.board) {
    try {
      ctx.board.post({
        topic: 'thesis_g.progress',
        value: { observations: n, needed: OBSERVATIONS_NEEDED, display_only: true },
        source: 'panel', confidence: 1, if_changed: true,
      });
    } catch { /* the board is not the thesis */ }
  }

  if (lk.fresh) ctx.log(`THESIS_G launched, charter ${ch.hash}, signed by ${ch.who} on ${ch.date}`);
  return {
    status: froze.length ? 'ok' : 'thin',
    froze, abstained, observations: n, needed: OBSERVATIONS_NEEDED,
    cost_total_usd: spent, launched: lk.fresh,
    ready: n >= OBSERVATIONS_NEEDED, progress_due: n >= PROGRESS_AT,
  };
}

/** One line for the court. Says how far along, never how it is going. */
function summaryLine(r) {
  if (r.status === 'docked' || r.status === 'error') {
    return `[THESIS G] ${r.status}: ${r.message}`;
  }
  const bits = [`[THESIS G] ${r.observations}/${r.needed} observations`];
  if (r.launched) bits.push('LAUNCHED tonight');
  if (r.froze && r.froze.length) bits.push(`froze ${r.froze.join(' + ')}`);
  if (r.abstained && r.abstained.length) bits.push(`abstained: ${r.abstained.join('; ')}`);
  bits.push(`$${(r.cost_total_usd || 0).toFixed(4)} spent to date`);
  if (r.ready) bits.push('CHECKPOINT REACHED — the box may be opened, once');
  return bits.join(' · ') + '.';
}

module.exports = {
  run, summaryLine,
  // exported for the tests and the verdict script
  sd, meanPairAbs, parseMood, jesterScores, placeboDate, promptFor, driversFor,
  OBSERVATIONS_NEEDED, PANEL, BENCH_MODEL, BENCH_N, STIMULI, SYSTEM, CHARTER,
};
