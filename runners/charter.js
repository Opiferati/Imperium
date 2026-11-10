'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE CHARTER LOCK (2026-11-10) — Node side, for theses that live in the
// Imperium. The stations have charter.py; this is the same contract so a
// thesis run from a card obeys laws 1 and 2 exactly as one run from Python.
//
//   Law 1  Pre-register. Nothing is built until Opie signs.
//   Law 2  Lock it. A hash of the SIGNED BODY is recorded at launch and
//          checked every run. Changes arrive only as dated amendments with
//          his initials — never edits, never deletions.
//
// The body hash deliberately EXCLUDES the signature line, so signing does
// not change the hash of what was signed. Everything above it is sealed.
// ══════════════════════════════════════════════════════════════════════

const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const SIG_MARK = '**Signed:**';

function read(root, file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

/** The sealed body: everything above the signature line. */
function body(text) {
  const i = text.indexOf(SIG_MARK);
  return i < 0 ? text : text.slice(0, i);
}

function bodyHash(text) {
  return crypto.createHash('sha256').update(body(text), 'utf8').digest('hex').slice(0, 16);
}

/** Has the Jarl actually signed? The blanks are underscores, so a signature is
 *  any non-underscore, non-space content in the Signed field. A charter that
 *  merely EXISTS is not a charter that was agreed to. */
function signed(text) {
  const line = text.split('\n').find(l => l.includes(SIG_MARK));
  if (!line) return { ok: false, why: 'no signature line in the charter' };
  const after = line.slice(line.indexOf(SIG_MARK) + SIG_MARK.length);
  const name = (after.split('**Date:**')[0] || '').replace(/[_\s]/g, '');
  if (!name) return { ok: false, why: 'the charter is unsigned' };
  const dateField = after.includes('**Date:**')
    ? after.split('**Date:**')[1].replace(/[_\s]/g, '') : '';
  if (!dateField) return { ok: false, why: `signed by ${name} but undated` };
  return { ok: true, who: name, date: dateField };
}

/** Is amendment N present AND initialed? An amendment nobody initialed is a
 *  proposal, and a proposal must not change how a run behaves. */
function amendmentInitialed(text, n) {
  const re = new RegExp(`##+\\s*AMENDMENT\\s+${n}\\b([\\s\\S]*?)(?=\\n##\\s|\\n---|$)`, 'i');
  const m = text.match(re);
  if (!m) return false;
  return /initial(s|ed)?\s*[:\-]?\s*\S/i.test(m[1]);
}

/** Everything a runner needs in one call, with the reason when it must not run. */
function check(root, file) {
  let text;
  try { text = read(root, file); }
  catch (e) { return { ok: false, why: `charter unreadable: ${e.message}` }; }
  const s = signed(text);
  if (!s.ok) return { ok: false, why: s.why, hash: bodyHash(text) };
  return { ok: true, who: s.who, date: s.date, hash: bodyHash(text), text };
}

module.exports = { SIG_MARK, read, body, bodyHash, signed, amendmentInitialed, check };
