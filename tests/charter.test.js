'use strict';
// The charter lock, Node side. These tests exist because on 2026-11-10 the amendment check
// returned TRUE for a blank initials line: the regex accepted any non-space after the word
// "initial", and the markdown asterisk in "**Initials:**" was enough. A guard that says yes
// when nobody signed is worse than no guard at all, so every near-miss is pinned here.
const { test } = require('node:test');
const assert = require('node:assert');
const charter = require('../runners/charter.js');

const BODY = '# A thesis\n\nrules\n\n';
const amd = tail => `${BODY}## AMENDMENT 1 - a change\n\n${tail}\n`;

test('a blank initials line is a proposal, however it is written', () => {
  for (const blank of [
    '**Initialed:** ______________ (Opie)  **Date:** ____________',
    '**Initials:** ______________  **Date:** ____________',
    '**Initialed:** ______________ (Opie)',
    'Initials: ______________',
    '**Initialed:**   ',
  ]) assert.strictEqual(charter.amendmentInitialed(amd(blank), 1), false, blank);
});

test('prose that merely mentions the word does not initial anything', () => {
  assert.strictEqual(charter.amendmentInitialed(
    amd('An amendment nobody initialed is a proposal, and initials are not prose.'), 1), false);
});

test('a real initial, with or without bold, with or without a date beside it', () => {
  for (const done of [
    '**Initialed:** CM  **Date:** 11/10/2026',
    '**Initialed:** __Opie 11/7/2026__',
    '**Initials:** Opie',
    'Initials: CM',
  ]) assert.strictEqual(charter.amendmentInitialed(amd(done), 1), true, done);
});

test('each amendment is judged on its own section', () => {
  const two = `${BODY}## AMENDMENT 1 - a\n**Initialed:** Opie\n\n## AMENDMENT 2 - b\n**Initialed:** ______________\n`;
  assert.strictEqual(charter.amendmentInitialed(two, 1), true);
  assert.strictEqual(charter.amendmentInitialed(two, 2), false);
  assert.strictEqual(charter.amendmentInitialed(two, 3), false);
  assert.strictEqual(charter.amendmentInitialed('no amendments here', 1), false);
});

test('the signature line is outside the hash, so signing does not change what was signed', () => {
  const unsigned = `${BODY}${charter.SIG_MARK} ______________  **Date:** ____________\n`;
  const signed = `${BODY}${charter.SIG_MARK} __Opie__  **Date:** _11/10/2026_\n`;
  assert.strictEqual(charter.bodyHash(unsigned), charter.bodyHash(signed));
  assert.strictEqual(charter.signed(unsigned).ok, false);
  assert.deepStrictEqual([charter.signed(signed).ok, charter.signed(signed).who], [true, 'Opie']);
});

test('signed but undated is not signed', () => {
  assert.match(charter.signed(`${BODY}${charter.SIG_MARK} __Opie__  **Date:** ____\n`).why, /undated/);
});

test('an amendment never trips the lock', () => {
  const base = `${BODY}${charter.SIG_MARK} __Opie__  **Date:** _11/10/2026_\n`;
  assert.strictEqual(charter.bodyHash(base),
    charter.bodyHash(`${base}\n## AMENDMENT 1 - x\n**Initialed:** Opie\n`));
});

test("the live INTERCOM spec: signed, and its Amendment 1 is still only a proposal", () => {
  const fs = require('node:fs');
  const text = fs.readFileSync(require('node:path').join(__dirname, '..', 'INTERCOM.md'), 'utf8');
  assert.strictEqual(charter.signed(text).ok, true);
  assert.strictEqual(charter.bodyHash(text), '42a848a0333f8b5f');
  assert.strictEqual(charter.amendmentInitialed(text, 1), false, 'Opie has not initialed Amendment 1');
});
