'use strict';
// ══════════════════════════════════════════════════════════════════════
// SEEDING THE ATTEMPT REGISTER from hard evidence (2026-11-10)
//
// Re-runnable: record() refuses a duplicate id, so this syncs rather than
// doubles. Reads the stations' SEALED boxes and launch files. Records
// NOTHING it cannot point at a file for.
//
// What it deliberately does NOT do: invent the pre-register exploration.
// The informal variants tried while the theses were being designed were
// never written down, and a register cannot count what it was not told.
// That absence is recorded as one honest `unknown` entry, which flips the
// summary to FLOOR ONLY. Law 5 — no mock data, ever — applies to the
// denominator exactly as it applies to a price.
// ══════════════════════════════════════════════════════════════════════

const fs   = require('node:fs');
const path = require('node:path');
const attempts = require('./attempts.js');

const ROOT = path.join(__dirname, '..');

const STATIONS = [
  { station: 'finalance', win: 'C:\\Finalance' },
  { station: 'ecnalanif', win: 'C:\\Ecnalanif' },
  { station: 'cavalier',  win: 'C:\\Cavalier'  },
];

/** The Imperium runs under WSL but the registry speaks Windows paths. */
function local(win) {
  if (process.platform === 'win32') return win;
  return '/mnt/' + win[0].toLowerCase() + win.slice(2).replace(/\\/g, '/');
}

function sealedFiles(dir) {
  const hits = [];
  for (const sub of ['', 'state']) {
    const d = sub ? path.join(dir, sub) : dir;
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (/sealed/i.test(n) && n.endsWith('.json')) hits.push(path.join(d, n));
    }
  }
  return hits;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function run() {
  const made = [], refused = [];
  const note = (r, id) => (r.recorded ? made : refused).push(r.recorded ? id : `${id}: ${r.reason}`);

  for (const { station, win } of STATIONS) {
    const dir = local(win);
    for (const f of sealedFiles(dir)) {
      const box = readJson(f);
      if (!box) { refused.push(`${f}: unreadable`); continue; }
      const rel = path.relative(dir, f).replace(/\\/g, '/');
      const dated = (box.sealed_at || box.opened_at || '').slice(0, 10) || null;
      const span = box.span || null;
      const thesis = box.thesis || null;

      // One attempt per tested idea. `verdicts` is the usual shape; `verdict`
      // is Thesis F's single-rider shape.
      const verdicts = box.verdicts && typeof box.verdicts === 'object'
        ? box.verdicts
        : (typeof box.verdict === 'string' ? { [station]: box.verdict } : null);

      if (verdicts) {
        for (const [idea, outcome] of Object.entries(verdicts)) {
          const id = `${station}:${rel}:${idea}`;
          note(attempts.record(ROOT, {
            id, station, thesis, kind: 'tested_idea',
            what: `${idea} (sealed box, ${station})`,
            outcome, dated, span, source: rel,
          }), id);
        }
      } else {
        // A sealed box whose schema carries no verdict key. Recorded as a real
        // attempt with the outcome marked unread rather than assumed.
        const id = `${station}:${rel}`;
        note(attempts.record(ROOT, {
          id, station, thesis, kind: 'tested_idea',
          what: `sealed validation (${station})`,
          outcome: 'SEALED_NO_VERDICT_KEY', dated, span, source: rel,
          note: 'this box predates the verdicts schema; outcome not asserted',
        }), id);
      }
    }

    // A launch file is hard evidence of a forward test actually running.
    for (const lf of ['state/launch.json', 'state/launch_f.json']) {
      const p = path.join(dir, lf);
      const d = readJson(p);
      if (!d) continue;
      const id = `${station}:${lf}`;
      note(attempts.record(ROOT, {
        id, station, thesis: d.thesis || null, kind: 'tested_idea',
        what: `forward test riding (${station}, ${lf})`,
        outcome: 'RUNNING', dated: d.launch_date || null, source: lf,
      }), id);
    }
  }

  // The honest hole. Not a guess at a count — a statement that a count is missing.
  const unk = 'unrecorded:pre-register-exploration';
  note(attempts.record(ROOT, {
    id: unk, station: null, thesis: null, kind: 'unknown',
    what: 'Variants, windows and abandoned ideas explored while the theses were '
        + 'being designed. Never written down at the time, so the count is unknown. '
        + 'A figure of ~144 Cavalier walk-forward variants has been spoken of but '
        + 'appears in NO file or record, so it is not entered here as fact.',
    span: ['2026-04', '2026-11-09'],
    source: 'none — this entry exists to record the absence',
  }), unk);

  console.log(`recorded ${made.length}, already present or refused ${refused.length}`);
  for (const m of made) console.log(`  + ${m}`);
  for (const r of refused) console.log(`  . ${r}`);
  console.log('');
  console.log(attempts.summaryLine(attempts.summary(ROOT)));
}

module.exports = { run, local, sealedFiles };

if (require.main === module) run();
