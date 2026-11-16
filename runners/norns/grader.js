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

module.exports = { grade, detect, openGateCheck, dateLines, hasTools, classify, l5Changes, datePatterns, scanReply,
  EXPECTED_TURNS, MAX_ABSTAINS };
