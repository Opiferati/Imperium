'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE ATTEMPT REGISTER — law 9 (2026-11-10)
//
// "Every variant, window and abandoned idea goes in the Attempt Register,
//  dated. Without the denominator there is no honest significance."
//
// Why this exists: a verdict of PASS at p<0.05 means something completely
// different if it was the 1st idea tried than if it was the 144th. At 144
// attempts you expect about 7 false passes from luck alone. The verdict
// does not change — the READING of it does, and only the denominator can
// tell you which reading is right.
//
// Append-only (law 14). Nothing is ever rewritten or deleted here: a
// register you can edit is a register that will eventually be edited.
// ══════════════════════════════════════════════════════════════════════

const fs   = require('node:fs');
const path = require('node:path');

const REL  = path.join('library', 'attempts.jsonl');
const KINDS = new Set(['tested_idea', 'variant', 'window', 'abandoned', 'unknown']);

function file(root) { return path.join(root, REL); }

function read(root) {
  let text = '';
  try { text = fs.readFileSync(file(root), 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); }
    catch { out.push({ id: null, broken: t.slice(0, 120) }); }
  }
  return out;
}

/** Append one attempt. Returns {recorded:true} or {recorded:false, reason}.
 *  Refuses a duplicate id rather than appending a second copy: the whole
 *  value of this file is that its count is trustworthy. */
function record(root, entry) {
  if (!entry || !entry.id) return { recorded: false, reason: 'an attempt needs an id' };
  if (!entry.what) return { recorded: false, reason: 'an attempt needs a `what`' };
  const kind = entry.kind || 'tested_idea';
  if (!KINDS.has(kind)) {
    return { recorded: false, reason: `unknown kind "${kind}" (${[...KINDS].join(', ')})` };
  }
  if (read(root).some(e => e.id === entry.id)) {
    return { recorded: false, reason: `already recorded: ${entry.id}` };
  }
  const row = { ...entry, kind, at: entry.at || new Date().toISOString() };
  fs.mkdirSync(path.dirname(file(root)), { recursive: true });
  fs.appendFileSync(file(root), JSON.stringify(row) + '\n');
  return { recorded: true, entry: row };
}

/** Bonferroni: the per-attempt threshold that keeps the FAMILY-wide false
 *  positive rate at alpha across n attempts. Conservative on purpose — the
 *  Empire would rather miss a real edge than publish a lucky one. */
function honestThreshold(n, alpha = 0.05) {
  return n > 0 ? alpha / n : alpha;
}

/** How many PASSes you would expect from luck alone at this many attempts. */
function expectedFalsePasses(n, alpha = 0.05) {
  return n * alpha;
}

/** The denominator, and the honest caveat on it. */
function summary(root, alpha = 0.05) {
  const all = read(root).filter(e => !e.broken);
  const decided = all.filter(e => e.outcome === 'PASS' || e.outcome === 'KILL');
  const unknowns = all.filter(e => e.kind === 'unknown');
  const counted = all.filter(e => e.kind !== 'unknown');
  const n = counted.length;
  return {
    total: n,
    decided: decided.length,
    passes: decided.filter(e => e.outcome === 'PASS').length,
    kills: decided.filter(e => e.outcome === 'KILL').length,
    running: counted.filter(e => e.outcome === 'RUNNING').length,
    by_station: counted.reduce((a, e) => ({ ...a, [e.station || '?']: (a[e.station || '?'] || 0) + 1 }), {}),
    honest_threshold: honestThreshold(n, alpha),
    expected_false_passes: expectedFalsePasses(n, alpha),
    // The number above is a FLOOR. Anything explored before the register
    // existed was never written down, and a register cannot count what it
    // was not told. Marked, not guessed.
    unrecorded: unknowns.map(e => ({ what: e.what, span: e.span || null })),
    is_floor: unknowns.length > 0,
  };
}

/** One line for the court. Says the denominator AND what it does to a p-value,
 *  because the number on its own invites the wrong reading. */
function summaryLine(s) {
  const bits = [`[ATTEMPTS] ${s.total} formal attempt(s) recorded`];
  if (s.decided) bits.push(`${s.decided} decided (${s.passes} PASS, ${s.kills} KILL)`);
  if (s.running) bits.push(`${s.running} running`);
  let line = bits.join(', ') + '.';
  if (s.total > 0) {
    line += ` At p<0.05 across ${s.total}, luck alone yields `
          + `${s.expected_false_passes.toFixed(2)} pass(es); an honest per-attempt bar is `
          + `p<${s.honest_threshold.toFixed(5)}.`;
  }
  if (s.is_floor) {
    line += ' FLOOR ONLY — exploration predating the register was never written down.';
  }
  return line;
}

module.exports = {
  REL, KINDS, file, read, record, summary, summaryLine,
  honestThreshold, expectedFalsePasses,
};

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const s = summary(root);
  console.log(summaryLine(s));
  if (process.argv.includes('--list')) {
    for (const e of read(root)) {
      if (e.broken) { console.log(`  !! unreadable line: ${e.broken}`); continue; }
      const tag = String(e.outcome || e.kind).padEnd(11);
      console.log(`  ${(e.dated || '?').padEnd(11)} ${tag} ${(e.station || '-')}/${e.thesis || '-'}  ${e.what}`);
    }
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(s, null, 2));
}
