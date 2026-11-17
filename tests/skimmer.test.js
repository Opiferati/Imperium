'use strict';
// Page Skimmer prose tests (Phase 1, offline). Fixtures in tests/fixtures/skimmer/synthetic are SYNTHETIC.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sk = require(path.join(__dirname, '..', 'runners', 'skimmer.js'));
const ps = require(path.join(__dirname, '..', 'runners', 'porter-stemmer.js'));

const FIX = path.join(__dirname, 'fixtures', 'skimmer');
const SYN = path.join(FIX, 'synthetic');
const cfg = sk.loadConfig();
const S = cfg.settings;
const read = f => fs.readFileSync(path.join(SYN, f), 'utf8');
const page = (text, extra = {}) => Object.assign({ address: 'https://example.org/p', final: 'https://example.org/p', type: 'text/html', status: 200,
  fetched_at: '2026-11-17T00:00:00Z', retrieval: 'full', partial_reason: '', text }, extra);
// filler with no shared words with the questions below; each sentence distinct
const FILLER_WORDS = ['garden', 'violin', 'harbour', 'pastry', 'lantern', 'meadow', 'bicycle', 'teapot', 'orchard', 'canvas'];
// the hand-written pages are under the short-page line, so they are padded with neutral filler
const padded = f => filler(40) + ' ' + read(f) + ' ' + filler(10);
const filler = n => Array.from({ length: n }, (_, i) => `The ${FILLER_WORDS[i % 10]} club met ${i + 2} times near the ${FILLER_WORDS[(i * 3 + 1) % 10]} shop.`).join(' ');

// -- stemmer --
test('Porter stemmer (original 1980 rules) on hand-checked words', () => {
  const pairs = { caresses: 'caress', ponies: 'poni', ties: 'ti', cats: 'cat', feed: 'feed', agreed: 'agre', plastered: 'plaster',
    motoring: 'motor', sing: 'sing', conflated: 'conflat', hopping: 'hop', falling: 'fall', hissing: 'hiss', filing: 'file',
    happy: 'happi', sky: 'sky', relational: 'relat', conditional: 'condit', rational: 'ration', generalizations: 'gener',
    oscillators: 'oscil', earthquake: 'earthquak', quakes: 'quak', quaking: 'quak', sunspots: 'sunspot', magnitude: 'magnitud',
    forecasts: 'forecast', observed: 'observ', measured: 'measur', occurred: 'occur', hopeful: 'hope', goodness: 'good', electrical: 'electr' };
  for (const [w, s] of Object.entries(pairs)) assert.strictEqual(ps.stem(w), s, w);
  for (const [w, m] of Object.entries({ tr: 0, trouble: 1, troubles: 2, oaten: 2, private: 2 })) assert.strictEqual(ps.measure(w), m, w);
});

test('Porter stemmer against the published vocabulary, when it is present', { skip: !fs.existsSync(path.join(FIX, 'porter', 'voc.txt')) && 'porter/voc.txt not present (not fetched yet)' }, () => {
  // The published list follows the later reference code, which differs from 1980 on the abli/bli and logi rules.
  const voc = fs.readFileSync(path.join(FIX, 'porter', 'voc.txt'), 'utf8').split('\n');
  const out = fs.readFileSync(path.join(FIX, 'porter', 'output.txt'), 'utf8').split('\n');
  let diff = 0;
  voc.forEach((w, i) => { if (w && ps.stem(w) !== out[i] && !/(bli|logi)/.test(w)) diff++; });
  assert.strictEqual(diff, 0);
});

// -- tokens and sentences --
test('dates read as calendar days; impossible dates do not', () => {
  const t = s => sk.tokenize(s, S).filter(x => x.kind === 'date' || x.kind === 'month').map(x => x.t);
  assert.deepStrictEqual(t('On 2026-03-03 and March 4, 2026 and 5 March 2026'), ['2026-03-03', '2026-03-04', '2026-03-05']);
  assert.deepStrictEqual(t('Nov. 5'), ['??-11-05']);
  assert.deepStrictEqual(t('March 2026'), ['2026-03']);
  assert.deepStrictEqual(t('2026-02-30'), []);
});

