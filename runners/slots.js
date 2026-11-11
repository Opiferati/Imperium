'use strict';
// ══════════════════════════════════════════════════════════════════════
// runners/slots.js — THE LEGION RESOLVER (2026-11-11)
//
// The slot standard no longer lives here. Legion is its own repository now,
// and the Imperium CONSUMES it rather than containing it. That is law 3
// applied to the kernel's own housing: the Imperium may know THAT there is a
// slot standard; it must not be the place the standard is kept. A contract
// with a version number and no home of its own is a contract that cannot be
// implemented by anyone who did not write the host.
//
// This file is a LOCATOR, not an implementation. It resolves Legion the same
// way the Empire already resolves its stations — a sibling directory, named
// in the registry (C:\Cavalier, C:\Ecnalanif, C:\Ravens … and now C:\Legion).
//
// WHY THIS NEVER THROWS. warden.js loads this inside a try/catch and leaves
// `slots` null on failure, and its fail-closed path reads
// `if (slots && slots.restricted(...))`. So a throw here would mean no cards
// run AND nobody is told at priority 1 — a required card silently skipped on
// a night a signed thesis is collecting data. Instead, a missing Legion
// degrades into a LOUD EMPTY BUS: discover() returns a named failure,
// restricted() says yes, and the Warden's own alarm does the rest.
// Law 4 — removing a part degrades the machine; it never breaks it.
// ══════════════════════════════════════════════════════════════════════
const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Where Legion might be, in order of authority. First one that has the
 *  loader wins. The list is short on purpose: a resolver that searches hard
 *  is a resolver that finds the wrong copy. */
function candidates() {
  const out = [];
  if (process.env.LEGION_DIR) out.push(process.env.LEGION_DIR);
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'imperium-registry.json'), 'utf8'));
    if (reg.legion && reg.legion.dir) out.push(reg.legion.dir);
  } catch { /* no registry, or no legion block: fall through to convention */ }
  out.push(path.resolve(ROOT, '..', 'Legion'));          // the sibling convention
  // Deliberately NO hardcoded absolute fallback. The registry already names the
  // directory and the sibling convention already covers the default layout, so a
  // third guess would only ever find a copy nobody configured — and it would make
  // the not-found path impossible to test, which is how a fallback nobody has
  // exercised ends up not working on the night it is needed.
  return out;
}

function resolveLegion() {
  const tried = [];
  for (const dir of candidates()) {
    // A Windows path handed to node running under WSL, or the reverse.
    const forms = [dir];
    const win = /^([A-Za-z]):[\\/](.*)$/.exec(dir);
    if (win && process.platform !== 'win32') forms.push(`/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`);
    for (const d of forms) {
      const entry = path.join(d, 'loader', 'slots.js');
      tried.push(entry);
      if (fs.existsSync(entry)) return { entry, dir: d, tried };
    }
  }
  return { entry: null, dir: null, tried };
}

const found = resolveLegion();

if (found.entry) {
  const legion = require(found.entry);
  module.exports = Object.assign({}, legion, { LEGION_DIR: found.dir });
} else {
  // ── The loud empty bus ──
  const why = `LEGION NOT FOUND — tried: ${found.tried.join(' | ')}`;
  console.error(`[SLOTS] ${why}`);
  const failure = { name: '(legion)', reason: why };
  module.exports = {
    LEGION_DIR: null,
    CONTRACT: null,
    PINS: [],
    GRANTS: new Set(),
    STATUSES: new Set(['ok', 'thin', 'docked', 'missing', 'error']),
    discover: () => ({ cards: [], failures: [failure] }),
    order: (cards) => cards || [],
    post: () => ([
      `Slots:    0 card(s) — ${why}`,
      `          !! THE SLOT STANDARD IS NOT INSTALLED. No card can load.`,
    ]),
    // Every required card is missing, and the reason names the real cause
    // rather than blaming the cards for an absence that is not theirs.
    requiredMissing: (_found, required) =>
      (required || []).map((name) => ({ name, reason: why })),
    restricted: (_found, required) => (required || []).length > 0,
    context: () => { throw new Error(why); },
    runAll: async () => { throw new Error(why); },
    gateBoard: () => { throw new Error(why); },
    gateInfer: () => { throw new Error(why); },
    validate: () => why,
  };
}
