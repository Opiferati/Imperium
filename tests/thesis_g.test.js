'use strict';
// THESIS_G — the charter lock, the Forge, and the panel card.
// The load-bearing tests: an unsigned charter does not run, a changed charter
// stops the run, a partial observation is never written, and the nightly line
// cannot leak the answer early.

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const charter = require('../runners/charter.js');
const { makeForge } = require('../runners/forge.js');
const panel = require('../cards/panel/index.js');

const IMPERIUM = path.join(__dirname, '..');
let seq = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), `thesisg-${process.pid}-${seq++}-`));

const BODY = '# THESIS_X\n\nThe claim is a claim.\n\n## Signature\n\n';
const sigLine = (who, when) => `**Signed:** __${who}____  **Date:** __${when}____\n`;

function charterAt(root, who, when) {
  fs.writeFileSync(path.join(root, 'THESIS_X.md'),
    BODY + (who ? sigLine(who, when) : '**Signed:** _______  **Date:** _______\n'));
  return root;
}

// ── The charter lock (laws 1 and 2) ──────────────────────────────────────

test('an unsigned charter is reported unsigned, not quietly run', () => {
  const r = charter.check(charterAt(tmp(), null), 'THESIS_X.md');
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /unsigned/);
});

test('a signature without a date is not a signature', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'THESIS_X.md'), BODY + '**Signed:** __Opie__  **Date:** ____\n');
  const r = charter.check(root, 'THESIS_X.md');
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /undated/);
});

test('a signed charter yields who and when', () => {
  const r = charter.check(charterAt(tmp(), 'Opie', '11/10/2026'), 'THESIS_X.md');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.who, 'Opie');
  assert.strictEqual(r.date, '11/10/2026');
});

test('signing does NOT change the hash of what was signed', () => {
  // Otherwise the lock would be useless: you could never check a signed body
  // against the body that was agreed to.
  const unsignedHash = charter.bodyHash(BODY + '**Signed:** ____  **Date:** ____\n');
  const signedHash   = charter.bodyHash(BODY + sigLine('Opie', '11/10/2026'));
  assert.strictEqual(unsignedHash, signedHash);
});

test('changing one word of the body changes the hash', () => {
  const a = charter.bodyHash(BODY + sigLine('Opie', '11/10/2026'));
  const b = charter.bodyHash(BODY.replace('a claim', 'a different claim') + sigLine('Opie', '11/10/2026'));
  assert.notStrictEqual(a, b);
});

test('an amendment nobody initialed is a proposal, not an amendment', () => {
  const bare = BODY + '## AMENDMENT 1\n\nChange the window.\n';
  const done = BODY + '## AMENDMENT 1\n\nChange the window. Initials: CM\n';
  assert.strictEqual(charter.amendmentInitialed(bare, 1), false);
  assert.strictEqual(charter.amendmentInitialed(done, 1), true);
  assert.strictEqual(charter.amendmentInitialed(done, 2), false);
});

test('THESIS_G itself is signed, and that is why the card may run', () => {
  const r = charter.check(IMPERIUM, 'THESIS_G.md');
  assert.strictEqual(r.ok, true, r.why);
  assert.ok(r.who.length > 0);
  assert.ok(/^[0-9a-f]{16}$/.test(r.hash), 'the body hash is recorded at launch');
});

// ── The Forge (one owner of model calls) ─────────────────────────────────

function fakeForge(opts = {}) {
  const logged = [];
  const f = makeForge({
    call: async (model) => ({ content: [{ type: 'text', text: `{"mood": 55} (${model})` }],
                              usage: { input_tokens: 400, output_tokens: 10 },
                              stop_reason: 'end_turn' }),
    estimateCost: () => 0.001,
    logCall: (c) => logged.push(c),
    spentToday: opts.spentToday || (() => 0),
    limit: opts.limit === undefined ? 2 : opts.limit,
    models: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' },
    reserve_usd: opts.reserve_usd,
    max_calls: opts.max_calls,
  });
  return { f, logged };
}

