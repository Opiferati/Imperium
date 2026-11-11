'use strict';
// ----------------------------------------------------------------------
// THE INTERCOM (2026-11-10) - short, addressed, sealed, logged messages
// between the Empire's agents. A part, not a runner. STANDALONE: nothing
// in the Warden calls this yet, by design (INTERCOM.md, section 17).
//
// Built from INTERCOM.md, signed by Opie on 2026-11-10, body hash
// 42a848a0333f8b5f. Every rule below traces to a section of that spec.
//
//   send(msg)                 -> {ok, id, call, parts, held, stamps, draws} | {ok:false, why}
//   pending(agent)            -> part ids this agent may open now
//   open(agent, id, {task})   -> {ok, part} | {ok:false, why, bad?}
//   collect(agent, {task})    -> the agent's cut copy (opens everything pending)
//   recopy(id, agent, by)     -> a fresh sealed copy, cut by the Warden only
//   grant / release / unseal  -> the Emperor's and the Warden's levers
//   tally(day)                -> the crier's Open tallies
//   report(day)               -> the Emperor's nightly report, as data
//
// DESIGN PRINCIPLE (Opie): the agents are just trying to do their job. We do
// not try to prevent every mistake. Every mistake must be cheap, visible and
// traceable. So nothing here throws at an agent: a refusal is a logged row.
//
// APPEND-ONLY. Rows are only ever inserted. A part's state (sealed, opened,
// bad), a message's release and every stamp are EVENTS, so the history of what
// happened is the data. Its own database file, so a broken Intercom cannot
// take down the message bus or the Blackboard.
//
// Its caller is the Warden. An agent never holds this object: the Warden opens
// parts on an agent's behalf, which is the moment "opened" is recorded.
// ----------------------------------------------------------------------
const { DatabaseSync } = require('node:sqlite');
const path   = require('node:path');
const fs     = require('node:fs');
const crypto = require('node:crypto');

const SPEC_FILE = 'INTERCOM.md';
const SIG_MARK  = '**Signature:**';
const BUSY_MS   = 5000;

// Section 18, accepted at signing. Change these only by a dated amendment.
const DEFAULTS = { base: 5, reserve: 25, drawCap: 10, alarmLimit: 3, lineMax: 200, deadlineMin: 10 };

// Section 6. The whole vocabulary. Agents cannot send free sentences.
const CODES = ['ASK', 'ANSWER', 'CONFIRM', 'DISAGREE', 'NEED SOURCE', 'STALE', 'THIN',
               'BLOCKED', 'DONE', 'ALARM', 'NO DATA'];
const LINE_CODES = new Set(['ASK', 'ANSWER']);          // the only codes with a free-text line
const CITE_CODES = new Set(['CONFIRM', 'DISAGREE']);    // must cite their own source
const NEED_CODES = new Set(['NEED SOURCE', 'NO DATA']);

// Section 8. An alarm must point at one of these; it cannot declare its own.
const EMERGENCIES = ['source_failed', 'budget_breach', 'integrity_flag', 'missed_run', 'backup_failed'];

// Section 4, as signed.
const AREAS = {
  court:       ['imperial-chancellor', 'ministry-of-intelligence', 'ministry-of-works', 'ministry-of-engineering'],
  news:        ['ministry-of-skald'],
  prices:      ['ministry-of-treasury', 'cavalier', 'ecnalanif', 'ravens-league'],
  health:      ['supervisor', 'evidence', 'backup'],
  measurement: ['attempts', 'panel'],
};

