'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// THE TRANSLATOR (2026-11-07) — sits between every court member's reply and the
// plain code that reads it. Plain code, $0, no network, same answer every time.
//
// It FIXES FORM, never facts:
//   • finds the form inside chatter or a ```json fence
//   • repairs syntax: curly/single quotes, comments, trailing commas, unquoted keys,
//     Python True/False/None, raw newlines and stray quote marks inside text
//   • coerces types the form asks for: "70" / "70%" / "seventy" → 70, "pass" → "PASS",
//     one item where a list belongs → [item]
// It NEVER invents: an out-of-range number, a missing field, a half-written (cut-off)
// reply or an unknown word stays an error. Every repair is listed, so nothing gets
// quietly cleaned up — callers record `repairs` next to the result.
//
// translate(text, form) → { parsed, ok, value, repairs[], errors[] }
//   parsed: a JSON value was recovered (value is usable; the caller's judge decides)
//   ok:     parsed AND every rule of the form holds
// New court members add their form to FORMS below.
// ─────────────────────────────────────────────────────────────────────────────

const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function wordsToNumber(s) {
  const t = String(s).toLowerCase().trim().replace(/[-\s]+/g, ' ');
  if (/^(one |a )?hundred$/.test(t)) return 100;
  const p = t.split(' ');
  if (p.length === 1 && p[0] in NUM) return NUM[p[0]];
  if (p.length === 2 && NUM[p[0]] >= 20 && NUM[p[0]] % 10 === 0 && NUM[p[1]] >= 1 && NUM[p[1]] <= 9) return NUM[p[0]] + NUM[p[1]];
  return null;
}

