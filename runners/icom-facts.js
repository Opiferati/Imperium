'use strict';
// ----------------------------------------------------------------------
// INTERCOM FACTS (2026-11-11) - what this machine can actually PROVE.
//
// Amendment 1 section 8 item 8: an alarm's conditions must be verifiable or the word
// "verified" is a fiction. And section 2: the unheard report must tell a sleeping agent
// from an ignoring one, which needs to know who ran.
//
// This lives in its own module because TWO things need the same answers: the Warden,
// live during a night, and the Intercom Watch card, reading the night afterwards. Two
// copies of this logic would drift, and the first symptom would be the Emperor reading
// two different numbers for the same night - which is worse than reading none.
//
// Read-only, every source opened and closed per call. Cannot prove it -> false for an
// alarm, undefined for a run. Never "probably".
// ----------------------------------------------------------------------
const fs   = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// The stations that keep a state file with scan counts in it.
const STATIONS = [
  { name: 'cavalier',  file: 'Cavalier/state/state.json' },
  { name: 'cavalier2', file: 'Cavalier/state/state_f.json' },
  { name: 'ecnalanif', file: 'Ecnalanif/state/state.json' },
];
// The agents the Warden dispatches to with a model call; "did it run" is a bus question for these.
const AI_AGENTS = new Set(['imperial-chancellor', 'ministry-of-intelligence',
  'ministry-of-works', 'ministry-of-engineering', 'ministry-of-skald', 'ministry-of-treasury']);

function readRo(file, fn, fallback) {
  if (!fs.existsSync(file)) return fallback;
  let db;
  try {
    db = new DatabaseSync(`file:${file}?mode=ro`);
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } catch { return fallback; }
  finally { try { if (db) db.close(); } catch { /* already gone */ } }
}

/** The New York day of an instant, the same day every station counts by. */
function nyDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function makeFacts(root, registry = {}) {
  const R = root || '/mnt/c/Imperium';
  const ledger = path.join(R, 'data', 'imperial-ledger.db');
  const bus    = path.join(R, 'data', 'message_bus.db');
  const board  = path.join(R, 'data', 'blackboard.db');
  const limit  = ((registry.budget || {}).daily_limit_usd);
  const warnPct = ((registry.budget || {}).warn_at_pct);

  const states = () => {
    const out = [];
    for (const s of STATIONS) {
      try { out.push({ ...s, j: JSON.parse(fs.readFileSync(path.join(R, '..', s.file), 'utf8')) }); }
      catch { /* a station that is not there cannot report, and silence is not a breach */ }
    }
    return out;
  };

  const spentToday = () => readRo(ledger, db => Number(db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) t FROM api_calls WHERE date(called_at) = date('now')`).get().t), null);

  /** A supervisor health note, as the supervisor itself wrote it to the floor. */
  const health = name => readRo(board, db => {
    const r = db.prepare(`SELECT value FROM notes WHERE topic = ? AND kind = 'note'
      ORDER BY id DESC LIMIT 1`).get(`supervisor.${name}.health`);
    return r ? JSON.parse(r.value) : null;
  }, null);

  function verifyAlarm(condition) {
    try {
      switch (condition) {
        case 'budget_breach': {
          const spent = spentToday();
          if (spent === null || !(limit > 0)) return false;
          return spent >= limit * ((warnPct ?? 80) / 100);
        }
        case 'source_failed':
          // a station's own warnings list: "FRED unreachable", "T3 abstains", and the like
          return states().some(s => Array.isArray(s.j.warnings) && s.j.warnings.length > 0);
        case 'missed_run':
          return states().some(s => Number(s.j.missed_scans || 0) > 0);
        case 'integrity_flag':
          // the charters' own rule: more than 10% of the scheduled scans missing
          return states().some(s => {
            const missed = Number(s.j.missed_scans || 0);
            const sched  = Number(s.j.scheduled_scans || s.j.scans || 0) + missed;
            return sched > 0 && missed / sched > 0.10;
          });
        case 'backup_failed': {
          const h = health('backup');
          return !!h && h.state !== 'ok';
        }
        default: return false;        // an invented condition buys nothing
      }
    } catch { return false; }
  }

  /** true, false, or undefined for "I cannot tell" - which the report prints as such. */
  function ranToday(agent, day) {
    try {
      if (AI_AGENTS.has(agent)) {
        const t = readRo(bus, db => (db.prepare(
          `SELECT MAX(created_at) t FROM messages WHERE to_agent = ? AND status = 'delivered'`
        ).get(agent) || {}).t, undefined);
        if (t === undefined) return undefined;
        if (!t) return false;
        return nyDay(new Date(String(t).replace(' ', 'T') + 'Z')) === day;
      }
      const h = health(agent);
      if (!h || !h.last_ok) return undefined;
      return nyDay(new Date(h.last_ok)) === day;
    } catch { return undefined; }
  }

  function budgetOk() {
    const spent = spentToday();
    if (spent === null || !(limit > 0)) return true;   // cannot read the purse: do not block the mail
    return spent < limit;
  }

  return { verifyAlarm, ranToday, budgetOk, spentToday, health, states, nyDay };
}

module.exports = { makeFacts, nyDay, STATIONS, AI_AGENTS };
