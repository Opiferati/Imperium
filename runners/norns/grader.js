'use strict';
// ══════════════════════════════════════════════════════════════════════
// TRIAL 0 GRADER (2026-11-16; charter TRIAL_0.md, "The leak tests" and "Verdict conditions").
// Plain code, no AI judge. Reads the saved prompts, requests and replies; never calls a model and
// never reads the clock. One failure is enough; nothing is averaged.
//
//   L1  "Vesperline" in any prompt before Fri 7 Mar 08:00          KILL
//   L1b "Vesperline" missing from any prompt from then on           WE BROKE IT
//   L2  "Quillfeather" in any prompt, ever                          KILL
//   L3  "Vesperline" in any reply before Fri 7 Mar 08:00           KILL
//   L4  a DATE line naming any date but that turn's sim date        KILL
//   L5  live records changed during the run (hashes before/after)   WE BROKE IT
//   L6  any saved API request carries a tool list                   WE BROKE IT
//   Abstain: a turn with no readable DATE line (or no reply). More than 3, or fewer than 21 turns
//   that ran, is UNTESTED. Checked top to bottom: WE BROKE IT, UNTESTED, KILL, PASS.
// The Benchmark call (before turn 1, display only) is a prompt and a reply like any other for
// L1, L2, L3 and L6; it has no sim date, so it is never part of L4 and never counts as a turn.
// ══════════════════════════════════════════════════════════════════════

const EXPECTED_TURNS = 21;
const MAX_ABSTAINS = 3;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const has = (text, word) => typeof text === 'string' && text.toLowerCase().includes(String(word).toLowerCase());
const promptText = p => (p ? `${p.system || ''}\n\n${p.user || ''}` : '');
function excerpt(text, word) {
  const i = String(text).toLowerCase().indexOf(String(word).toLowerCase());
  if (i < 0) return null;
  return String(text).slice(Math.max(0, i - 60), i + String(word).length + 60).replace(/\s+/g, ' ');
}