const LEVELS   = ['open', 'addressed', 'sealed'];
// Section 1: only board notes, logged records or frozen evidence. Never a file an agent wrote itself.
const CITE_RE  = /^(note:\d+|log:[A-Za-z0-9._\/-]+|evidence:[A-Za-z0-9._\/-]+)$/;
const TOPIC_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const UNTIL_RE = /^[a-z0-9]+([:._-][a-z0-9]+)*$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opener TEXT NOT NULL, opened_at TEXT NOT NULL, deadline TEXT NOT NULL, asked TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER, author TEXT NOT NULL, task TEXT, at TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id INTEGER NOT NULL, call_id INTEGER, idx INTEGER NOT NULL, author TEXT NOT NULL,
  to_kind TEXT NOT NULL, to_name TEXT NOT NULL, level TEXT NOT NULL, untrusted INTEGER NOT NULL,
  code TEXT NOT NULL, line TEXT, number REAL, cite TEXT, topic TEXT, condition TEXT, verified INTEGER,
  until TEXT, origin INTEGER, seal TEXT NOT NULL, at TEXT NOT NULL, day TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, agent TEXT,
  msg_id INTEGER, part_id INTEGER, call_id INTEGER, n INTEGER, detail TEXT
);
CREATE INDEX IF NOT EXISTS parts_msg ON parts(msg_id);
CREATE INDEX IF NOT EXISTS parts_day ON parts(day);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, day);
CREATE INDEX IF NOT EXISTS events_part ON events(part_id);
`;

/** The Empire's day is the New York day, like every station's. */
function nyDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function openDb(root, file) {
  const db = new DatabaseSync(file || path.join(root || '/mnt/c/Imperium', 'data', 'intercom.db'));
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* default journal is fine */ }
  db.exec(SCHEMA);
  return db;
}

/** Law 1 and 2 for the spec itself: is INTERCOM.md signed, and what is the hash
 *  of the body that was signed? The signature line is outside the hash, so
 *  signing does not change the hash of what was signed. */
function specCheck(root, file = SPEC_FILE) {
  let text;
  try { text = fs.readFileSync(path.join(root, file), 'utf8'); }
  catch (e) { return { ok: false, why: `spec unreadable: ${e.message}` }; }
  const i = text.indexOf(SIG_MARK);
  const hash = sha(i < 0 ? text : text.slice(0, i)).slice(0, 16);
  if (i < 0) return { ok: false, why: 'no signature line in the spec', hash };
  const end = text.indexOf('\n', i);
  const line = text.slice(i + SIG_MARK.length, end < 0 ? undefined : end);
  const who = (line.split('**Date:**')[0] || '').replace(/[_\s]/g, '');
  if (!who) return { ok: false, why: 'the spec is unsigned', hash };
  const date = line.includes('**Date:**') ? line.split('**Date:**')[1].replace(/[_\s]/g, '') : '';
  if (!date) return { ok: false, why: `signed by ${who} but undated`, hash };
  return { ok: true, who, date, hash };
}

function parseTo(to) {
  if (to === 'all') return { kind: 'all', name: '' };
  if (to === 'emperor') return { kind: 'emperor', name: '' };
  const m = /^(agent|area):([a-z0-9-]+)$/.exec(String(to || ''));
  return m ? { kind: m[1], name: m[2] } : null;
}

/** The seal (section 3): a fingerprint of the content TOGETHER WITH its author,
 *  address, level and stamp, so the stamp cannot be peeled off without breaking it. */
function sealOf(p) {
  return sha(JSON.stringify([p.msg_id, p.idx, p.author, p.to_kind, p.to_name, p.level,
    p.untrusted ? 1 : 0, p.code, p.line ?? null, p.number ?? null, p.cite ?? null,
    p.topic ?? null, p.condition ?? null, p.until ?? null]));
}

/**
 * opts.now()                  -> Date (injected so tests own the clock)
 * opts.verifyAlarm(c, ctx)    -> true when the Warden's own records confirm condition c
 * opts.budgetOk()             -> false once the daily dollar budget is spent
 * opts.config, opts.areas     -> override the signed defaults (tests only)
 */
function intercom(root, file, opts = {}) {
  const cfg    = { ...DEFAULTS, ...(opts.config || {}) };
  const areas  = opts.areas || AREAS;
  const roster = new Set(Object.values(areas).flat());
  const now    = opts.now || (() => new Date());
  const verifyAlarm = opts.verifyAlarm || (() => false);   // unverified unless the Warden says so
  const budgetOk    = opts.budgetOk || (() => true);
  const db = openDb(root, file);

  const insCall = db.prepare('INSERT INTO calls (opener, opened_at, deadline, asked) VALUES (?, ?, ?, ?)');
  const insMsg  = db.prepare('INSERT INTO messages (call_id, author, task, at, day, status) VALUES (?, ?, ?, ?, ?, ?)');
  const insPart = db.prepare(`INSERT INTO parts (msg_id, call_id, idx, author, to_kind, to_name, level, untrusted,
      code, line, number, cite, topic, condition, verified, until, origin, seal, at, day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insEv   = db.prepare(`INSERT INTO events (at, day, kind, agent, msg_id, part_id, call_id, n, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getCall = db.prepare('SELECT * FROM calls WHERE id = ?');
  const getMsg  = db.prepare('SELECT * FROM messages WHERE id = ?');
  const getPart = db.prepare('SELECT * FROM parts WHERE id = ?');
  const qAnswered = db.prepare(`SELECT DISTINCT p.author FROM parts p JOIN messages m ON m.id = p.msg_id
    WHERE m.call_id = ? AND p.code = 'ANSWER'`);
  const qEvMsg    = db.prepare('SELECT 1 FROM events WHERE kind = ? AND msg_id = ? LIMIT 1');
  const qEvPart   = db.prepare('SELECT 1 FROM events WHERE kind = ? AND part_id = ? LIMIT 1');
  const qOpenedBy = db.prepare(`SELECT 1 FROM events WHERE kind = 'opened' AND part_id = ? AND agent = ? LIMIT 1`);
  const qUnsealed = db.prepare(`SELECT 1 FROM events WHERE kind = 'unsealed' AND detail = ? LIMIT 1`);
  const qExposed  = db.prepare(`SELECT 1 FROM events WHERE kind = 'exposed' AND agent = ? AND detail = ? LIMIT 1`);
  const qSumAgent = db.prepare('SELECT COALESCE(SUM(n), 0) s FROM events WHERE kind = ? AND day = ? AND agent = ?');
  const qSumAll   = db.prepare('SELECT COALESCE(SUM(n), 0) s FROM events WHERE kind = ? AND day = ?');
  const qAlarmDup = db.prepare(`SELECT 1 FROM parts WHERE author = ? AND code = 'ALARM' AND condition = ? AND day = ? LIMIT 1`);
  const qAlarmsToday = db.prepare(`SELECT COUNT(*) c FROM parts WHERE author = ? AND code = 'ALARM' AND day = ?`);
  // Forwarding (section 3): a free-text line this agent opened from somebody else, sent on as its own.
  const qOpenedLine = db.prepare(`SELECT 1 FROM events e JOIN parts p ON p.id = e.part_id
    WHERE e.kind = 'opened' AND e.agent = ? AND p.line = ? AND p.author != ? LIMIT 1`);

  function ev(kind, f = {}) {
    const at = now();
    insEv.run(at.toISOString(), nyDay(at), kind, f.agent ?? null, f.msg ?? null, f.part ?? null,
      f.call ?? null, f.n ?? null, f.detail ?? null);
  }
  /** A refusal is never silent and never an exception: it is a row Opie can read. */
  function refuse(agent, why) {
    ev('refused', { agent, detail: why });
    return { ok: false, why };
  }
  const scopeOf = (task, day) => (task ? `task:${task}` : `day:${day}`);

  /** Who may hear this part. Alarms go UP, never sideways (section 8, rule 4). */
  function recipients(p) {
    if (p.code === 'ALARM') return ['emperor', ...(areas.health || [])].filter(a => a !== p.author);
    if (p.to_kind === 'emperor') return ['emperor'];
    if (p.to_kind === 'agent') return [p.to_name];
    if (p.to_kind === 'area') return (areas[p.to_name] || []).filter(a => a !== p.author);
    return [...roster].filter(a => a !== p.author);
  }

  /** Validate one part and put it in stored shape. Returns {part} or {why}. */
  function shape(r, from, i) {
    r = r || {};
    const code = String(r.code || '').toUpperCase();
    if (!CODES.includes(code)) return { why: `unknown code ${JSON.stringify(r.code ?? null)}` };
    const p = { idx: i, author: from, code, level: r.level || 'addressed', untrusted: r.untrusted ? 1 : 0,
      to_kind: 'agent', to_name: '', line: null, number: null, cite: null, topic: null,
      condition: null, verified: null, until: null };
    if (!LEVELS.includes(p.level)) return { why: `unknown level ${JSON.stringify(p.level)}` };

    if (code === 'ALARM') {
      if (r.line) return { why: 'an ALARM carries no free text' };
      if (!EMERGENCIES.includes(r.condition))
        return { why: `an ALARM must name a listed condition, got ${JSON.stringify(r.condition ?? null)}` };
      p.condition = r.condition; p.level = 'addressed'; p.to_kind = 'alarm';
    } else if (code !== 'ANSWER') {            // an ANSWER is addressed by its call, not by its sender
      const to = parseTo(r.to);
      if (!to) return { why: `bad address ${JSON.stringify(r.to ?? null)}` };
      if (to.kind === 'agent' && !roster.has(to.name)) return { why: `unknown agent ${to.name}` };
      if (to.kind === 'area' && !areas[to.name]) return { why: `unknown area ${to.name}` };
      if (to.kind === 'agent' && to.name === from) return { why: 'a part cannot be addressed to its own author' };
      p.to_kind = to.kind; p.to_name = to.name;
    }

    if (r.line != null && r.line !== '') {
      if (!LINE_CODES.has(code)) return { why: `${code} carries no free text` };
      const line = String(r.line);
      if (/[\r\n]/.test(line)) return { why: 'the free-text line must be a single line' };
      if (line.length > cfg.lineMax) return { why: `line is ${line.length} characters, the limit is ${cfg.lineMax}` };
      p.line = line;
    } else if (code === 'ASK') return { why: 'an ASK needs its one-line question' };

    if (r.number != null) {
      if (typeof r.number !== 'number' || !Number.isFinite(r.number)) return { why: 'number must be a finite number' };
      p.number = r.number;
    }
    if (r.cite != null) {
      if (!CITE_RE.test(String(r.cite)))
        return { why: `citation ${JSON.stringify(r.cite)} must point at a board note, the log or frozen evidence` };
      p.cite = String(r.cite);
    } else if (CITE_CODES.has(code)) return { why: `${code} needs a citation to its own source` };
    if (r.topic != null) {
      if (!TOPIC_RE.test(String(r.topic))) return { why: 'topic must be dotted lowercase' };
      p.topic = String(r.topic);
    }
    if (p.level === 'sealed') {
      if (!r.until || !UNTIL_RE.test(String(r.until))) return { why: 'a sealed part must name its condition (until)' };
      p.until = String(r.until);
    }
    if (p.level === 'open' && p.to_kind !== 'area' && p.to_kind !== 'all')
      return { why: 'an Open part is addressed to an area or to all' };
    return { part: p };
  }

  const answeredBy = id => qAnswered.all(id).map(r => r.author);
  function callComplete(id) {
    const c = getCall.get(id);
    if (!c) return false;
    const got = answeredBy(id);
    return JSON.parse(c.asked).every(a => got.includes(a)) || now().toISOString() > c.deadline;
  }
  const sum = (kind, day, agent) =>
    Number(agent === undefined ? qSumAll.get(kind, day).s : qSumAgent.get(kind, day, agent).s);

  // ---------------------------------------------------------------- send
  function send(msg = {}) {
    const at = now(), day = nyDay(at), iso = at.toISOString();
    const from = msg.from;
    if (!from) return refuse(null, 'no author');
    if (!roster.has(from)) return refuse(from, `unknown sender ${from}`);
    if (!budgetOk()) return refuse(from, 'daily budget spent');
    const raw = Array.isArray(msg.parts) ? msg.parts : [];
    if (!raw.length) return refuse(from, 'a message needs at least one part');
    const task = msg.task ? String(msg.task) : null;

    // The stamp follows the reader (section 3): exposed to Untrusted this task -> everything is Untrusted.
    const taint = !!qExposed.get(from, scopeOf(task, day));
    const parts = [];
    for (const [i, r] of raw.entries()) {
      const v = shape(r, from, i);
      if (v.why) return refuse(from, `part ${i + 1}: ${v.why}`);
      if (taint) v.part.untrusted = 1;
      parts.push(v.part);
    }

    // One question, one answer, then the line closes (section 12).
    const asks = parts.filter(p => p.code === 'ASK'), answers = parts.filter(p => p.code === 'ANSWER');
    if (asks.length > 1) return refuse(from, 'one question per message');
    if (answers.length > 1) return refuse(from, 'one answer per message');
    if (asks.length && answers.length) return refuse(from, 'a message asks or answers, not both');
    let call = null, asked = null;
    if (answers.length) {
      call = msg.call != null ? getCall.get(Number(msg.call)) : null;
      if (!call) return refuse(from, 'an ANSWER must name the call it answers');
      const expected = JSON.parse(call.asked);
      if (!expected.includes(from)) return refuse(from, 'that question was not asked of this agent');
      if (answeredBy(call.id).includes(from)) return refuse(from, 'the line is closed: this call already has its answer');
      if (iso > call.deadline) {
        ev('bell', { agent: from, call: call.id, detail: 'answer arrived after the deadline' });
        return refuse(from, 'deadline passed');
      }
      const a = answers[0];
      a.to_kind = 'agent'; a.to_name = call.opener;
      // Several were asked the same thing: answers stay sealed until all are in, so nobody answers after the crowd.
      if (expected.length > 1) { a.level = 'sealed'; a.until = `call:${call.id}`; }
    }
    if (asks.length) {
      asked = recipients(asks[0]).filter(a => a !== 'emperor');
      if (!asked.length) return refuse(from, 'nobody to ask at that address');
    }

    // No forwarding, ever (section 3). If B needs what A received, B asks the Warden for a fresh copy.
    for (const p of parts)
      if (p.line && qOpenedLine.get(from, p.line, from))
        return refuse(from, `part ${p.idx + 1}: forwarding is not allowed; ask the Warden for a fresh copy`);

    // Alarms carry conditions (section 8).
    const alarms = parts.filter(p => p.code === 'ALARM');
    if (new Set(alarms.map(a => a.condition)).size < alarms.length)
      return refuse(from, 'one alarm per condition per day');
    for (const a of alarms) {
      if (qAlarmDup.get(from, a.condition, day))
        return refuse(from, `one alarm per condition per day: ${a.condition} was already raised`);
      a.verified = verifyAlarm(a.condition, { from, task }) ? 1 : 0;
    }
    let holdWhy = null;
    if (alarms.length && Number(qAlarmsToday.get(from, day).c) + alarms.length > cfg.alarmLimit)
      holdWhy = `alarm limit of ${cfg.alarmLimit} a day reached`;

    // Postage (section 7). Verified alarms and reports to the Emperor are free.
    const cost = parts.filter(p => !(p.code === 'ALARM' && p.verified) && p.to_kind !== 'emperor').length;
    let stamps = 0, draws = 0;
    if (!holdWhy) {
      const baseLeft = Math.max(0, cfg.base + sum('grant', day, from) - sum('stamp', day, from));
      stamps = Math.min(cost, baseLeft);
      const need = cost - stamps;
      if (need > 0) {
        const poolLeft = cfg.reserve + sum('grant', day, 'reserve') - sum('draw', day);
        const capLeft  = cfg.drawCap - sum('draw', day, from);
        if (need <= poolLeft && need <= capLeft) draws = need;
        else { holdWhy = need > capLeft ? `draw cap of ${cfg.drawCap} a day reached` : 'the reserve is empty'; stamps = 0; }
      }
    }

    // Log first. Delivery only ever reads what is written here, so an unlogged message cannot be delivered.
    db.exec('BEGIN');
    try {
      let callId = call ? call.id : null;
      if (asks.length) {
        const mins = Number(msg.deadlineMin) > 0 ? Number(msg.deadlineMin) : cfg.deadlineMin;
        callId = Number(insCall.run(from, iso, new Date(at.getTime() + mins * 60000).toISOString(),
          JSON.stringify(asked)).lastInsertRowid);
      }
      const msgId = Number(insMsg.run(callId, from, task, iso, day, holdWhy ? 'held' : 'sent').lastInsertRowid);
      const ids = [];
      for (const p of parts) {
        p.msg_id = msgId;
        ids.push(Number(insPart.run(msgId, callId, p.idx, p.author, p.to_kind, p.to_name, p.level, p.untrusted,
          p.code, p.line, p.number, p.cite, p.topic, p.condition, p.verified, p.until, null, sealOf(p), iso, day
        ).lastInsertRowid));
      }
      ev('logged', { agent: from, msg: msgId, call: callId, n: parts.length });
      if (stamps) ev('stamp', { agent: from, msg: msgId, n: stamps });
      if (draws)  ev('draw',  { agent: from, msg: msgId, n: draws });
      for (const a of alarms)
        ev('alarm', { agent: from, msg: msgId, detail: JSON.stringify({ condition: a.condition, verified: !!a.verified }) });
      if (holdWhy) {
        ev('held', { agent: from, msg: msgId, detail: holdWhy });
        ev('tell', { agent: from, msg: msgId,
          detail: `Message ${msgId} from ${from} is held: ${holdWhy}. Grant stamps or release it.` });
      }
      db.exec('COMMIT');
      return { ok: true, id: msgId, call: callId, parts: ids, held: !!holdWhy, why: holdWhy || undefined, stamps, draws };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // ------------------------------------------------------------ delivery
  const released = msgId => !!qEvMsg.get('released', msgId);
  const isBad    = partId => !!qEvPart.get('bad', partId);

  function deliverable(p) {
    const m = getMsg.get(p.msg_id);
    if (!m || (m.status === 'held' && !released(m.id))) return false;
    if (p.level === 'open') return false;                 // Open is heard as a tally only, never raw
    if (p.level === 'sealed') {
      const c = /^call:(\d+)$/.exec(p.until || '');
      return c ? callComplete(Number(c[1])) : !!qUnsealed.get(p.until);
    }
    return true;
  }

  /** What the recipient sees. Nothing here says whether anything else existed (silent withholding). */
  function view(p) {
    const v = { id: p.id, call: p.call_id, from: p.author, code: p.code, line: p.line, number: p.number,
      cite: p.cite, topic: p.topic, untrusted: !!p.untrusted, instruction: false };
    if (p.code === 'ALARM') { v.condition = p.condition; v.verified = !!p.verified; }
    return v;
  }

  function open(agent, partId, ctx = {}) {
    const p = getPart.get(Number(partId));
    if (!p) return refuse(agent, `no part ${partId}`);
    const bad = why => {
      ev('bad', { agent, part: p.id, msg: p.msg_id, detail: why });
      ev('tell', { agent, part: p.id, msg: p.msg_id, detail: `Seal on part ${p.id} is BAD: ${why} (${agent}).` });
      return { ok: false, why: `bad seal: ${why}`, bad: true };
    };
    if (isBad(p.id)) return refuse(agent, `part ${p.id} is marked Bad`);
    if (sealOf(p) !== p.seal) return bad('fingerprint does not match');
    if (!recipients(p).includes(agent)) return bad('opened by the wrong party');
    if (!deliverable(p)) return refuse(agent, `part ${p.id} is not deliverable yet`);
    if (qOpenedBy.get(p.id, agent)) return bad('seen again after opening');
    const scope = scopeOf(ctx.task ? String(ctx.task) : null, nyDay(now()));
    ev('opened', { agent, part: p.id, msg: p.msg_id, call: p.call_id, detail: scope });
    if (p.untrusted) ev('exposed', { agent, part: p.id, detail: scope });
    return { ok: true, part: view(p) };
  }

  function pending(agent) {
    return db.prepare(`SELECT * FROM parts WHERE level != 'open'
        AND id NOT IN (SELECT part_id FROM events WHERE kind = 'opened' AND agent = ? AND part_id IS NOT NULL)
        AND id NOT IN (SELECT part_id FROM events WHERE kind = 'bad' AND part_id IS NOT NULL)
        ORDER BY id`).all(agent)
      .filter(p => recipients(p).includes(agent) && deliverable(p))
      .map(p => p.id);
  }

  /** The agent's cut copy: only its parts, with no count of anything withheld. */
  function collect(agent, ctx = {}) {
    return pending(agent).map(id => open(agent, id, ctx)).filter(r => r.ok).map(r => r.part);
  }

  // ---------------------------------------------- the Warden's and Emperor's levers
  /** A fresh sealed copy cut from the original in the log. Only the Warden or the Emperor cuts copies. */
  function recopy(partId, toAgent, by) {
    if (by !== 'warden' && by !== 'emperor') return refuse(by || null, 'only the Warden cuts fresh copies');
    const o = getPart.get(Number(partId));
    if (!o) return refuse(by, `no part ${partId}`);
    if (o.code === 'ALARM') return refuse(by, 'alarms are not recopied');
    if (toAgent !== 'emperor' && !roster.has(toAgent)) return refuse(by, `unknown agent ${toAgent}`);
    const at = now(), iso = at.toISOString(), day = nyDay(at);
    const msgId = Number(insMsg.run(null, o.author, null, iso, day, 'sent').lastInsertRowid);
    const p = { ...o, msg_id: msgId, idx: 0, to_kind: toAgent === 'emperor' ? 'emperor' : 'agent',
      to_name: toAgent === 'emperor' ? '' : toAgent, level: 'addressed', until: null };
    const id = Number(insPart.run(msgId, null, 0, p.author, p.to_kind, p.to_name, p.level, p.untrusted, p.code,
      p.line, p.number, p.cite, p.topic, p.condition, p.verified, null, o.id, sealOf(p), iso, day).lastInsertRowid);
    ev('logged', { agent: by, msg: msgId, n: 1 });
    ev('recopy', { agent: by, part: id, msg: msgId, detail: `fresh copy of part ${o.id} for ${toAgent}` });
    return { ok: true, part: id };
  }

  /** Emperor's grant (section 7): more stamps for one agent, or for the reserve, today. */
  function grant(target, n, by) {
    if (by !== 'emperor') return refuse(by || null, 'only the Emperor grants stamps');
    if (target !== 'reserve' && !roster.has(target)) return refuse(by, `unknown agent ${target}`);
    if (!Number.isInteger(n) || n <= 0) return refuse(by, 'a grant is a whole number of stamps');
    ev('grant', { agent: target, n, detail: `granted by ${by}` });
    return { ok: true };
  }

  /** Let a held message go. The message was never lost; this is the Emperor saying yes. */
  function release(msgId, by) {
    if (by !== 'emperor') return refuse(by || null, 'only the Emperor releases a held message');
    const m = getMsg.get(Number(msgId));
    if (!m) return refuse(by, `no message ${msgId}`);
    if (m.status !== 'held') return refuse(by, `message ${msgId} is not held`);
    if (!released(m.id)) ev('released', { agent: by, msg: m.id });
    return { ok: true };
  }

  /** Meet the stated condition of Sealed-until parts (a verdict's one look, for instance). */
  function unseal(key, by) {
    if (by !== 'warden' && by !== 'emperor') return refuse(by || null, 'only the Warden or the Emperor unseals');
    if (!UNTIL_RE.test(String(key || ''))) return refuse(by, 'bad seal condition');
    if (!qUnsealed.get(String(key))) ev('unsealed', { agent: by, detail: String(key) });
    return { ok: true };
  }

  // ------------------------------------------------- the collective voice
  /** Open tallies: no names, no arguments. One voice per agent per question; the last word counts. */
  function tally(day = nyDay(now())) {
    const rows = db.prepare(`SELECT p.* FROM parts p JOIN messages m ON m.id = p.msg_id
      WHERE p.day = ? AND p.level = 'open'
        AND (m.status = 'sent' OR EXISTS (SELECT 1 FROM events e WHERE e.kind = 'released' AND e.msg_id = m.id))
      ORDER BY p.id`).all(day);
    const groups = new Map();
    for (const p of rows) {
      const scope = p.to_kind === 'area' ? `area ${p.to_name}` : 'the Empire';
      const key = `${scope}|${p.topic || ''}`;
      if (!groups.has(key)) groups.set(key, { scope, topic: p.topic,
        of: p.to_kind === 'area' ? areas[p.to_name].length : roster.size, voices: new Map() });
      groups.get(key).voices.set(p.author, p.code);
    }
    const out = [];
    for (const g of groups.values()) {
      const counts = new Map();
      for (const code of g.voices.values()) counts.set(code, (counts.get(code) || 0) + 1);
      for (const [code, n] of counts)
        out.push({ scope: g.scope, topic: g.topic, code, voices: n, of: g.of,
          text: `${n} of ${g.of} in ${g.scope} flagged ${code}${g.topic ? ` on ${g.topic}` : ''}` });
    }
    return out;
  }

  // --------------------------------------------- the Emperor's report (data)
  function report(day = nyDay(now())) {
    const dayParts = db.prepare('SELECT * FROM parts WHERE day = ? ORDER BY id').all(day);
    const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

    // Parts cut from whom (Emperor's eyes only; the agents never see this).
    const cuts = {};
    const byMsg = new Map();
    for (const p of dayParts) if (p.level !== 'open') (byMsg.get(p.msg_id) || byMsg.set(p.msg_id, []).get(p.msg_id)).push(p);
    for (const ps of byMsg.values()) {
      const all = new Set(ps.flatMap(p => recipients(p)).filter(a => a !== 'emperor'));
      for (const a of all) {
        const cut = ps.filter(p => !recipients(p).includes(a)).length;
        if (cut) bump(cuts, a, cut);
      }
    }

    // The stovepipe alarm: someone asked for a thing that had in fact been sent to somebody else.
    const stovepipe = [];
    for (const n of dayParts.filter(p => NEED_CODES.has(p.code) && p.topic))
      for (const o of dayParts.filter(p => p.topic === n.topic && p.author !== n.author
          && !NEED_CODES.has(p.code) && p.level !== 'open' && !recipients(p).includes(n.author)))
        stovepipe.push({ agent: n.author, topic: n.topic, held_by: o.author, sent_to: recipients(o) });

    const evs = kind => db.prepare('SELECT * FROM events WHERE kind = ? AND day = ? ORDER BY id').all(kind, day);
    const draws = {};
    for (const e of evs('draw')) bump(draws, e.agent, e.n);
    const alarms = {};
    for (const p of dayParts.filter(p => p.code === 'ALARM')) {
      alarms[p.author] = alarms[p.author] || { verified: 0, unverified: 0 };
      alarms[p.author][p.verified ? 'verified' : 'unverified']++;
    }

    // Watched, not blocked (the 30-day observation period): counts only.
    const asks = {}, needs = {};
    for (const p of dayParts) {
      if (p.code === 'ASK') bump(asks, p.author);
      if (NEED_CODES.has(p.code)) bump(needs, p.author);
    }
    const confirms = dayParts.filter(p => p.code === 'CONFIRM' && p.to_kind === 'agent');
    const mutual = [];
    for (const c of confirms)
      if (c.author < c.to_name && confirms.some(d => d.author === c.to_name && d.to_name === c.author))
        mutual.push([c.author, c.to_name]);
    const refusals = evs('refused');

    return {
      day, cuts, stovepipe, draws,
      reserve_left: cfg.reserve + sum('grant', day, 'reserve') - sum('draw', day),
      alarms,
      held: evs('held').map(e => ({ msg: e.msg_id, agent: e.agent, why: e.detail })),
      bad: evs('bad').map(e => ({ part: e.part_id, agent: e.agent, why: e.detail })),
      watch: { asks, need_source: needs, mutual_confirms: mutual,
        refused_citations: refusals.filter(e => /citation/.test(e.detail || '')).length,
        refused_forwarding: refusals.filter(e => /forwarding/.test(e.detail || '')).length },
      refused: refusals.length,
      tells: evs('tell').map(e => e.detail),
    };
  }

  function events(kind) {
    return kind ? db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind)
                : db.prepare('SELECT * FROM events ORDER BY id').all();
  }

  return { send, open, pending, collect, recopy, grant, release, unseal, tally, report, events,
    config: cfg, close: () => db.close(), _db: db };
}

module.exports = { intercom, specCheck, sealOf, nyDay,
  DEFAULTS, CODES, EMERGENCIES, AREAS, SPEC_FILE, SIG_MARK };

// `node runners/intercom.js spec` - is the spec signed, and what is its hash?
if (require.main === module) {
  const root = path.join(__dirname, '..');
  const s = specCheck(root);
  console.log(s.ok ? `INTERCOM.md signed by ${s.who} on ${s.date}, body hash ${s.hash}`
                   : `INTERCOM.md NOT usable: ${s.why}${s.hash ? ` (body hash ${s.hash})` : ''}`);
  process.exit(s.ok ? 0 : 1);
}