// ── finding the form ─────────────────────────────────────────────────────────
// Every balanced {...} or [...] in the text, in order (string-aware, so braces inside text don't count).
function candidates(text, opener) {
  const out = [];
  const fence = /```(?:json|dispatch)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(text)) !== null) if (m[1].trim()) out.push({ src: m[1].trim(), fenced: true });
  for (let i = 0; i < text.length && out.length < 24; i++) {
    const c = text[i];
    if (!(opener ? c === opener : c === '{' || c === '[')) continue;
    const end = closeOf(text, i);
    if (end === CUT) { out.push({ src: text.slice(i), cut: true }); break; }   // ran off the end: everything after
    if (end === MISMATCH) continue;                                            // is INSIDE the cut form, never mine it
    out.push({ src: text.slice(i, end + 1) });                                 // (2026-11-07: a cut reply once yielded
    i = end;                                                                   //  one inner driver as "the reading")
  }
  return out;
}

const CUT = -1, MISMATCH = -2;
function closeOf(s, i) {
  const stack = [];
  let q = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { if (stack.pop() !== c) return MISMATCH; if (!stack.length) return j; }
  }
  return CUT;
}

// ── loosening near-JSON into JSON ────────────────────────────────────────────
const OPEN_Q = { '"': /["“”]/, "'": /['‘’]/, '“': /["“”]/, '”': /["“”]/, '‘': /['‘’]/, '’': /['‘’]/ };
const LITERALS = { True: 'true', False: 'false', None: 'null', true: 'true', false: 'false', null: 'null' };

function nextSolid(s, j) { while (j < s.length && /\s/.test(s[j])) j++; return j; }

function loosen(src) {
  const fixes = new Set();
  let out = '';
  const n = src.length;
  for (let i = 0; i < n;) {
    const c = src[i];
    if (OPEN_Q[c]) {                                     // a string, whatever quote it opened with
      if (c === "'" || c === '‘' || c === '’') fixes.add('single quotes → double');
      else if (c !== '"') fixes.add('curly quotes → straight');
      let j = i + 1, s = '';
      for (; j < n; j++) {
        const d = src[j];
        if (d === '\\') { const e = src[j + 1] ?? ''; s += e === "'" ? "'" : d + e; j++; continue; }
        if (OPEN_Q[c].test(d)) {
          const k = nextSolid(src, j + 1);               // a quote only closes the text if structure follows it
          if (k >= n || ',:}]'.includes(src[k])) break;
          if (d === '"') fixes.add('stray quote mark inside text escaped');
          s += d === '"' ? '\\"' : d; continue;                // apostrophes and curly marks stay as written
        }
        if (d === '"') { s += '\\"'; continue; }
        if (d === '\n') { s += '\\n'; fixes.add('raw line break inside text'); continue; }
        if (d === '\t') { s += '\\t'; continue; }
        s += d;
      }
      out += '"' + s + '"'; i = j + 1; continue;
    }
    if (c === '/' && src[i + 1] === '/') { fixes.add('comments removed'); while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { fixes.add('comments removed'); const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === ',') {
      const k = nextSolid(src, i + 1);
      if (k < n && (src[k] === '}' || src[k] === ']')) { fixes.add('trailing comma removed'); i++; continue; }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < n && /[\w$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      const k = nextSolid(src, j);
      if (src[k] === ':' && /[{,]\s*$/.test(out)) { out += JSON.stringify(w); fixes.add('unquoted key quoted'); }
      else if (w in LITERALS) { if (LITERALS[w] !== w) fixes.add('Python True/False/None'); out += LITERALS[w]; }
      else out += w;                                     // a bare word value: left alone, parse will refuse it
      i = j; continue;
    }
    out += c; i++;
  }
  return { out, fixes: [...fixes] };
}

function parseLoose(src) {
  try { return { ok: true, value: JSON.parse(src), fixes: [] }; } catch {}
  const { out, fixes } = loosen(src);
  try { return { ok: true, value: JSON.parse(out), fixes }; } catch (e) { return { ok: false, error: e.message }; }
}

// ── holding the value to the form ────────────────────────────────────────────
function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }

function conform(v, f, at, rep, err) {
  if (!f) return v;
  const where = at || 'reply';
  if (f.enum) {
    if (v == null) { err.push(`${where}: missing (one of ${f.enum.join('/')})`); return v; }
    const s = String(v).trim();
    if (f.enum.includes(s)) return s;
    const alias = f.aliases && f.aliases[s.toUpperCase()];
    const hit = alias || f.enum.find(e => e.toLowerCase() === s.toLowerCase());
    if (hit) { rep.push(`${where}: "${s}" → "${hit}"`); return hit; }
    err.push(`${where}: "${s.slice(0, 40)}" is not one of ${f.enum.join('/')}`); return v;
  }
  switch (f.type) {
    case 'integer': case 'number': {
      let n = v;
      if (typeof v === 'string') {
        const t = v.trim();
        const m = t.match(/^(-?\d+(?:\.\d+)?)\s*%?$/);
        n = m ? Number(m[1]) : wordsToNumber(t);
        if (n == null) { err.push(`${where}: "${t.slice(0, 40)}" is not a number`); return v; }
        rep.push(`${where}: "${t}" → ${n}`);
      }
      if (typeof n !== 'number' || !Number.isFinite(n)) { err.push(`${where}: expected a number, got ${typeOf(v)}`); return v; }
      if (f.type === 'integer' && !Number.isInteger(n)) { err.push(`${where}: ${n} is not a whole number (not rounded)`); return n; }
      if (f.min != null && n < f.min) err.push(`${where}: ${n} is below ${f.min} (not clamped)`);
      if (f.max != null && n > f.max) err.push(`${where}: ${n} is above ${f.max} (not clamped)`);
      return n;
    }
    case 'string': {
      if (v == null) { err.push(`${where}: missing`); return v; }
      let s = v;
      if (typeof v === 'number' || typeof v === 'boolean') { s = String(v); rep.push(`${where}: ${v} → "${s}"`); }
      if (typeof s !== 'string') { err.push(`${where}: expected text, got ${typeOf(v)}`); return v; }
      if (f.trim && s !== s.trim()) { rep.push(`${where}: spaces trimmed`); s = s.trim(); }
      if (f.pattern && !f.pattern.test(s)) err.push(`${where}: "${s.slice(0, 60)}" doesn't match ${f.pattern}`);
      return s;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(s)) { rep.push(`${where}: "${v}" → true`); return true; }
      if (['false', 'no', 'n', '0'].includes(s)) { rep.push(`${where}: "${v}" → false`); return false; }
      err.push(`${where}: "${String(v).slice(0, 20)}" is not yes/no`); return v;
    }
    case 'array': {
      let a = v;
      if (!Array.isArray(a)) {
        if (a != null && f.wrap) { a = [a]; rep.push(`${where}: single item → list`); }
        else { err.push(`${where}: expected a list, got ${typeOf(v)}`); return v; }
      }
      if (f.min != null && a.length < f.min) err.push(`${where}: ${a.length} item(s), want at least ${f.min}`);
      return a.map((x, i) => conform(x, f.items, `${where}[${i}]`, rep, err));
    }
    case 'object': {
      if (typeOf(v) !== 'object') { err.push(`${where}: expected an object, got ${typeOf(v)}`); return v; }
      const o = { ...v };
      for (const k of f.required || []) if (o[k] == null) err.push(`${at ? at + '.' : ''}${k}: missing`);
      for (const [k, sub] of Object.entries(f.properties || {})) {
        if (o[k] != null) o[k] = conform(o[k], sub, at ? `${at}.${k}` : k, rep, err);
      }
      return o;
    }
    default: return v;
  }
}