test('the Forge resolves a short model name to the real one', async () => {
  const { f, logged } = fakeForge();
  const r = await f.infer({ model: 'opus', messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(r.model, 'claude-opus-5-5');
  assert.strictEqual(logged[0].model, 'claude-opus-5-5');
  assert.strictEqual(r.input_tokens, 400);
});

test('the Forge meters what it spends', async () => {
  const { f } = fakeForge();
  for (let i = 0; i < 3; i++) await f.infer({ model: 'haiku', messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(f.calls(), 3);
  assert.ok(Math.abs(f.spent() - 0.003) < 1e-9);
});

test('the Forge ABSTAINS rather than breaching the budget', async () => {
  const { f } = fakeForge({ spentToday: () => 1.9, limit: 2, reserve_usd: 0.25 });
  await assert.rejects(
    () => f.infer({ model: 'haiku', messages: [{ role: 'user', content: 'x' }] }),
    (e) => e.budget === true && /headroom/.test(e.message),
  );
  assert.strictEqual(f.calls(), 0, 'and it refuses BEFORE calling, not after');
});

test('the Forge caps a runaway loop', async () => {
  const { f } = fakeForge({ max_calls: 2 });
  await f.infer({ model: 'haiku', messages: [{ role: 'user', content: 'x' }] });
  await f.infer({ model: 'haiku', messages: [{ role: 'user', content: 'x' }] });
  await assert.rejects(
    () => f.infer({ model: 'haiku', messages: [{ role: 'user', content: 'x' }] }),
    (e) => e.budget === true && /2 calls already made/.test(e.message),
  );
});

test('the Forge refuses a call with no model or no messages', async () => {
  const { f } = fakeForge();
  await assert.rejects(() => f.infer({ messages: [{ role: 'user', content: 'x' }] }), /no model/);
  await assert.rejects(() => f.infer({ model: 'haiku', messages: [] }), /no messages/);
});

// ── The panel card's arithmetic ──────────────────────────────────────────

test('a score is read from JSON, from a bare number, or abstained on', () => {
  assert.strictEqual(panel.parseMood('{"mood": 61}'), 61);
  assert.strictEqual(panel.parseMood('mood: 7'), 7);
  assert.strictEqual(panel.parseMood('  42  '), 42);
  assert.strictEqual(panel.parseMood('{"mood": 140}'), null, 'out of range abstains');
  assert.strictEqual(panel.parseMood('I would rather not say'), null);
  assert.strictEqual(panel.parseMood(''), null);
  assert.strictEqual(panel.parseMood(null), null);
});

test('the dispersion statistic is the sample standard deviation', () => {
  assert.strictEqual(panel.sd([50, 50, 50]), 0);
  assert.ok(Math.abs(panel.sd([40, 50, 60]) - 10) < 1e-12);
  assert.strictEqual(panel.sd([50]), null, 'one number has no spread');
});

test('mean pairwise absolute disagreement is non-degenerate with three members', () => {
  // The statistic the charter discarded (correlation of deviations from the panel
  // mean) is forced to -0.5 for k=3. This one is not, which is why it survived.
  assert.strictEqual(panel.meanPairAbs([50, 50, 50]), 0);
  assert.ok(Math.abs(panel.meanPairAbs([40, 50, 60]) - (10 + 20 + 10) / 3) < 1e-12);
});

test('the Jester is seeded, in range, and identical on every re-run', () => {
  const a = panel.jesterScores('2026-11-10', 'stock');
  const b = panel.jesterScores('2026-11-10', 'stock');
  assert.deepStrictEqual(a, b, 'a control that moves between runs is not a control');
  assert.notDeepStrictEqual(a, panel.jesterScores('2026-11-10', 'crypto'));
  for (const v of a) { assert.ok(v >= 20 && v <= 80); }
});

test('every rider is asked in exactly the same words', () => {
  const d = [{ event: 'a thing happened', effect: 'fear' }];
  assert.deepStrictEqual(panel.promptFor(d), panel.promptFor(d));
  assert.match(panel.promptFor(d)[0].content, /a thing happened/);
  assert.match(panel.promptFor(d)[0].content, /\[fear\]/);
});

// ── The card, end to end, with a fake Forge (no real API calls) ──────────

const ARCH = (d, quality) => JSON.stringify({
  date: d, model: 'claude-haiku-5-5', quality: quality || 'pass',
  reading: {
    stock_mood: 60, crypto_mood: 27,
    stock_drivers:  [{ event: 'stocks did a thing', effect: 'greed' }],
    crypto_drivers: [{ event: 'crypto did a thing', effect: 'fear' }],
  },
});

function stage(opts = {}) {
  const root = tmp();
  const dir = path.join(root, 'data', 'skald-archive');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'THESIS_G.md'),
    BODY + (opts.unsigned ? '**Signed:** ____  **Date:** ____\n' : sigLine('Opie', '11/10/2026')));
  const day = opts.day || '2026-11-10';
  fs.writeFileSync(path.join(dir, `${day}.json`), ARCH(day, opts.quality));
  for (const d of (opts.earlier || [])) fs.writeFileSync(path.join(dir, `${d}.json`), ARCH(d));
  return { root, day };
}

const IDS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

/** Different tiers answer differently; repeated calls to one tier drift a little.
 *  That is the shape the thesis is looking for, so the fake produces it. */
function fakeInfer(behaviour = {}) {
  const base = { haiku: 50, sonnet: 56, opus: 66 };
  const seen = {};
  return async ({ model }) => {
    seen[model] = (seen[model] || 0) + 1;
    if (behaviour.budgetAfter && Object.values(seen).reduce((a, b) => a + b, 0) > behaviour.budgetAfter) {
      const e = new Error('forge: $1.9000 spent of $2 and a call needs $0.25 of headroom');
      e.budget = true;
      throw e;
    }
    const text = behaviour.garbage ? 'no thanks' : `{"mood": ${base[model] + (seen[model] - 1)}}`;
    return { text, model: IDS[model] || model, input_tokens: 400, output_tokens: 8, cost_usd: 0.001 };
  };
}

function ctxFor(root, day, infer) {
  const posted = [], logs = [];
  const ctx = {
    root, day, conf: {}, infer,
    log: (m) => logs.push(m),
    now: () => new Date('2026-11-10T23:00:00Z'),
    board: { post: (n) => posted.push(n) },
  };
  return { ctx, posted, logs };
}

const ledgerOf = (root) => fs.readFileSync(path.join(root, 'library', 'thesis_g.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse);

test('an unsigned charter docks the card — law 1, nothing runs', async () => {
  const { root, day } = stage({ unsigned: true });
  const { ctx } = ctxFor(root, day, fakeInfer());
  const r = await panel.run(ctx);
  assert.strictEqual(r.status, 'docked');
  assert.match(r.message, /unsigned/);
  assert.ok(!fs.existsSync(path.join(root, 'library', 'thesis_g.jsonl')), 'and writes nothing');
});

test('a good night freezes both stimuli and locks the charter hash', async () => {
  const { root, day } = stage();
  const { ctx, posted, logs } = ctxFor(root, day, fakeInfer());
  const r = await panel.run(ctx);
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(r.froze, ['stock', 'crypto']);
  assert.strictEqual(r.observations, 2);
  assert.strictEqual(r.launched, true);
  assert.match(logs.join(' '), /launched/);

  const lock = JSON.parse(fs.readFileSync(path.join(root, 'state', 'thesis_g_launch.json'), 'utf8'));
  assert.ok(/^[0-9a-f]{16}$/.test(lock.charter_hash));
  assert.strictEqual(lock.launch_date, day);

  const rows = ledgerOf(root).filter(x => x.kind === 'observation');
  assert.strictEqual(rows.length, 2);
  const o = rows[0];
  assert.strictEqual(o.panel.scores.length, 3);
  assert.strictEqual(o.benchmark.scores.length, 3);
  assert.strictEqual(o.jester.scores.length, 3);
  assert.ok(o.panel.sd > o.benchmark.sd, 'three tiers spread wider than one tier resampled');
  assert.ok(Math.abs(o.delta - (o.panel.sd - o.benchmark.sd)) < 1e-12);
  assert.strictEqual(o.charter_hash, lock.charter_hash, 'every row carries the charter it ran under');
  assert.strictEqual(o.squire, null);
  assert.match(o.squire_why, /no earlier archive/);

  assert.strictEqual(posted[0].topic, 'thesis_g.progress');
  assert.strictEqual(posted[0].value.observations, 2);
});

test('the Squire draws a seeded earlier date, never tonight', async () => {
  const { root, day } = stage({ earlier: ['2026-11-07', '2026-11-08', '2026-11-09'] });
  const { ctx } = ctxFor(root, day, fakeInfer());
  await panel.run(ctx);
  for (const o of ledgerOf(root).filter(x => x.kind === 'observation')) {
    assert.ok(o.squire, 'the placebo ran');
    assert.notStrictEqual(o.squire.date, day, 'a placebo drawn from tonight is not a placebo');
    assert.ok(o.squire.date < day);
    assert.strictEqual(o.squire.scores.length, 3);
  }
});

test('a changed charter body stops the run — law 2, never a quiet edit', async () => {
  const { root, day } = stage();
  const { ctx } = ctxFor(root, day, fakeInfer());
  await panel.run(ctx);
  fs.writeFileSync(path.join(root, 'THESIS_G.md'),
    BODY.replace('a claim', 'something else entirely') + sigLine('Opie', '11/10/2026'));
  const r2 = await panel.run(ctx);
  assert.strictEqual(r2.status, 'error');
  assert.match(r2.message, /charter body has changed since launch/);
  assert.match(r2.message, /dated amendments/);
});

test('a thin Skald reading abstains, and the abstention is recorded', async () => {
  const { root, day } = stage({ quality: 'thin' });
  const { ctx } = ctxFor(root, day, fakeInfer());
  const r = await panel.run(ctx);
  assert.strictEqual(r.status, 'thin');
  assert.strictEqual(r.observations, 0);
  const rows = ledgerOf(root);
  assert.strictEqual(rows.filter(x => x.kind === 'observation').length, 0);
  assert.strictEqual(rows.filter(x => x.kind === 'abstention').length, 2);
  assert.match(rows[0].why, /was "thin"/);
});

test('an unreadable score abstains — no mock data, ever', async () => {
  const { root, day } = stage();
  const { ctx } = ctxFor(root, day, fakeInfer({ garbage: true }));
  const r = await panel.run(ctx);
  assert.strictEqual(r.observations, 0);
  const rows = ledgerOf(root);
  assert.strictEqual(rows.filter(x => x.kind === 'observation').length, 0);
  assert.match(rows[0].why, /unreadable score/);
  assert.ok(rows[0].cost_usd > 0, 'the calls already paid for are recorded, not hidden');
});

test('a budget refusal mid-observation writes NO partial observation', async () => {
  const { root, day } = stage();
  const { ctx } = ctxFor(root, day, fakeInfer({ budgetAfter: 4 }));  // dies inside the first stimulus
  const r = await panel.run(ctx);
  const rows = ledgerOf(root);
  assert.strictEqual(rows.filter(x => x.kind === 'observation').length, 0,
    'half an observation is mock data wearing a real observation uniform');
  assert.ok(rows.some(x => x.kind === 'abstention' && /abstained/.test(x.why)));
  assert.strictEqual(r.observations, 0);
});

test('running twice in a night freezes nothing the second time', async () => {
  const { root, day } = stage();
  const { ctx } = ctxFor(root, day, fakeInfer());
  await panel.run(ctx);
  const r2 = await panel.run(ctx);
  assert.deepStrictEqual(r2.froze, []);
  assert.strictEqual(r2.observations, 2, 'still two, not four');
  assert.ok(r2.abstained.every(s => /already frozen/.test(s)));
});

test('THE PEEKING GUARD: nothing reported nightly can reveal the answer', async () => {
  // Law 3 — one look, no peeking, no early stopping. A progress report that
  // carried the delta, the means or the spreads would let the verdict be read
  // early, and peeking is not prevented by good intentions.
  const { root, day } = stage({ earlier: ['2026-11-09'] });
  const { ctx, posted } = ctxFor(root, day, fakeInfer());
  const r = await panel.run(ctx);

  const line = panel.summaryLine(r);

  // Check KEYS exactly, not substrings — an earlier version of this test matched
  // "sd" inside "cost_total_usd" and failed an innocent card.
  const keysOf = (o, acc = []) => {
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) { acc.push(k.toLowerCase()); keysOf(o[k], acc); }
    }
    return acc;
  };
  const keys = keysOf({ posted, result: r });
  for (const leak of ['delta', 'sd', 'scores', 'mood', 'pair_abs',
                      'panel', 'benchmark', 'squire', 'jester']) {
    assert.ok(!keys.includes(leak),
      `the nightly report carries "${leak}" — the box could be read before it opens`);
  }

  // And no computed figure from the sealed ledger reaches the court's one line.
  // Only figures long enough to be distinctive are checked: a single digit like a
  // benchmark spread of exactly 1 occurs in any sentence containing a number, and
  // an earlier version of this test failed on precisely that.
  let checked = 0;
  for (const o of ledgerOf(root).filter(x => x.kind === 'observation')) {
    for (const v of [o.delta, o.panel.sd, o.benchmark.sd]) {
      const s = String(v);
      if (s.length < 4) continue;
      checked += 1;
      assert.ok(!line.includes(s), `the nightly line contains the sealed figure ${s}`);
    }
  }
  assert.ok(checked > 0, 'the guard must actually have something to check');

  assert.match(line, /2\/60 observations/);
  assert.match(line, /spent to date/);
});

test('the real panel card is a conforming card and declares what it needs', () => {
  const m = JSON.parse(fs.readFileSync(path.join(IMPERIUM, 'cards', 'panel', 'card.json'), 'utf8'));
  assert.ok(m.needs.includes('infer'), 'it calls models');
  assert.ok(m.authority.includes('model:infer'), 'and claims the authority to');
  assert.ok(m.authority.includes('board:write'));
  assert.ok(!m.authority.includes('board:read'), 'it has no business reading the floor');
});
