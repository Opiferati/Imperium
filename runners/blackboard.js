'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE BLACKBOARD (2026-11-09) — the Empire's shared memory. A part, not a runner.
//
// Agents pass messages on the bus; the bus is point-to-point and consumed. The Blackboard is the other
// half: anyone may POST what they learned, anyone may READ what they need, and neither has to know the
// other exists. That is what makes a hive out of a committee — a shared floor, not a conversation.
//
// LEGO CONTRACT (anything implementing these five is a drop-in replacement):
//   post(note) -> {id, at}        read(topic) -> note|null       query(filter) -> notes[]
//   history(topic) -> notes[]     retract(id, {author, reason}) -> {id}
//
// APPEND-ONLY, like everything else here. Nothing is ever UPDATEd. A correction is a new note that
// supersedes the old one; a withdrawal is a retraction note. The history of what we used to believe
// is part of the evidence.
//
// Two columns that are easy to confuse and must not be: `at` is when the note was written, `as_of` is
// the moment the fact is ABOUT. Freeze-on-first-sight lives on that distinction.
//
// Its own database file on purpose: a corrupt board must not be able to take down the message bus.
// ══════════════════════════════════════════════════════════════════════
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const TOPIC_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const BUSY_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  value TEXT,
  as_of TEXT,
  at TEXT NOT NULL,
  confidence REAL,
  source TEXT,
  code TEXT,
  expires TEXT,
  supersedes INTEGER,
  reason TEXT,
  half_life_days REAL,
  based_on TEXT
);
CREATE INDEX IF NOT EXISTS notes_topic ON notes(topic, id DESC);
CREATE INDEX IF NOT EXISTS notes_at ON notes(at);
CREATE INDEX IF NOT EXISTS notes_supersedes ON notes(supersedes);
`;

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function open(root, file) {
  const db = new DatabaseSync(file || path.join(root || '/mnt/c/Imperium', 'data', 'blackboard.db'));
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
  // WAL lets readers (stations, dashboard) run without blocking the writer. It needs shared memory,
  // which a Windows drive mounted into WSL may refuse — so it's best-effort, never fatal.
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* default journal is fine */ }
  db.exec(SCHEMA);
  return db;
}

// QUANTITATIVE STIGMERGY (Theraulaz & Bonabeau 1999): a pheromone trail fades, and a fading trail
// changes how likely an agent is to act on it. A trace that never decays is not a trace, it's a monument.
// `freshness` is 1.0 when written and halves every half_life_days. A note with no half-life never fades,
// which is right for a fact about a fixed day and wrong for a belief about the present.
function decorate(r, nowMs) {
  if (!r) return null;
  const ageH = (nowMs - Date.parse(r.at)) / 3_600_000;
  const hl = r.half_life_days;
  return { ...r, age_hours: Math.max(0, +ageH.toFixed(2)),
           freshness: hl ? +Math.pow(0.5, (ageH / 24) / hl).toFixed(4) : 1 };
}

function rowOut(r, nowMs = Date.now()) {
  if (!r) return null;
  let value = r.value;
  try { value = r.value === null ? null : JSON.parse(r.value); } catch { /* leave as text */ }
  let based_on = null;
  try { based_on = r.based_on ? JSON.parse(r.based_on) : null; } catch { /* leave as text */ }
  return decorate({ ...r, value, based_on }, nowMs);
}

function board(root, file) {
  const db = open(root, file);

  // Columns added 2026-11-10 after reading Theraulaz & Bonabeau. Old boards are migrated in place:
  // SQLite ADD COLUMN is cheap, and every existing note simply has no half-life and no citations.
  for (const col of ['half_life_days REAL', 'based_on TEXT'])
    try { db.exec(`ALTER TABLE notes ADD COLUMN ${col}`); } catch { /* already there */ }

  const insert = db.prepare(
    `INSERT INTO notes (topic, author, kind, value, as_of, at, confidence, source, code, expires, supersedes,
                        reason, half_life_days, based_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const live = `id NOT IN (SELECT supersedes FROM notes WHERE supersedes IS NOT NULL)`;
  const getCurrent = db.prepare(
    `SELECT * FROM notes WHERE topic = ? AND kind = 'note' AND ${live}
       AND (expires IS NULL OR expires > ?) ORDER BY id DESC LIMIT 1`);
  const getHistory = db.prepare(`SELECT * FROM notes WHERE topic = ? ORDER BY id ASC LIMIT ?`);
  const getById = db.prepare(`SELECT * FROM notes WHERE id = ?`);
  const getTopics = db.prepare(
    `SELECT topic, COUNT(*) n, MAX(at) latest FROM notes WHERE topic LIKE ? GROUP BY topic ORDER BY topic`);

  return {
    /** Write what you learned. Returns {id, at}. Throws on a malformed note (that's a bug, not a condition). */
    post(note = {}) {
      const { topic, author, value, as_of = null, confidence = null,
              source = null, code = null, expires = null, supersedes = null, if_changed = false,
              half_life_days = null, based_on = null } = note;
      if (!topic || !TOPIC_RE.test(topic))
        throw new Error(`blackboard: topic must be dotted lowercase, got ${JSON.stringify(topic)}`);
      if (!author) throw new Error('blackboard: every note needs an author');
      if (value === undefined) throw new Error('blackboard: value is required (use null to mean "known nothing")');
      if (confidence !== null && !(confidence >= 0 && confidence <= 1))
        throw new Error('blackboard: confidence must be between 0 and 1');
      if (supersedes !== null && !getById.get(supersedes))
        throw new Error(`blackboard: cannot supersede note ${supersedes}, it does not exist`);
      const json = JSON.stringify(value ?? null);
      // if_changed: don't write a row that says exactly what the board already says. This is NOT an
      // update — nothing is ever rewritten. It just stops a nightly re-run from burying the history of
      // real changes under thousands of identical notes. The history becomes "when the belief changed".
      // "Identical" means the value AND how to read it: a producer that changes its half-life or its
      // confidence has said something new, even about the same number.
      if (if_changed) {
        const cur = getCurrent.get(topic, nowIso());
        if (cur && cur.value === json && (cur.as_of ?? null) === as_of
            && (cur.half_life_days ?? null) === half_life_days && (cur.confidence ?? null) === confidence)
          return { id: cur.id, at: cur.at, unchanged: true };
      }
      if (based_on !== null && !Array.isArray(based_on))
        throw new Error('blackboard: based_on must be an array of note ids');
      for (const b of based_on || [])
        if (!getById.get(b)) throw new Error(`blackboard: cannot cite note ${b}, it does not exist`);
      const at = nowIso();
      const r = insert.run(topic, author, 'note', json, as_of, at, confidence, source, code, expires,
                           supersedes, null, half_life_days, based_on ? JSON.stringify(based_on) : null);
      return { id: Number(r.lastInsertRowid), at };
    },

    /** What do we currently believe about this topic? Latest live, unexpired note, or null.
     *  `min_freshness` refuses a trace that has faded too far — the reader decides how stale is too stale. */
    read(topic, opts = {}) {
      const now = opts.now || nowIso();
      const n = rowOut(getCurrent.get(topic, now), Date.parse(now));
      if (!n) return null;
      if (opts.min_freshness != null && n.freshness < opts.min_freshness) return null;
      return n;
    },

    /** Just the value, with a fallback. For callers that don't care about provenance. */
    value(topic, fallback = null) {
      const n = this.read(topic);
      return n ? n.value : fallback;
    },

    /** Browse the floor. All filters optional; `prefix` matches a whole branch, e.g. 'cavalier'. */
    query(filter = {}) {
      const where = [], args = [];
      if (filter.topic) { where.push('topic = ?'); args.push(filter.topic); }
      if (filter.prefix) { where.push('(topic = ? OR topic LIKE ?)'); args.push(filter.prefix, filter.prefix + '.%'); }
      if (filter.author) { where.push('author = ?'); args.push(filter.author); }
      if (filter.since) { where.push('at >= ?'); args.push(filter.since); }
      if (filter.until) { where.push('at <= ?'); args.push(filter.until); }
      if (filter.as_of) { where.push('as_of = ?'); args.push(filter.as_of); }
      if (!filter.includeRetractions) where.push(`kind = 'note'`);
      if (!filter.includeSuperseded) where.push(live);
      if (!filter.includeExpired) { where.push('(expires IS NULL OR expires > ?)'); args.push(filter.now || nowIso()); }
      const sql = `SELECT * FROM notes${where.length ? ' WHERE ' + where.join(' AND ') : ''}`
                + ` ORDER BY id DESC LIMIT ?`;
      args.push(filter.limit ?? 200);
      // NOT .map(rowOut): Array#map passes (element, index), and the index would land in rowOut's
      // clock argument — which read as "now = 1970" and reported every trace as infinitely fresh.
      const nowMs = Date.parse(filter.now || nowIso());
      return db.prepare(sql).all(...args).map(r => rowOut(r, nowMs));
    },

    /** Everything ever said about a topic, oldest first — including superseded and retracted notes. */
    history(topic, opts = {}) {
      const nowMs = Date.parse(opts.now || nowIso());
      return getHistory.all(topic, opts.limit ?? 500).map(r => rowOut(r, nowMs));
    },

    /** Withdraw a note. Append-only: this writes a retraction that supersedes it, and deletes nothing. */
    retract(id, { author, reason = null } = {}) {
      const target = getById.get(id);
      if (!target) throw new Error(`blackboard: no note ${id} to retract`);
      if (!author) throw new Error('blackboard: a retraction needs an author');
      const at = nowIso();
      const r = insert.run(target.topic, author, 'retraction', null, target.as_of, at,
                           null, null, null, null, id, reason, null, null);
      return { id: Number(r.lastInsertRowid), at };
    },

    /** THE PARALASTOR LESSON (Theraulaz & Bonabeau 1999, §on the wasp Paralastor): a single stray stimulus
     *  made a wasp build an entire redundant funnel — confident, competent, wasted work, because the trace
     *  it was answering was wrong. In a hive of agents, a bad note causes real downstream work, and
     *  retracting it afterwards does not un-build the funnel. So the board must at least be able to tell
     *  you WHICH work is now suspect. Walks `based_on` citations forward, transitively. */
    suspect(id, { limit = 500 } = {}) {
      const all = db.prepare(`SELECT * FROM notes WHERE based_on IS NOT NULL LIMIT ?`).all(limit).map(r => rowOut(r));
      const tainted = new Set([Number(id)]);
      let grew = true;
      while (grew) {                                  // a citation chain is short; a few passes settle it
        grew = false;
        for (const n of all)
          if (!tainted.has(n.id) && (n.based_on || []).some(b => tainted.has(Number(b)))) {
            tainted.add(n.id); grew = true;
          }
      }
      tainted.delete(Number(id));
      return all.filter(n => tainted.has(n.id)).sort((a, b) => a.id - b.id);
    },

    /** What subjects does the board know about? */
    topics(prefix) {
      return getTopics.all(prefix ? prefix + '%' : '%');
    },

    close() { db.close(); },
  };
}

