'use strict';
// ══════════════════════════════════════════════════════════════════════
// LEGION SLOTS — the expansion bus (2026-11-10)
//
// A card declares itself in cards/<name>/card.json. The board finds it.
// Adding a card takes NO kernel edit: that is the whole point of a slot.
// If a card ever needs a change to warden.js to work, the slot does not
// exist and we have gone back to soldering.
//
// This module knows nothing about supervision, SQL, or what the work is.
// The Warden injects `child` so a card is supervised exactly like a
// soldered runner, and `report` so the board decides what the court hears.
// ══════════════════════════════════════════════════════════════════════

const fs   = require('node:fs');
const path = require('node:path');

const CONTRACT = 'legion/1';

// The honest statuses a card may return. Anything else is a fault, because
// a status the board cannot read is worse than an admitted error.
const STATUSES = new Set(['ok', 'thin', 'docked', 'missing', 'error']);

// The pinout. A card may ask for these and nothing else. Growing this list
// is how a slot standard rots into a god object, so each addition needs a
// written reason in "Legion - Slot Standard v1".
const PINS = ['root', 'conf', 'day', 'board', 'log', 'now'];

/** Why a manifest is refused, or null if it is sound. Refusals are reported,
 *  never thrown: one bad card must not keep the others off the bus. */
function validate(m, folder) {
  if (!m || typeof m !== 'object') return 'card.json is not an object';
  if (m.contract !== CONTRACT) {
    return `contract "${m.contract || '(none)'}" — this board speaks ${CONTRACT}`;
  }
  if (!m.name) return 'no name';
  // Lego law 7, enforced by the machine rather than by memory: the name in the
  // manifest must match the folder, so two cards can never answer to one name.
  if (m.name !== folder) return `name "${m.name}" does not match folder "${folder}"`;
  if (m.after !== undefined && !Array.isArray(m.after)) return 'after must be a list';
  if (m.needs !== undefined && !Array.isArray(m.needs)) return 'needs must be a list';
  const unknown = (m.needs || []).filter(p => !PINS.includes(p));
  if (unknown.length) return `asks for unknown pin(s): ${unknown.join(', ')}`;
  return null;
}

/** Walk cards/ and return what is on the bus and what was refused.
 *  No cards/ directory is an empty bus, not a fault — absence degrades. */
function discover(root) {
  const dir = path.join(root, 'cards');
  const cards = [], failures = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return { cards, failures }; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const slot = path.join(dir, e.name);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(slot, 'card.json'), 'utf8'));
      const bad = validate(m, e.name);
      if (bad) { failures.push({ name: e.name, reason: bad }); continue; }
      const mod = require(path.join(slot, m.entry || 'index.js'));
      if (typeof mod.run !== 'function') {
        failures.push({ name: m.name, reason: 'entry exports no run()' });
        continue;
      }
      cards.push({ name: m.name, manifest: m, mod, dir: slot });
    } catch (err) {
      failures.push({ name: e.name, reason: err.message });
    }
  }
  return { cards, failures };
}

/** Put the cards in declared order. `after` names a card that must run first;
 *  a name that is not on the bus (say "skald", a soldered runner) is a note
 *  about intent, not a blocker. Alphabetical within the constraints, so the
 *  same cards always produce the same order — provenance needs determinism.
 *  Throws on a cycle: a bus that cannot decide an order must not guess one. */
function order(cards) {
  const byName = new Map(cards.map(c => [c.name, c]));
  const state  = new Map();
  const out    = [];
  const visit = (c, trail) => {
    const s = state.get(c.name);
    if (s === 'done') return;
    if (s === 'open') {
      throw new Error(`load order cycle: ${trail.concat(c.name).join(' -> ')}`);
    }
    state.set(c.name, 'open');
    for (const dep of (c.manifest.after || [])) {
      const d = byName.get(dep);
      if (d && d !== c) visit(d, trail.concat(c.name));
    }
    state.set(c.name, 'done');
    out.push(c);
  };
  for (const c of cards) visit(c, []);
  return out;
}

/** The power-on self test. A PC lists its devices at boot; so does this one.
 *  A card that silently fails to load is the failure mode a slot standard
 *  invites, so every refusal is named out loud with its reason. */
function post(found) {
  const lines = [];
  const n = found.cards.length;
  lines.push(`Slots:    ${n} card(s)`
    + (n ? ` — ${found.cards.map(c => c.name).join(', ')}` : ' — bus empty'));
  for (const f of found.failures) {
    lines.push(`          REFUSED ${f.name}: ${f.reason}`);
  }
  return lines;
}

/** The pinout handed to a card: exactly PINS, frozen. A card that reaches past
 *  this is soldered again, and freezing makes that obvious instead of subtle. */
function context({ root, conf, day, board, log, now } = {}) {
  return Object.freeze({
    root,
    conf: conf || {},
    day,
    board: board || null,
    log: log || (() => {}),
    now: now || (() => new Date()),
  });
}

/** Run every card in order, each through the Warden's own `child` adapter so
 *  supervision, backoff and the disable latch apply exactly as they do to a
 *  soldered runner. A card's trouble is reported, never rethrown: one bad
 *  card must not take the night down. */
async function runAll(cards, { child, ctxFor, report }) {
  const results = [];
  for (const c of cards) {
    const ctx = ctxFor(c);
    if (ctx.conf.enabled === false) {
      const r = { status: 'docked', message: 'disabled in the registry' };
      report(c.name, r, `[${c.name.toUpperCase()}] Docked — ${r.message}.`);
      results.push({ name: c.name, ...r });
      continue;
    }
    const out = await child(c.name, () => c.mod.run(ctx));
    // rest_for_one: the board held this card back, so the board speaks for it.
    // A card that did not run does not get to narrate, and the REASON it was
    // held is the only useful thing here — losing it to a generic "docked"
    // would hide the one fact worth acting on.
    if (out.skipped) {
      const r = { status: 'docked', message: out.reason };
      report(c.name, r, `[${c.name.toUpperCase()}] Did not fly — ${r.message}.`);
      results.push({ name: c.name, ...r });
      continue;
    }
    let r;
    if (out.ok) r = out.value || { status: 'ok' };
    else        r = { status: 'error', message: out.error || out.reason };
    if (!r || !STATUSES.has(r.status)) {
      r = { status: 'error', message: `returned unreadable status "${r && r.status}"` };
    }
    let line;
    if (r.status === 'error') {
      line = `[${c.name.toUpperCase()}] PROBLEM: ${r.message}`;
    } else if (typeof c.mod.summaryLine === 'function') {
      try { line = c.mod.summaryLine(r); }
      catch (e) { line = `[${c.name.toUpperCase()}] ${r.status} (summaryLine threw: ${e.message})`; }
    } else {
      line = `[${c.name.toUpperCase()}] ${r.status}`;
    }
    report(c.name, r, line);
    results.push({ name: c.name, ...r });
  }
  return results;
}

module.exports = { CONTRACT, PINS, STATUSES, validate, discover, order, post, context, runAll };
