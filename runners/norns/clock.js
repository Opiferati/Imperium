'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE NORNS' CLOCK (2026-11-16, Trial 0 build; charter TRIAL_0.md).
// The ONLY Norns file allowed to read the computer's clock. Everything else asks this file,
// so a test can swap in a frozen clock and prove nothing else peeks (build list item 5).
//
// Two clocks, never mixed:
//   real  the computer's clock. Used only for money (the ledger, the $2 wall, the 6 to 8 PM ET
//         window) and to stamp log rows, because the money is real (charter rule 11).
//   sim   the Norns' pretend clock. Starts where the scenario says, only ever moves forward,
//         and is the only time the board's gate sees.
// ══════════════════════════════════════════════════════════════════════

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isoOf = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** The computer's clock, behind one door. */
const real = Object.freeze({
  nowMs: () => Date.now(),
  nowIso: () => isoOf(Date.now()),
});

/** A stopped stand-in for `real`, for tests and dry runs that must not depend on the hour. */
function frozenReal(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`norns clock: not a time: ${JSON.stringify(iso)}`);
  return Object.freeze({ nowMs: () => ms, nowIso: () => isoOf(ms) });
}

/** Date and hour in New York for a given moment (the 6 to 8 PM ET rule, and the real-date scan). */
function eastern(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/** The sim clock. Moves only forward, only when the Norns move it. */
function simClock(startIso) {
  if (!ISO_RE.test(startIso || '')) throw new Error(`norns clock: start must be YYYY-MM-DDTHH:MM:SSZ, got ${JSON.stringify(startIso)}`);
  let t = startIso;
  return Object.freeze({
    now: () => t,
    set(next) {
      if (!ISO_RE.test(next || '')) throw new Error(`norns clock: not a sim time: ${JSON.stringify(next)}`);
      if (next < t) throw new Error(`norns clock: the clock never runs backwards (${t} to ${next})`);
      t = next;
      return t;
    },
  });
}

module.exports = { real, frozenReal, eastern, simClock, isoOf, ISO_RE };