test('quantities keep their label or unit', () => {
  const n = sk.tokenize('An M6.1 quake, Kp 7, and 1.5 nT', S).filter(x => x.kind === 'num');
  assert.deepStrictEqual(n.map(x => [x.value, x.label || x.unit]), [[6.1, 'M'], [7, 'Kp'], [1.5, 'nT']]);
});

test('sentences do not break after abbreviations or initials, and offsets point at the original text', () => {
  const text = 'Dr. Lee spoke on Nov. 5 about the U.S. network. J. Smith agreed! Next came questions? Yes.\nA new line\tstarts here';
  const ss = sk.splitSentences(text, S);
  assert.deepStrictEqual(ss.map(s => s.text), ['Dr. Lee spoke on Nov. 5 about the U.S. network.', 'J. Smith agreed!', 'Next came questions?', 'Yes.', 'A new line\tstarts here']);
  for (const s of ss) assert.strictEqual(text.slice(s.start, s.end), s.text);
});

test('very long sentences are split near the limit and flagged', () => {
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const ss = sk.splitSentences(long, S);
  assert.ok(ss.length >= 2);
  assert.ok(ss.every(s => s.text.length <= S.limits.max_sentence_chars));
  assert.ok(ss.some(s => (s.flags || []).includes('LONG_SPLIT')));
});

// -- outcomes --
test('a question the page answers is SKIMMED, with the answer kept', async () => {
  const r = await sk.skim(page(padded('f01-quake-news.txt')), { looking_for: 'earthquake magnitude in March 2026' }, cfg);
  assert.strictEqual(r.outcome, 'SKIMMED');
  assert.match(r.hand_off, /M6\.1 earthquake struck off the coast of Honshu/);
  assert.ok(r.reasons.includes('DATE_IN_RANGE'));
  assert.ok(r.reasons.includes('NUMBER_FOUND'));
  assert.ok(r.hand_off.startsWith('PAGE https://example.org/p (text/html) SKIMMED'));
  assert.match(r.hand_off, /read_page again with mode "full"/);
});

test('a page with none of the question is SKIPPED, with the way back named', async () => {
  const r = await sk.skim(page(padded('f01-quake-news.txt')), { looking_for: 'solar wind speed plasma density' }, cfg);
  assert.strictEqual(r.outcome, 'SKIPPED');
  assert.ok(r.reasons.includes('COVERAGE_LOW'));
  assert.match(r.hand_off, /^PAGE NOT SHOWN \(SKIPPED\)/);
  assert.match(r.hand_off, /mode "full"/);
});

test('only the coverage gate can skip: two concepts are FEW_CONCEPTS and never skipped', async () => {
  const r = await sk.skim(page(filler(80) + ' A plasma reading was noted.'), { looking_for: 'plasma density' }, cfg);
  assert.notStrictEqual(r.outcome, 'SKIPPED');
  assert.ok(r.reasons.includes('FEW_CONCEPTS'));
});

test('rescue: low coverage, but one sentence holds the date and the quantity beside a found concept', async () => {
  const text = filler(80) + ' A strong M6.1 earthquake hit on March 3, 2026.' + ' ' + filler(20);
  const r = await sk.skim(page(text), { looking_for: 'earthquake magnitude depth aftershock casualties in March 2026' }, cfg);
  assert.strictEqual(r.outcome, 'SKIMMED');
  assert.ok(r.reasons.includes('RESCUED'));
  assert.ok(r.reasons.includes('COVERAGE_LOW'));
});

