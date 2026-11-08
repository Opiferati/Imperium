'use strict';
// node --test tests/   (built-in runner, no npm)
const test = require('node:test');
const assert = require('node:assert/strict');
const { translate, FORMS, wordsToNumber } = require('../runners/translator.js');

const goodSkald = {
  crypto_mood: 22, stock_mood: 30,
  crypto_drivers: [{ event: 'BTC fell', effect: 'fear', url: 'https://ex.com/a/btc-fell' }],
  stock_drivers: [{ event: 'AI rout', effect: 'fear', url: 'https://ex.com/a/ai-rout' }],
  headlines: [{ title: 'h', url: 'https://ex.com/a/h1', market: 'crypto' }],
};

test('clean form passes untouched, no repairs listed', () => {
  const r = translate(JSON.stringify(goodSkald), FORMS.skald);
  assert.equal(r.ok, true);
  assert.deepEqual(r.repairs, []);
  assert.deepEqual(r.value, goodSkald);
});

test('chatter and a ```json fence around the form', () => {
  const r = translate('Here is my reading:\n```json\n' + JSON.stringify(goodSkald) + '\n```\nHope that helps!', FORMS.skald);
  assert.equal(r.ok, true);
  assert.equal(r.value.stock_mood, 30);
  const r2 = translate('Sure! ' + JSON.stringify(goodSkald) + ' Done.', FORMS.skald);
  assert.equal(r2.ok, true);
  assert.ok(r2.repairs.includes('chatter around the form ignored'));
});

test('syntax repairs: trailing commas, comments, single and curly quotes, unquoted keys, Python literals', () => {
  const messy = `{crypto_mood: 22, 'stock_mood': 30, // scores
    "crypto_drivers": [{"event": "Binance's hack", "effect": "fear", "url": "https://ex.com/a/x",},],
    “stock_drivers”: [{event: 'AI rout', effect: 'fear', url: 'https://ex.com/a/y'}],
    "headlines": [{"title": "h", "url": "https://ex.com/a/h1", "market": "crypto", "fresh": True}],}`;
  const r = translate(messy, FORMS.skald);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.value.crypto_drivers[0].event, "Binance's hack");          // apostrophe kept as written
  assert.equal(r.value.headlines[0].fresh, true);
  for (const f of ['trailing comma removed', 'comments removed', 'single quotes → double', 'unquoted key quoted', 'Python True/False/None'])
    assert.ok(r.repairs.includes(f), `missing repair note: ${f}`);
});

test('stray double quote inside text is escaped, not treated as the end', () => {
  const r = translate('{"verdict": "FAIL", "problems": ["file says "hello" twice"]}', FORMS.forseti);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.value.problems[0], 'file says "hello" twice');
});

test('number coercion: "70", "70%", "seventy", "seventy-two" — and every one is recorded', () => {
  for (const [given, want] of [['"70"', 70], ['"70%"', 70], ['"seventy"', 70], ['"seventy-two"', 72], ['"one hundred"', 100]]) {
    const r = translate(JSON.stringify({ ...goodSkald, crypto_mood: undefined }).replace('{', `{"crypto_mood": ${given},`), FORMS.skald);
    assert.equal(r.value.crypto_mood, want, given);
    assert.ok(r.repairs.some(x => x.startsWith('crypto_mood:')), given);
  }
  assert.equal(wordsToNumber('banana'), null);
});

test('never invents: out of range, fractions, missing fields and unknown words stay errors', () => {
  const bad = (patch) => translate(JSON.stringify({ ...goodSkald, ...patch }), FORMS.skald);
  assert.match(bad({ crypto_mood: 140 }).errors.join(), /above 100 \(not clamped\)/);
  assert.equal(bad({ crypto_mood: 140 }).value.crypto_mood, 140);
  assert.match(bad({ stock_mood: 30.5 }).errors.join(), /not a whole number/);
  assert.match(bad({ stock_mood: 'lots' }).errors.join(), /not a number/);
  const noStock = { ...goodSkald }; delete noStock.stock_mood;
  const r = translate(JSON.stringify(noStock), FORMS.skald);
  assert.equal(r.parsed, true); assert.equal(r.ok, false);
  assert.match(r.errors.join(), /stock_mood: missing/);
});