// ── the one call ─────────────────────────────────────────────────────────────
function translate(text, form = {}) {
  const raw = String(text ?? '');
  const opener = form.type === 'array' && !form.wrap ? '[' : form.type === 'object' ? '{' : null;
  let best = null, cut = false;
  for (const cand of candidates(raw, opener)) {
    if (cand.cut) { cut = true; continue; }
    const p = parseLoose(cand.src);
    if (!p.ok) continue;
    const rep = [...p.fixes];
    if (!cand.fenced && raw.trim() !== cand.src.trim()) rep.unshift('chatter around the form ignored');
    const err = [];
    const value = conform(p.value, form, '', rep, err);
    const r = { parsed: true, ok: err.length === 0, value, repairs: rep, errors: err };
    if (r.ok) return r;
    if (!best || err.length < best.errors.length) best = r;
  }
  if (best) return best;
  return { parsed: false, ok: false, value: null, repairs: [],
           errors: [cut ? 'The reply was cut off before the form closed (nothing invented to finish it).' : 'No form (JSON) found in the reply.'] };
}

// ── the court's forms ────────────────────────────────────────────────────────
const URL_RE = /^https?:\/\//;
const driver = { type: 'object', required: ['event', 'url'], properties: {
  event: { type: 'string', trim: true }, url: { type: 'string', trim: true, pattern: URL_RE },
  effect: { enum: ['fear', 'greed', 'neutral'] } } };
const FORMS = {
  // The Skald's reading (runners/skald.js). The Lawspeaker still judges sources and counts.
  skald: { type: 'object', required: ['crypto_mood', 'stock_mood', 'crypto_drivers', 'stock_drivers', 'headlines'], properties: {
    crypto_mood: { type: 'integer', min: 0, max: 100 }, stock_mood: { type: 'integer', min: 0, max: 100 },
    crypto_drivers: { type: 'array', wrap: true, items: driver }, stock_drivers: { type: 'array', wrap: true, items: driver },
    headlines: { type: 'array', wrap: true, items: { type: 'object', required: ['url'], properties: {
      title: { type: 'string', trim: true }, url: { type: 'string', trim: true, pattern: URL_RE },
      market: { enum: ['crypto', 'stocks'], aliases: { STOCK: 'stocks', EQUITIES: 'stocks', CRYPTOCURRENCY: 'crypto' } } } } } } },
  // Forseti's verdict (runners/forseti.js).
  forseti: { type: 'object', required: ['verdict'], properties: {
    verdict: { enum: ['PASS', 'FAIL'], aliases: { PASSED: 'PASS', PASSES: 'PASS', FAILED: 'FAIL', FAILS: 'FAIL' } },
    problems: { type: 'array', wrap: true, items: { type: 'string', trim: true } } } },
  // The Chancellor's dispatch block (warden.js): one order or a list of them.
  dispatch: { type: 'array', wrap: true, items: { type: 'object', required: ['to'], properties: { to: { type: 'string', trim: true } } } },
};

module.exports = { translate, FORMS, loosen, wordsToNumber };