test('high coverage with the concepts together goes wide (up to 30 sentences)', async () => {
  const hits = Array.from({ length: 40 }, (_, i) => `Sunspot count rose on day ${i + 1} while flare activity stayed moderate.`).join(' ');
  const r = await sk.skim(page(filler(60) + ' ' + hits), { looking_for: 'sunspot count flare activity' }, cfg);
  assert.strictEqual(r.outcome, 'SKIMMED');
  assert.strictEqual(r.tier, 'wide');
  assert.strictEqual(r.chosen.length, S.skim.wide_sentences);
});

test('a forecast page asked for observations is flagged KIND_MISMATCH and not widened', async () => {
  const r = await sk.skim(page(padded('f05-forecast.txt')), { looking_for: 'observed geomagnetic storm Kp on November 20' }, cfg);
  assert.ok(r.reasons.includes('KIND_MISMATCH'), r.reasons.join());
  assert.notStrictEqual(r.tier, 'wide');
});

test('F13 SSN: the page names sunspot number only through an ambiguous abbreviation', async () => {
  const r = await sk.skim(page(padded('f13-ssn.txt')), { looking_for: 'sunspot number in October' }, cfg);
  assert.ok(r.coverage.missing.includes('sunspot number'));
  assert.ok(r.reasons.includes('AMBIGUOUS_ONLY'));
});

test('F13 M: a bare M never counts as magnitude', async () => {
  const r = await sk.skim(page(padded('f13-m.txt')), { looking_for: 'earthquake magnitude bulletin' }, cfg);
  assert.ok(r.coverage.missing.includes('magnitude'));
});

test('F13 volcanic tremor: related to earthquake, shown, never counted', async () => {
  const r = await sk.skim(page(padded('f13-volcanic-tremor.txt')), { looking_for: 'earthquake activity this week' }, cfg);
  assert.ok(r.coverage.missing.includes('earthquake'));
  assert.ok(r.coverage.related_seen.includes('tremor'));
});

test('PASSTHROUGH cases: mode full, short page, no looking_for, too long', async () => {
  const long = padded('f01-quake-news.txt');
  assert.strictEqual((await sk.skim(page(long), { looking_for: 'quake', mode: 'full' }, cfg)).outcome, 'PASSTHROUGH');
  const short = await sk.skim(page('A short page about an earthquake.'), { looking_for: 'earthquake' }, cfg);
  assert.deepStrictEqual([short.outcome, short.reasons], ['PASSTHROUGH', ['SHORT_PAGE']]);
  assert.deepStrictEqual((await sk.skim(page(long), {}, cfg)).reasons, ['NO_LOOKING_FOR']);
  const huge = await sk.skim(page('a'.repeat(S.limits.prose_max_chars + 1)), { looking_for: 'earthquake' }, cfg);
  assert.deepStrictEqual([huge.outcome, huge.reasons, huge.hand_off.length <= huge.cap], ['PASSTHROUGH', ['TOO_LONG_TO_SKIM'], true]);
});

test('a failed reader is UNAVAILABLE, never SKIPPED', async () => {
  const r = await sk.skim({ address: 'https://example.org/x', ok: false, error: 'HTTP 404' }, { looking_for: 'earthquake' }, cfg);
  assert.strictEqual(r.outcome, 'UNAVAILABLE');
  assert.match(r.hand_off, /HTTP 404/);
});

test('an error forced at every step gives PASSTHROUGH with the page start, never a hidden page', async () => {
  const text = padded('f01-quake-news.txt');
  for (const step of ['route', 'concepts', 'split', 'tokens', 'gate', 'rank', 'select', 'cap']) {
    const r = await sk.skim(page(text), { looking_for: 'earthquake magnitude March 2026' }, cfg, { failAt: step });
    assert.strictEqual(r.outcome, 'PASSTHROUGH', step);
    assert.ok(r.reasons.includes('SKIMMER_FAILED'), step);
    assert.ok(r.hand_off.includes(text.slice(0, 200)), step);
    assert.ok(r.hand_off.length <= r.cap, step);
  }
});