module.exports = { board, TOPIC_RE };

// ── Looking at the floor by hand ──────────────────────────────────────
//   node runners/blackboard.js                     every topic, with its current value
//   node runners/blackboard.js cavalier2.exposure  one topic, in full
//   node runners/blackboard.js --branch cavalier2   a whole branch
//   node runners/blackboard.js --history skald.stock_mood   everything ever said, oldest first
//   node runners/blackboard.js --suspect 12                 what work cited note 12 and is now in doubt
if (require.main === module) {
  const root = process.env.IMPERIUM_DIR || '/mnt/c/Imperium';
  const bb = board(root);
  const args = process.argv.slice(2);
  const flag = args.find(a => a.startsWith('--'));
  const subject = args.find(a => !a.startsWith('--'));
  const fade = n => n.half_life_days ? `  fresh ${(n.freshness * 100).toFixed(0)}%` : '';
  const show = n => `  ${String(n.id).padStart(4)}  ${n.at}  ${n.topic}  = ${JSON.stringify(n.value)}`
    + `${n.as_of ? `  (as of ${n.as_of})` : ''}  [${n.author}${n.kind === 'retraction' ? ', RETRACTED' : ''}]`
    + fade(n) + (n.based_on ? `  cites ${n.based_on.join(',')}` : '');
  if (flag === '--suspect' && subject) {
    const tainted = bb.suspect(Number(subject));
    console.log(tainted.length
      ? `Work that cited note ${subject}, directly or through a chain — treat as suspect:`
      : `Nothing cited note ${subject}. No downstream work is tainted.`);
    tainted.forEach(n => console.log(show(n)));
  } else if (flag === '--history' && subject) {
    console.log(`History of ${subject}, oldest first:`);
    bb.history(subject).forEach(n => console.log(show(n)));
  } else if (flag === '--branch' && subject) {
    console.log(`Branch ${subject}:`);
    bb.query({ prefix: subject }).forEach(n => console.log(show(n)));
  } else if (subject) {
    const n = bb.read(subject);
    console.log(n ? JSON.stringify(n, null, 2) : `Nothing current on ${subject}.`);
  } else {
    const t = bb.topics();
    console.log(`The floor: ${t.length} topic(s).`);
    for (const row of t) {
      const n = bb.read(row.topic);
      console.log(`  ${row.topic.padEnd(34)} = ${n ? JSON.stringify(n.value) : '(nothing current)'}`
        + `   ${row.n} note(s), latest ${row.latest}`);
    }
  }
  bb.close();
}
