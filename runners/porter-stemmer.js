'use strict';
// ══════════════════════════════════════════════════════════════════════
// PORTER STEMMER — Legion's own copy (Page Skimmer, Phase 1, 2026-11-17)
//
// M. F. Porter, "An algorithm for suffix stripping", Program 14(3), 1980.
// This is the ORIGINAL 1980 algorithm as the paper states it, on purpose:
//   - step 2 uses "abli -> able" (the later reference code uses "bli -> ble")
//   - step 2 has no "logi -> log" rule (added in the later reference code)
// So a word list made by the later reference code will differ on words
// those two rules touch. The tests say so instead of hiding it.
//
// No outside packages. Pure function: same word in, same root out.
// ══════════════════════════════════════════════════════════════════════

/** Is the letter at i a consonant? y counts as a vowel after a consonant. */
function isCons(w, i) {
  const c = w[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y') return i === 0 ? true : !isCons(w, i - 1);
  return true;
}

/** m: the number of vowel-consonant runs, [C](VC)^m[V]. */
function measure(s) {
  let m = 0, i = 0;
  const n = s.length;
  while (i < n && isCons(s, i)) i++;
  while (i < n) {
    while (i < n && !isCons(s, i)) i++;
    if (i >= n) break;
    while (i < n && isCons(s, i)) i++;
    m++;
  }
  return m;
}

function hasVowel(s) { for (let i = 0; i < s.length; i++) if (!isCons(s, i)) return true; return false; }
function doubleCons(s) { const n = s.length; return n >= 2 && s[n - 1] === s[n - 2] && isCons(s, n - 1); }
/** *o: ends consonant-vowel-consonant, and the last is not w, x or y. */
function cvc(s) {
  const n = s.length;
  if (n < 3) return false;
  if (!isCons(s, n - 3) || isCons(s, n - 2) || !isCons(s, n - 1)) return false;
  const c = s[n - 1];
  return c !== 'w' && c !== 'x' && c !== 'y';
}

function step1a(w) {
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ies')) return w.slice(0, -2);
  if (w.endsWith('ss')) return w;
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function step1b(w) {
  if (w.endsWith('eed')) {
    const st = w.slice(0, -3);
    return measure(st) > 0 ? w.slice(0, -1) : w;
  }
  let st = null;
  if (w.endsWith('ed')) st = w.slice(0, -2);
  else if (w.endsWith('ing')) st = w.slice(0, -3);
  if (st === null || !hasVowel(st)) return w;
  if (st.endsWith('at') || st.endsWith('bl') || st.endsWith('iz')) return st + 'e';
  if (doubleCons(st)) {
    const c = st[st.length - 1];
    return c === 'l' || c === 's' || c === 'z' ? st : st.slice(0, -1);
  }
  if (measure(st) === 1 && cvc(st)) return st + 'e';
  return st;
}

function step1c(w) {
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) return w.slice(0, -1) + 'i';
  return w;
}

// Only the longest matching suffix is tried; if its condition fails, nothing else is.
function rule(w, list, cond) {
  let best = null;
  for (const [suf, rep] of list) if (w.endsWith(suf) && (!best || suf.length > best[0].length)) best = [suf, rep];
  if (!best) return w;
  const st = w.slice(0, -best[0].length);
  return cond(st, best[0]) ? st + best[1] : w;
}

const STEP2 = [['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'],
  ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'],
  ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'],
  ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble']];
const STEP3 = [['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', '']];
const STEP4 = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ion', 'ou',
  'ism', 'ate', 'iti', 'ous', 'ive', 'ize'].map(s => [s, '']);

const step2 = w => rule(w, STEP2, st => measure(st) > 0);
const step3 = w => rule(w, STEP3, st => measure(st) > 0);
const step4 = w => rule(w, STEP4, (st, suf) => measure(st) > 1 &&
  (suf !== 'ion' || st.endsWith('s') || st.endsWith('t')));

function step5a(w) {
  if (!w.endsWith('e')) return w;
  const st = w.slice(0, -1), m = measure(st);
  if (m > 1 || (m === 1 && !cvc(st))) return st;
  return w;
}

function step5b(w) {
  if (measure(w) > 1 && doubleCons(w) && w.endsWith('l')) return w.slice(0, -1);
  return w;
}

/** Stem one lower-case word. Words under three letters, or holding anything but a-z, come back as they are. */
function stem(word) {
  const w0 = String(word);
  if (w0.length < 3 || !/^[a-z]+$/.test(w0)) return w0;
  let w = step1a(w0);
  w = step1b(w);
  w = step1c(w);
  w = step2(w);
  w = step3(w);
  w = step4(w);
  w = step5a(w);
  w = step5b(w);
  return w;
}

module.exports = { stem, measure, isCons, cvc, step1a, step1b, step1c, step2, step3, step4, step5a, step5b, VARIANT: 'porter-1980-original' };