test('a slow skim times out into PASSTHROUGH', async () => {
  let t = 0;
  const r = await sk.skim(page(padded('f01-quake-news.txt')), { looking_for: 'earthquake magnitude' }, cfg, { now: () => (t += 4000) });
  assert.deepStrictEqual([r.outcome, r.reasons], ['PASSTHROUGH', ['SKIMMER_TIMEOUT']]);
});

// -- determinism, cap and support --
test('the same page and question give the same hand-off, byte for byte', async () => {
  const p = page(filler(200) + ' ' + read('f01-quake-news.txt') + ' ' + filler(100));
  const q = { looking_for: 'earthquake magnitude aftershocks in March 2026' };
  const a = await sk.skim(p, q, cfg), b = await sk.skim(p, q, cfg);
  assert.strictEqual(a.hand_off, b.hand_off);
  assert.deepStrictEqual(a.kept, b.kept);
});

test('nothing over the cap is ever handed off, at any cap', async () => {
  const hits = Array.from({ length: 60 }, (_, i) => `Sunspot count rose sharply on day ${i + 1}, and flare activity ${'stayed moderate across the disk '.repeat(1 + (i % 5))}.`).join(' ');
  const p = page(filler(100) + ' ' + hits);
  for (const cap of [700, 900, 1500, 4000, 12000, 32000]) {
    const r = await sk.skim(p, { looking_for: 'sunspot count flare activity' }, cfg, { cap });
    assert.ok(r.hand_off.length <= cap, `cap ${cap}: ${r.hand_off.length}`);
    assert.strictEqual(r.chars_out, r.hand_off.length);
  }
});

test('kept spans point at the frozen text, and every kept sentence is shown word for word', async () => {
  const text = filler(50) + ' ' + read('f01-quake-news.txt');
  const r = await sk.skim(page(text), { looking_for: 'earthquake aftershocks tsunami warning' }, cfg);
  assert.strictEqual(r.outcome, 'SKIMMED');
  for (const k of r.kept) assert.ok(r.hand_off.includes(`[s${k.sid}] ${text.slice(k.start, k.end)}`));
});

test('the result record carries every field the contract names', async () => {
  const r = await sk.skim(page(padded('f01-quake-news.txt')), { looking_for: 'earthquake magnitude' }, cfg);
  for (const k of ['outcome', 'reasons', 'hand_off', 'chars_in', 'chars_out', 'cap', 'cut', 'retrieval', 'partial_reason', 'kept', 'rows', 'coverage',
    'page_sha256', 'fetched_at', 'address', 'skimmer_version', 'settings_hash', 'glossary_version']) assert.ok(k in r, k);
  assert.strictEqual(r.settings_hash, cfg.settings_hash);
});

test('the log is written only when asked, append-only, to the folder given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-log-'));
  try {
    const log = path.join(dir, 'skimmer-log.jsonl');
    await sk.skim(page(padded('f01-quake-news.txt')), { looking_for: 'earthquake' }, cfg);
    assert.ok(!fs.existsSync(log));
    await sk.skim(page(padded('f01-quake-news.txt')), { looking_for: 'earthquake' }, cfg, { logFile: log, order_id: 'T1' });
    await sk.skim(page(padded('f01-quake-news.txt')), { looking_for: 'volcano' }, cfg, { logFile: log, order_id: 'T2' });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepStrictEqual(lines.map(l => l.order_id), ['T1', 'T2']);
    assert.ok(lines.every(l => l.settings_hash === cfg.settings_hash && !('hand_off' in l)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a partial page says so in the header', async () => {
  const r = await sk.skim(page(padded('f01-quake-news.txt'), { retrieval: 'partial', partial_reason: 'character cut, first part only' }), { looking_for: 'earthquake magnitude' }, cfg);
  assert.match(r.hand_off, /retrieval partial \(character cut, first part only\)/);
});
