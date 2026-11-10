'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE ATTEMPT REGISTER CARD (2026-11-10)
// The first card on the Legion bus doing real work.
//
// Law 9's denominator, posted to the shared floor every night. The point of
// putting it on the board rather than in a report: when a station reads a
// verdict it can read the attempt count in the same place, and a PASS at
// p<0.05 after eight attempts is a different claim than a PASS after one.
//
// A note on coupling, so it is not mistaken for an accident: this card
// requires ../../runners/attempts.js, which is the Imperium's own module.
// That is exactly limitation 1 of the slot standard — tier-1 cards share
// the process, so the pinout is a convention, not a boundary. Fine for a
// card that IS an Imperium feature; it would not be fine for a card from
// somewhere else, and the fix for that is out-of-process cards.
// ══════════════════════════════════════════════════════════════════════

const attempts = require('../../runners/attempts.js');

function run(ctx) {
  const s = attempts.summary(ctx.root);
  if (!ctx.board) {
    return { status: 'thin', message: 'no blackboard on this pin', ...s };
  }
  try {
    ctx.board.post({
      topic: 'attempts.denominator',
      value: {
        total: s.total, decided: s.decided, passes: s.passes, kills: s.kills,
        running: s.running, honest_threshold: s.honest_threshold,
        expected_false_passes: s.expected_false_passes, is_floor: s.is_floor,
      },
      source: 'attempts',
      // A floor is not a count, and the board has a field for exactly that.
      confidence: s.is_floor ? 0.6 : 1,
      if_changed: true,
    });
  } catch (e) {
    return { status: 'thin', message: `board unreachable: ${e.message}`, ...s };
  }
  ctx.log(`denominator ${s.total}${s.is_floor ? ' (floor)' : ''} on the floor`);
  return { status: 'ok', ...s };
}

function summaryLine(r) {
  const line = attempts.summaryLine(r);
  return r.status === 'ok' ? line : `${line} (not posted: ${r.message})`;
}

module.exports = { run, summaryLine };