test('a reply cut off mid-form is reported as cut off, never completed', () => {
  const r = translate(JSON.stringify(goodSkald).slice(0, 60), FORMS.skald);
  assert.equal(r.parsed, false);
  assert.match(r.errors[0], /cut off/);
});

test('11-07 bug: a cut-off reading is never mined for a complete inner piece', () => {
  // Cut AFTER the first driver closed: the old scan returned that driver as "the reading" (scores null).
  const full = JSON.stringify(goodSkald);
  const cut = full.slice(0, full.indexOf('"stock_drivers"') + 20);
  const r = translate(cut, FORMS.skald);
  assert.equal(r.parsed, false);
  assert.match(r.errors[0], /cut off/);
});

test('a mismatched bracket in prose before the form does not stop the search', () => {
  const r = translate('Notes (see {draft]) ' + JSON.stringify(goodSkald), FORMS.skald);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('enums: case and aliases fixed, unknown words refused', () => {
  assert.equal(translate('{"verdict":"pass"}', FORMS.forseti).value.verdict, 'PASS');
  assert.equal(translate('{"verdict":"Failed","problems":"one thing"}', FORMS.forseti).value.verdict, 'FAIL');
  assert.deepEqual(translate('{"verdict":"FAIL","problems":"one thing"}', FORMS.forseti).value.problems, ['one thing']);
  const r = translate('{"verdict":"maybe"}', FORMS.forseti);
  assert.equal(r.ok, false); assert.match(r.errors[0], /not one of PASS\/FAIL/);
});

test('dispatch: one order or a list, "to" required', () => {
  assert.deepEqual(translate('{"to":"forge","task":"x"}', FORMS.dispatch).value, [{ to: 'forge', task: 'x' }]);
  assert.equal(translate('[{"to":"forge"},{"to":"scouts"}]', FORMS.dispatch).value.length, 2);
  assert.match(translate('[{"task":"x"}]', FORMS.dispatch).errors.join(), /\[0\]\.to: missing|to: missing/);
});

test('every real archived Skald reading goes through clean, with zero repairs', () => {
  const fs = require('node:fs'), path = require('node:path');
  const dir = path.join(__dirname, '..', 'data', 'skald-archive');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  for (const f of files) {
    const { reading } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const r = translate(JSON.stringify(reading), FORMS.skald);
    assert.equal(r.ok, true, `${f}: ${r.errors.join('; ')}`);
    assert.deepEqual(r.repairs, [], f);
    assert.deepEqual(r.value, reading, f);
  }
});

test('the Lawspeaker and Forseti still judge after translation', () => {
  const skald = require('../runners/skald.js');
  const forseti = require('../runners/forseti.js');
  const lw = skald.lawspeaker([{ type: 'text', text: '{"crypto_mood": "seventy", "stock_mood": 30, "crypto_drivers": [], "stock_drivers": [], "headlines": []}' }], 5);
  assert.equal(lw.verdict, 'FAIL');                                  // no real sources: still fails
  assert.equal(lw.reading.crypto_mood, 70);
  assert.ok(lw.translated.some(x => x.startsWith('crypto_mood:')));
  assert.equal(skald.lawspeaker([{ type: 'text', text: 'no form here' }], 5).verdict, 'FAIL');
  assert.equal(forseti.parseVerdict('Verdict follows. {"verdict": "Passed", "problems": []}').verdict, 'PASS');
  assert.equal(forseti.parseVerdict('{"verdict": "maybe"}').verdict, 'FAIL');      // unchanged: not PASS means FAIL
  assert.equal(forseti.parseVerdict('I could not decide.').verdict, 'UNSURE');
});

test('braces inside prose before the form do not fool it', () => {
  const r = translate('Note {draft}: ' + JSON.stringify(goodSkald), FORMS.skald);
  assert.equal(r.ok, true);
});