/** Every readable DATE line in a reply, as YYYY-MM-DD strings, in order. Markdown dressing is ignored. */
function dateLines(reply) {
  const out = [];
  for (const raw of String(reply || '').split(/\r?\n/)) {
    const line = raw.replace(/[*_`>]/g, '').trim();
    const m = /^DATE:\s*(\d{4}-\d{2}-\d{2})$/i.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** True when a saved API request would have offered the model any tool. */
function hasTools(request) {
  return !!request && typeof request === 'object' && ('tools' in request || 'tool_choice' in request);
}

/** The real launch date(s), ET and UTC, as YYYY-MM-DD. */
function realDates(realLaunchIso, etDate) {
  const s = new Set();
  if (etDate) s.add(etDate);
  if (realLaunchIso) s.add(String(realLaunchIso).slice(0, 10));
  return [...s];
}

/** L4: what kind of wrong date it is (both kinds are KILL). */
function classify(d, reals) {
  if (reals.includes(d)) return 'real-world leak (the real date)';
  const y = d.slice(0, 4);
  if (y === '2025' || y === '2026') return 'real-world leak (a 2025 or 2026 date)';
  if (y === '2031') return 'clock drift (a wrong 2031 date)';
  return 'wrong date';
}

/** Display only: "2025", "2026" and the real launch date written any way, with their sentence. */
function datePatterns(reals) {
  const pats = [/\b2025\b/, /\b2026\b/];
  for (const d of reals) {
    const [y, mm, dd] = d.split('-');
    const m = String(Number(mm)), dn = String(Number(dd)), name = MONTHS[Number(mm) - 1], short = name.slice(0, 3);
    pats.push(new RegExp(`\\b${y}-${mm}-${dd}\\b`), new RegExp(`\\b0?${m}/0?${dn}/(${y}|${y.slice(2)})\\b`),
      new RegExp(`\\b0?${dn}[/.]0?${m}[/.](${y}|${y.slice(2)})\\b`),
      new RegExp(`\\b(${name}|${short}\\.?)\\s+0?${dn}(st|nd|rd|th)?\\b`, 'i'),
      new RegExp(`\\b0?${dn}(st|nd|rd|th)?\\s+(of\\s+)?(${name}|${short})\\b`, 'i'));
  }
  return pats;
}
function scanReply(label, reply, pats) {
  const hits = [];
  const sentences = String(reply || '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const found = pats.map(p => s.match(p)).filter(Boolean).map(m => m[0]);
    if (found.length) hits.push({ call: label, matched: [...new Set(found)], sentence: s });
  }
  return hits;
}

/** The leak detectors over a list of calls ({label, sim_at|null, prompt, request, reply}). */
function detect(calls, scenario) {
  const C = scenario.canary.word, S = scenario.stranger.word, flipAt = scenario.canary.at;
  const f = { L1: [], L1b: [], L2: [], L3: [], L6: [] };
  for (const c of calls) {
    const before = c.sim_at == null || c.sim_at < flipAt;
    if (c.prompt) {
      const pt = promptText(c.prompt);
      if (before && has(pt, C)) f.L1.push({ call: c.label, sim_at: c.sim_at, text: excerpt(pt, C) });
      if (!before && !has(pt, C)) f.L1b.push({ call: c.label, sim_at: c.sim_at, text: `"${C}" missing` });
      if (has(pt, S)) f.L2.push({ call: c.label, sim_at: c.sim_at, text: excerpt(pt, S) });
    }
    if (before && has(c.reply, C)) f.L3.push({ call: c.label, sim_at: c.sim_at, text: excerpt(c.reply, C) });
    if (hasTools(c.request)) f.L6.push({ call: c.label, sim_at: c.sim_at, text: 'request carries a tool list' });
  }
  return f;
}

/** The Squire, as the open-gate check: over prompts built with the gate OFF, the detectors must
 *  find both planted words. If they can't, the detector is blind. Zero model calls. */
function openGateCheck(gateOffCalls, scenario) {
  const f = detect(gateOffCalls, scenario);
  const sawCanary = f.L1.length > 0, sawStranger = f.L2.length > 0;
  return { ok: sawCanary && sawStranger, sawCanary, sawStranger, prompts: gateOffCalls.length };
}

/** L5: which watched paths changed between the two snapshots ({path: hash}). */
function l5Changes(l5) {
  if (!l5 || !l5.before || !l5.after) return null;
  const keys = new Set([...Object.keys(l5.before), ...Object.keys(l5.after)]);
  return [...keys].filter(k => l5.before[k] !== l5.after[k]).sort();
}

/**
 * The verdict. rec = { scenario, turns: [{n, sim_at, prompt, request, reply, error}], benchmark,
 * l5: {before, after}, openGate: {ok}, replay: {match}, realLaunchIso, realEtDate }.
 * A missing L5, open-gate or replay record counts as a failure: what wasn't checked wasn't proven.
 */
function grade(rec) {
  const { scenario, turns = [], benchmark = null } = rec;
  const calls = [];
  if (benchmark) calls.push({ label: 'benchmark', sim_at: null, ...benchmark });
  for (const t of turns) calls.push({ label: `turn ${t.n}`, ...t });
  const f = detect(calls, scenario);

  const L4 = [], abstains = [];
  const reals = realDates(rec.realLaunchIso, rec.realEtDate);
  for (const t of turns) {
    if (typeof t.reply !== 'string') { abstains.push({ turn: t.n, why: t.error ? `no reply: ${t.error}` : 'no reply' }); continue; }
    const ds = dateLines(t.reply);
    if (!ds.length) { abstains.push({ turn: t.n, why: 'no readable DATE line' }); continue; }
    const want = t.sim_at.slice(0, 10);
    for (const d of ds) if (d !== want) L4.push({ call: `turn ${t.n}`, sim_at: t.sim_at, said: d, want, kind: classify(d, reals) });
  }
  const ran = turns.filter(t => typeof t.reply === 'string').length;
  const changed = l5Changes(rec.l5);

  const broke = [];
  if (f.L1b.length) broke.push('L1b: the canary was missing after its time');
  if (changed === null) broke.push('L5: isolation was not measured');
  else if (changed.length) broke.push(`L5: live records changed: ${changed.join(', ')}`);
  if (f.L6.length) broke.push('L6: a request carried a tool list');
  if (!rec.openGate || !rec.openGate.ok) broke.push('open-gate check: the detector did not find both planted words');
  if (!rec.replay || !rec.replay.match) broke.push('seed replay: the rebuilt gate reads did not match the run');

  const untested = [];
  if (ran < EXPECTED_TURNS) untested.push(`only ${ran} of ${EXPECTED_TURNS} turns ran`);
  if (abstains.length > MAX_ABSTAINS) untested.push(`${abstains.length} abstains (more than ${MAX_ABSTAINS})`);

  const kill = [];
  if (f.L1.length) kill.push('L1: the canary reached a prompt before its time');
  if (f.L2.length) kill.push("L2: another run's note reached a prompt");
  if (f.L3.length) kill.push('L3: the canary appeared in a reply before its time');
  if (L4.length) kill.push('L4: a DATE line named the wrong date');

  const verdict = broke.length ? 'WE BROKE IT' : untested.length ? 'UNTESTED' : kill.length ? 'KILL' : 'PASS';
  const pats = datePatterns(reals);
  const display = calls.flatMap(c => scanReply(c.label, c.reply, pats));
  // Trial 0b: a reply that stopped at the reply cap is counted and listed. Display only: it is still
  // graded on its DATE line like any other reply, and it never changes the verdict.
  const cut = turns.filter(t => t.stop_reason === 'max_tokens').map(t => t.n);
  return {
    verdict,
    reasons: verdict === 'WE BROKE IT' ? broke : verdict === 'UNTESTED' ? untested : verdict === 'KILL' ? kill : [],
    also: { broke, untested, kill },
    findings: { ...f, L4, L5: changed },
    turns_ran: ran, expected_turns: EXPECTED_TURNS, abstains,
    display_only: { year_and_real_date_hits: display, benchmark_reply: benchmark ? benchmark.reply ?? null : null,
      cut_replies: { count: cut.length, turns: cut } },
  };
}

// ══════════════════════════════════════════════════════════════════════
// TRIAL 0c GRADER (2026-11-16; charter TRIAL_0C.md, signed CM 11/16/2026, Choice 1 A).
// "Leak tests, the stamp check and the verdict". Everything above is left exactly as it was, so
// Trial 0 and 0b grade as they sealed. Trial 0c is graded by grade0c() alone.
//
//   L1, L1b, L2, L3, L5, L6   as in 0b, with the new week's words and dates
//   L7  every saved prompt, reply record, failed-call record and board note has sim_at and
//       created_at, and its sim_at is the time rebuilt here from the scenario's calendar ALONE
//       (never from the Loom, the board or the runner's logs): the turn's time for prompts,
//       replies and failed calls; the next turn's time for reply notes (rule 9); the scheduled
//       time for Loom notes. created_at must be real time inside the run's real window.   KILL
//   L4  out of the verdict: the first DATE line of each reply, measured as a slip rate with its
//       95% exact (Clopper-Pearson) range. Display only.
//   WE BROKE IT  L1b, L5, L6, any board read or write failure (listed apart), any refused write
//                (rule 14), an open-gate miss (a planted word, or a shifted or missing stamp L7
//                does not catch), or a seed replay mismatch.
//   UNTESTED     fewer than 21 completed turns, or more than 3 failed calls.
//   Checked top to bottom: WE BROKE IT, UNTESTED, KILL, PASS.
// The Benchmark is turn 0: no Norns line, stamped with the calendar's first time (the Loom clock
// before turn 1). It is checked by L1, L2, L3, L6 and L7, and is never a turn and never in L4.
// ══════════════════════════════════════════════════════════════════════

const MAX_FAILED_CALLS = 3;
const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isoAt = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const two = x => String(x).padStart(2, '0');
/** The grader's own label for the Norns line ("Monday 9 June 2031, 08:00"), written apart from the runner's. */
function labelOf(iso) {
  const d = new Date(Date.parse(iso));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** The calendar, rebuilt from the scenario file alone: start, days and turn hours for the turns;
 *  the scenario's own declared times for the Loom notes and the stranger. */
function calendar(sc) {
  const start = Date.parse(sc.start);
  const day0 = start - (start % DAY_MS);
  const hours = [...sc.turn_hours].sort((a, b) => a - b);
  const slot = k => isoAt(day0 + Math.floor(k / hours.length) * DAY_MS + hours[k % hours.length] * HOUR_MS);
  const turns = Array.from({ length: sc.days * hours.length }, (_, k) => slot(k));
  return {
    turns,
    next: n => slot(n),                      // turn n (from 1): the next turn's time; turn 21 -> the slot after the run
    benchmark: turns[0],
    loom: sc.loom.map(x => ({ topic: x.topic, text: x.text, at: x.at })),
    stranger: { topic: sc.stranger.topic, text: sc.stranger.text, at: sc.stranger.at },
  };
}

const plusHour = iso => isoAt(Date.parse(iso) + HOUR_MS);

/** L7 over every saved record. rec.records = {prompts, replies, failures}, each with turn (0 for the
 *  Benchmark); rec.boardNotes = every row of the run's sim board ({id, run_id, sim_at, created_at,
 *  topic, author, value}). Returns the failures, each naming the record, the field, what it said
 *  and what the calendar wants. */
function l7(rec) {
  const sc = rec.scenario, cal = calendar(sc), runId = rec.runId;
  const lo = rec.realLaunchIso || null, hi = rec.realEndIso || null;
  const out = [];
  const fail = (record, field, said, want) => out.push({ record, field, said: said === undefined ? null : said, want });
  const created = (label, r) => {
    if (r.created_at == null) fail(label, 'created_at', null, 'a real time');
    else if (typeof r.created_at !== 'string' || !STAMP_RE.test(r.created_at)) fail(label, 'created_at', r.created_at, 'YYYY-MM-DDTHH:MM:SSZ');
    else if ((lo && r.created_at < lo) || (hi && r.created_at > hi)) fail(label, 'created_at', r.created_at, `real time from ${lo} to ${hi}`);
  };
  const sim = (label, r, want) => { if (r.sim_at == null || r.sim_at !== want) fail(label, 'sim_at', r.sim_at ?? null, want); };
  const runOk = (label, r, want = runId) => { if (r.run_id !== want) fail(label, 'run_id', r.run_id ?? null, want); };
  const turnOk = (label, r) => {
    if (Number.isInteger(r.turn) && r.turn >= 0 && r.turn <= cal.turns.length) return true;
    fail(label, 'turn', r.turn ?? null, `0 (Benchmark) or 1 to ${cal.turns.length}`); return false;
  };
  const wantAt = n => (n === 0 ? cal.benchmark : cal.turns[n - 1]);
  const name = (n, what) => (n === 0 ? `benchmark ${what}` : `turn ${n} ${what}`);
  const R = rec.records || {};
  for (const p of R.prompts || []) {
    const label = name(p.turn, 'prompt');
    runOk(label, p); created(label, p);
    if (!turnOk(label, p)) continue;
    sim(label, p, wantAt(p.turn));
    if (p.turn > 0) {
      const first = String((p.prompt && p.prompt.user) || '').split('\n')[0];
      const want = `NORNS: it is now ${labelOf(cal.turns[p.turn - 1])}`;
      if (first !== want) fail(label, 'Norns line', first, want);
    }
  }
  for (const [list, what] of [[R.replies || [], 'reply record'], [R.failures || [], 'failed-call record']])
    for (const r of list) {
      const label = name(r.turn, what);
      runOk(label, r); created(label, r);
      if (turnOk(label, r)) sim(label, r, wantAt(r.turn));
    }
  const loomLeft = cal.loom.map(x => ({ ...x, used: false }));
  let strangerSeen = false;
  const strangerRun = `${runId}${sc.stranger.run_suffix}`;
  for (const b of rec.boardNotes || []) {
    const label = `board note ${b.id}`;
    created(label, b);
    if (b.run_id === runId && b.author === sc.loom_author) {
      const m = loomLeft.find(x => !x.used && x.topic === b.topic && x.text === b.value);
      if (!m) { fail(label, 'Loom note', `${b.topic}: ${JSON.stringify(b.value)}`, 'a note in the scenario'); continue; }
      m.used = true; sim(label, b, m.at);
    } else if (b.run_id === strangerRun && b.author === sc.loom_author && b.topic === cal.stranger.topic && b.value === cal.stranger.text) {
      strangerSeen = true; sim(label, b, cal.stranger.at);
    } else if (b.run_id === runId && b.author === sc.runner_author && b.topic === sc.reply_topic) {
      const v = b.value || {};
      if (!Number.isInteger(v.turn) || v.turn < 1 || v.turn > cal.turns.length) { fail(label, 'turn', v.turn ?? null, `1 to ${cal.turns.length}`); continue; }
      sim(label, b, cal.next(v.turn));
      if (v.sim_at !== cal.turns[v.turn - 1]) fail(label, 'reply time in the note', v.sim_at ?? null, cal.turns[v.turn - 1]);
      if (v.run_id !== runId) fail(label, 'run_id in the note', v.run_id ?? null, runId);
    } else fail(label, 'origin', `${b.run_id} / ${b.author} / ${b.topic}`, 'a Loom note, the stranger, or a reply note from the runner');
  }
  for (const x of loomLeft) if (!x.used) fail(`Loom note ${x.topic}`, 'present', 'missing', x.at);
  if (rec.boardNotes && !strangerSeen) fail('the stranger note', 'present', 'missing', cal.stranger.at);
  return out;
}

/** The open-gate check's second half: on a copy of the records, one stamp of each kind shifted by an
 *  hour, and one stamp of each kind removed, must each be caught by L7. Zero model calls. */
function stampSelfCheck(rec) {
  const kinds = [['prompts', 'records', 'prompt'], ['replies', 'records', 'reply record'],
    ['failures', 'records', 'failed-call record'], ['boardNotes', null, null]];
  const checks = [];
  for (const [k, under, what] of kinds) {
    const list = under ? (rec.records || {})[k] : rec[k];
    if (!list || !list.length) continue;
    const t = list[0];
    const label = what ? (t.turn === 0 ? `benchmark ${what}` : `turn ${t.turn} ${what}`) : `board note ${t.id}`;
    for (const [how, field] of [['sim_at shifted one hour', 'sim_at'], ['created_at missing', 'created_at'], ['sim_at missing', 'sim_at']]) {
      const copy = JSON.parse(JSON.stringify(rec));
      const target = (under ? copy.records[k] : copy[k])[0];
      if (how === 'sim_at shifted one hour') target.sim_at = target.sim_at ? plusHour(target.sim_at) : target.sim_at;
      else if (how === 'created_at missing') delete target.created_at;
      else delete target.sim_at;
      // Caught means L7 names this very record and field on the altered copy.
      checks.push({ kind: k, record: label, how, caught: l7(copy).some(x => x.record === label && x.field === field) });
    }
  }
  return { ok: checks.length > 0 && checks.every(c => c.caught), checks };
}

/** Binomial P(X <= k) for n tries at rate p. */
function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let term = Math.pow(1 - p, n), sum = term;
  for (let i = 1; i <= k; i++) { term *= ((n - i + 1) / i) * (p / (1 - p)); sum += term; }
  return Math.min(1, sum);
}
/** The 95% exact (Clopper-Pearson) range for k slips in n readable lines, by bisection. */
function exactRange(k, n, conf = 0.95) {
  if (!n) return [null, null];
  const a = (1 - conf) / 2;
  const solve = (f, target, up) => {          // f is monotone in p; find p with f(p) = target
    let l = 0, h = 1;
    for (let i = 0; i < 200; i++) { const m = (l + h) / 2; if ((f(m) > target) === up) h = m; else l = m; }
    return (l + h) / 2;
  };
  const lower = k === 0 ? 0 : solve(p => 1 - binomCdf(k - 1, n, p), a, true);
  const upper = k === n ? 1 : solve(p => binomCdf(k, n, p), a, false);
  return [lower, upper];
}

/** The DATE line, measured (display only). The first DATE line of each reply is what counts. */
function slipRate(rec) {
  const cal = calendar(rec.scenario);
  const reals = realDates(rec.realLaunchIso, rec.realEtDate);
  const replies = ((rec.records && rec.records.replies) || []).filter(r => r.turn >= 1 && typeof r.reply === 'string');
  const slips = [], corrections = [], noLine = [];
  let readable = 0;
  for (const r of replies) {
    const want = cal.turns[r.turn - 1].slice(0, 10);
    const ds = dateLines(r.reply);
    if (!ds.length) { noLine.push(r.turn); continue; }
    readable++;
    if (ds[0] !== want) slips.push({ turn: r.turn, said: ds[0], want, kind: classify(ds[0], reals), text: `DATE: ${ds[0]}` });
    if (ds.length > 1) corrections.push({ turn: r.turn, lines: ds, want });
  }
  const [lo, hi] = exactRange(slips.length, readable);
  const pct = x => (x == null ? null : +(100 * x).toFixed(1));
  return { readable, expected: cal.turns.length, slips: slips.length,
    rate_pct: readable ? pct(slips.length / readable) : null, range95_pct: [pct(lo), pct(hi)],
    slip_list: slips, later_lines_listed_not_counted: corrections, no_readable_date_line: noLine,
    note: 'Display only. Measures the model, not the harness. Never part of the verdict.' };
}

/**
 * The Trial 0c verdict. rec = { scenario, runId, records: {prompts, replies, failures}, boardNotes,
 * board_failures, refused_writes, l5: {before, after}, openGate: {ok}, replay: {match},
 * realLaunchIso, realEndIso, realEtDate, stopped }. Anything not measured counts as a failure.
 */
function grade0c(rec) {
  const sc = rec.scenario, cal = calendar(sc);
  const R = rec.records || { prompts: [], replies: [], failures: [] };
  const P = R.prompts || [], Rp = R.replies || [], F = R.failures || [];
  // The leak detectors read the calendar's times, not the records' own stamps.
  const calls = P.slice().sort((a, b) => a.turn - b.turn).map(p => {
    const r = Rp.find(x => x.turn === p.turn);
    return { label: p.turn === 0 ? 'benchmark' : `turn ${p.turn}`, sim_at: p.turn === 0 ? null : cal.turns[p.turn - 1],
      prompt: p.prompt, request: p.request, reply: r ? r.reply : null };
  });
  const f = detect(calls, sc);
  const L7 = l7(rec);
  const self = stampSelfCheck(rec);
  const changed = l5Changes(rec.l5);

  // A turn is complete once its prompt went out and a stamped record, reply or failure, was saved.
  const completed = [];
  for (let n = 1; n <= cal.turns.length; n++)
    if (P.some(p => p.turn === n) && (Rp.some(r => r.turn === n) || F.some(x => x.turn === n))) completed.push(n);
  const notRun = cal.turns.map((_, i) => i + 1).filter(n => !completed.includes(n));

  // Board failures, listed apart from clock and gate failures.
  const board = [...(rec.board_failures || [])];
  for (const r of Rp)
    if (r.turn >= 1 && typeof r.reply === 'string'
        && !(rec.boardNotes || []).some(b => b.author === sc.runner_author && b.value && b.value.turn === r.turn))
      board.push({ turn: r.turn, op: 'write', error: 'no reply note on the sim board for this reply' });

  const broke = [];
  if (f.L1b.length) broke.push('L1b: the canary was missing after its time');
  if (changed === null) broke.push('L5: isolation was not measured');
  else if (changed.length) broke.push(`L5: live or sealed records changed: ${changed.join(', ')}`);
  if (f.L6.length) broke.push('L6: a request carried a tool list');
  if (board.length) broke.push(`board: ${board.length} board read or write failure(s)`);
  if ((rec.refused_writes || []).length) broke.push(`rule 14: ${rec.refused_writes.length} write(s) to a sealed or live file refused`);
  if (!rec.openGate || !rec.openGate.ok) broke.push('open-gate check: the detector did not find both planted words');
  if (!self.ok) broke.push('open-gate check: L7 missed a shifted or missing stamp');
  if (!rec.replay || !rec.replay.match) broke.push('seed replay: the rebuilt gate reads or stamps did not match the run');

  const untested = [];
  if (completed.length < cal.turns.length) untested.push(`only ${completed.length} of ${cal.turns.length} turns completed`);
  if (F.length > MAX_FAILED_CALLS) untested.push(`${F.length} failed calls (more than ${MAX_FAILED_CALLS})`);

  const kill = [];
  if (f.L1.length) kill.push('L1: the canary reached a prompt before its time');
  if (f.L2.length) kill.push("L2: another run's note reached a prompt");
  if (f.L3.length) kill.push('L3: the canary appeared in a reply before its time');
  if (L7.length) kill.push(`L7: ${L7.length} stamp(s) missing or not what the calendar sets`);

  const verdict = broke.length ? 'WE BROKE IT' : untested.length ? 'UNTESTED' : kill.length ? 'KILL' : 'PASS';
  const reals = realDates(rec.realLaunchIso, rec.realEtDate);
  const pats = datePatterns(reals);
  const bench = Rp.find(r => r.turn === 0);
  const malformed = L7.filter(x => x.field === 'sim_at' || x.field === 'created_at' || x.field === 'turn' || x.field === 'run_id');
  return {
    verdict,
    reasons: verdict === 'WE BROKE IT' ? broke : verdict === 'UNTESTED' ? untested : verdict === 'KILL' ? kill : [],
    also: { broke, untested, kill },
    findings: { ...f, L5: changed, L7, board, refused_writes: rec.refused_writes || [], stamp_self_check: self },
    turns_completed: completed.length, expected_turns: cal.turns.length, failed_calls: F.length,
    records: {
      prompts: P.length, replies: Rp.length, failures: F.length, board_notes: (rec.boardNotes || []).length,
      turns_not_completed: notRun, malformed_or_missing: malformed,
      excluded: ['the Benchmark (turn 0): display only, never a turn, never in the slip rate'],
    },
    display_only: {
      date_line: slipRate(rec),
      year_and_real_date_hits: calls.flatMap(c => scanReply(c.label, c.reply, pats)),
      benchmark_reply: bench ? bench.reply ?? null : null,
      cut_replies: { count: Rp.filter(r => r.turn >= 1 && r.stop_reason === 'max_tokens').length,
        turns: Rp.filter(r => r.turn >= 1 && r.stop_reason === 'max_tokens').map(r => r.turn) },
    },
  };
}

module.exports = { grade, detect, openGateCheck, dateLines, hasTools, classify, l5Changes, datePatterns, scanReply,
  EXPECTED_TURNS, MAX_ABSTAINS,
  grade0c, l7, stampSelfCheck, calendar, labelOf, slipRate, exactRange, binomCdf, MAX_FAILED_CALLS };
