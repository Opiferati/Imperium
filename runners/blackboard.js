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
  reason TEXT
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

function rowOut(r) {
  if (!r) return null;
  let value = r.value;
  try { value = r.value === null ? null : JSON.parse(r.value); } catch { /* leave as text */ }
  return { ...r, value };
}

function board(root, file) {
  const db = open(root, file);

  const insert = db.prepare(
    `INSERT INTO notes (topic, author, kind, value, as_of, at, confidence, source, code, expires, supersedes, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
              source = null, code = null, expires = null, supersedes = null } = note;
      if (!topic || !TOPIC_RE.test(topic))
        throw new Error(`blackboard: topic must be dotted lowercase, got ${JSON.stringify(topic)}`);
      if (!author) throw new Error('blackboard: every note needs an author');
      if (value === undefined) throw new Error('blackboard: value is required (use null to mean "known nothing")');
      if (confidence !== null && !(confidence >= 0 && confidence <= 1))
        throw new Error('blackboard: confidence must be between 0 and 1');
      if (supersedes !== null && !getById.get(supersedes))
        throw new Error(`blackboard: cannot supersede note ${supersedes}, it does not exist`);
      const at = nowIso();
      const r = insert.run(topic, author, 'note', JSON.stringify(value ?? null), as_of, at,
                           confidence, source, code, expires, supersedes, null);
      return { id: Number(r.lastInsertRowid), at };
    },

    /** What do we currently believe about this topic? Latest live, unexpired note, or null. */
    read(topic, opts = {}) {
      return rowOut(getCurrent.get(topic, opts.now || nowIso()));
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
      return db.prepare(sql).all(...args).map(rowOut);
    },

    /** Everything ever said about a topic, oldest first — including superseded and retracted notes. */
    history(topic, opts = {}) {
      return getHistory.all(topic, opts.limit ?? 500).map(rowOut);
    },

    /** Withdraw a note. Append-only: this writes a retraction that supersedes it, and deletes nothing. */
    retract(id, { author, reason = null } = {}) {
      const target = getById.get(id);
      if (!target) throw new Error(`blackboard: no note ${id} to retract`);
      if (!author) throw new Error('blackboard: a retraction needs an author');
      const at = nowIso();
      const r = insert.run(target.topic, author, 'retraction', null, target.as_of, at,
                           null, null, null, null, id, reason);
      return { id: Number(r.lastInsertRowid), at };
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
if (require.main === module) {
  const root = process.env.IMPERIUM_DIR || '/mnt/c/Imperium';
  const bb = board(root);
  const args = process.argv.slice(2);
  const flag = args.find(a => a.startsWith('--'));
  const subject = args.find(a => !a.startsWith('--'));
  const show = n => `  ${String(n.id).padStart(4)}  ${n.at}  ${n.topic}  = ${JSON.stringify(n.value)}`
    + `${n.as_of ? `  (as of ${n.as_of})` : ''}  [${n.author}${n.kind === 'retraction' ? ', RETRACTED' : ''}]`;
  if (flag === '--history' && subject) {
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
