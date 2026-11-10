'use strict';
// ══════════════════════════════════════════════════════════════════════
// DEADLINE — a bell on a child's work (2026-11-10)
//
// The supervisor catches a child that FAILS. Nothing caught a child that
// HANGS, and a hang is the worse of the two: it holds the entire night
// behind it, so a stuck scan silently costs the evidence commit, the
// backup, and every card on the bus.
//
// HONEST LIMIT — read this before trusting it. JavaScript cannot cancel
// work already in flight. This rings a bell and lets the Warden walk
// away. If the child spawned a python subprocess, THAT SUBPROCESS KEEPS
// RUNNING, orphaned. So the night continues and the overrun is reported
// and counted as a fault, but the machine is not left clean. Real
// cancellation means threading an AbortSignal down into every runner —
// a change to five runners currently mid-flight on signed theses. It is
// named here rather than hidden, and it is the next thing after this.
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_MIN = 10;

/** How long a child may take, in milliseconds. The supervision policy wins,
 *  then the station's own registry block, then the default. There is
 *  deliberately NO way to opt out: a child with no deadline is the bug this
 *  module exists to close. Registry keys use underscores, card folders use
 *  hyphens, so both spellings are tried. */
function limitMs(name, policy, registry, defaultMin = DEFAULT_MIN) {
  const reg  = registry || {};
  const conf = reg[name] || reg[String(name).replace(/-/g, '_')] || {};
  const mins = [policy && policy.timeout_min, conf.timeout_min, defaultMin]
    .find(v => Number(v) > 0);
  return Math.round(Number(mins) * 60_000);
}

function pretty(ms) {
  const mins = ms / 60_000;
  return mins >= 1 ? `${Math.round(mins * 10) / 10} min` : `${Math.round(ms / 1000)}s`;
}

/** Race the work against a bell. Rejects with a sentence a human can act on,
 *  and says plainly that the work may still be running. */
function withDeadline(work, ms, name) {
  if (!(ms > 0)) return Promise.resolve(work);
  let timer = null;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(
        `${name} ran past its ${pretty(ms)} deadline and was abandoned `
        + `(its work may still be running)`);
      e.deadline = true;
      reject(e);
    }, ms);
  });
  return Promise.race([Promise.resolve(work), bell])
    .finally(() => { if (timer) clearTimeout(timer); });
}

module.exports = { withDeadline, limitMs, pretty, DEFAULT_MIN };
