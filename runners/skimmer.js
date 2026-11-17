'use strict';
// ====================
// PAGE SKIMMER - Phase 1, offline build (2026-11-17)
//
// skim(page, request, config) -> one result record, with the exact text the
// model would see. It never fetches anything. It can only make a page shorter.
//
// Six outcomes: SKIMMED, FILTERED, SKIPPED, PASSTHROUGH, ABSTAINED, UNAVAILABLE.
// Only the coverage gate can produce SKIPPED. Any failure inside the skimmer
// gives PASSTHROUGH (the page as the reader gives it today, at the cap), never
// a hidden page. Nothing over the cap is ever handed off.
//
// NOT wired into Warden, the research ministry or Trial IX. Design Doc:
// "Legion Page Skimmer: Design", revision 2. Every number lives in
// library/skimmer-settings.json; its hash is stamped on every result.
// ====================

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stem } = require('./porter-stemmer.js');
const tables = require('./skimmer-tables.js');


// -- text: cleaning, sentences, tokens (merged from the draft skimmer-text.js) --
// ====================
// PAGE SKIMMER - text tools (Phase 1, 2026-11-17)
// Cleaning, sentence splitting and tokens, shared by the gate, the ranking
// and the tests. No randomness, no outside packages.
// ====================


/** 1. Clean: Unicode NFKC, straight quotes, plain hyphens. Case is kept. */
// Curly quotes, primes and dashes are built from their code points so this file stays plain ASCII.
const chars = (...cps) => String.fromCharCode(...cps);
const RE_SINGLE = new RegExp(`[${chars(0x2018, 0x2019, 0x201A, 0x201B, 0x2032)}]`, 'g');
const RE_DOUBLE = new RegExp(`[${chars(0x201C, 0x201D, 0x201E, 0x201F, 0x2033)}]`, 'g');
const RE_DASH = new RegExp(`[${chars(0x2010)}-${chars(0x2015)}${chars(0x2212)}]`, 'g');
const RE_OPENER = new RegExp(`[A-Z0-9"'(${chars(0x201C, 0x2018)}]`);
const ELLIPSIS = chars(0x2026);
function clean(s) {
  return String(s).normalize('NFKC')
    .replace(RE_SINGLE, "'")
    .replace(RE_DOUBLE, '"')
    .replace(RE_DASH, '-');
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * 2. Split a page into sentences, keeping each one's place in the original text.
 * Returns [{ sid, start, end, text, flags }], sid counted from 1 in page order.
 * A line holding a tab (an HTML table row) is one unit. A sentence over the
 * limit is split at the space nearest the limit and flagged LONG_SPLIT.
 */
function splitSentences(text, settings) {
  const abbrev = new Set((settings.abbreviations_no_break || []).map(a => a.toLowerCase()));
  const maxLen = settings.limits.max_sentence_chars;
  const out = [];
  const push = (start, end, flags = []) => {
    // trim, keeping offsets true to the original text
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) return;
    if (end - start > maxLen) {
      let cutAt = -1, best = Infinity;
      for (let i = start + 1; i < end - 1; i++) {
        if (text[i] === ' ' && Math.abs(i - (start + maxLen)) < best && i - start <= maxLen) { best = Math.abs(i - (start + maxLen)); cutAt = i; }
      }
      if (cutAt < 0) cutAt = start + maxLen;
      push(start, cutAt, ['LONG_SPLIT']);
      push(cutAt, end, ['LONG_SPLIT']);
      return;
    }
    out.push({ sid: 0, start, end, text: text.slice(start, end), flags });
  };
  let lineStart = 0;
  const n = text.length;
  while (lineStart <= n) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = n;
    const line = text.slice(lineStart, lineEnd);
    if (line.includes('\t')) push(lineStart, lineEnd);
    else {
      let segStart = lineStart;
      for (let i = lineStart; i < lineEnd; i++) {
        const c = text[i];
        if (c !== '.' && c !== '!' && c !== '?') continue;
        const next = text[i + 1], after = text[i + 2];
        if (next !== ' ' || after === undefined || i + 2 >= lineEnd + 1) continue;
        // skip extra spaces
        let j = i + 1; while (j < lineEnd && text[j] === ' ') j++;
        if (j >= lineEnd || !RE_OPENER.test(text[j])) continue;
        if (c === '.') {
          // the word that ends at this full stop
          let k = i; while (k > segStart && !/\s/.test(text[k - 1])) k--;
          const word = text.slice(k, i + 1).toLowerCase().replace(/^[("'\[]+/, '');
          if (abbrev.has(word)) continue;
          if (/^[a-z]\.$/.test(word)) continue;            // a lone initial, as in "J. Smith"
        }
        push(segStart, i + 1);
        segStart = j;
      }
      push(segStart, lineEnd);
    }
    lineStart = lineEnd + 1;
  }
  out.forEach((s, i) => { s.sid = i + 1; });
  return out;
}

const pad2 = n => String(n).padStart(2, '0');

/** Build the token patterns once per settings object. */
function tokenPatterns(settings) {
  if (settings.__tok) return settings.__tok;
  const months = settings.months;
  const monthAlt = Object.keys(months).sort((a, b) => b.length - a.length).map(esc).join('|');
  const magAlt = settings.magnitude_labels.slice().sort((a, b) => b.length - a.length).map(esc).join('|');
  const labAlt = settings.value_labels.slice().sort((a, b) => b.length - a.length).map(esc).join('|');
  const unitAlt = settings.units.slice().sort((a, b) => b.length - a.length).map(esc).join('|');
  const tok = {
    months,
    iso: /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/,
    // Nov. 5, 2026 | November 5 2026 | Nov. 5
    mdy: new RegExp(`^(${monthAlt})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'i'),
    // 5 Nov 2026 | 5 November 2026
    dmy: new RegExp(`^(\\d{1,2})\\s+(${monthAlt})\\.?\\s+(\\d{4})\\b`, 'i'),
    // March 2026 (a whole month; used for date ranges)
    my: new RegExp(`^(${monthAlt})\\.?\\s+(\\d{4})\\b`, 'i'),
    mag: new RegExp(`^(${magAlt})\\s?(\\d+(?:\\.\\d+)?)(?![\\d.]*\\d)`),
    lab: new RegExp(`^(${labAlt})(?:\\s*=\\s*|\\s+)(\\d+(?:\\.\\d+)?[+-o]?)`),
    labAlone: new RegExp(`^(${labAlt})\\b`),
    numUnit: new RegExp(`^(\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\s?(${unitAlt})(?![A-Za-z])`, 'i'),
    num: /^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i,
    word: /^[A-Za-z]+(?:-[A-Za-z0-9]+)*/,
    units: new Map(settings.units.map(u => [u.toLowerCase(), u])),
  };
  Object.defineProperty(settings, '__tok', { value: tok, enumerable: false });
  return tok;
}

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  if (y === null) return true;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Is this a word the stemmer should leave alone (an abbreviation like SSN, Kp, Mw)? */
function isAbbrevWord(raw) { return /[A-Z]/.test(raw.slice(1)) || (/^[A-Z]{2,}$/.test(raw)); }

/**
 * 3. Tokens, tried in the order of the design's table. Each token:
 *  { t, kind: 'date'|'month'|'num'|'word', raw, ... }
 * t is the comparison form (dates as YYYY-MM-DD or ??-MM-DD, words lower-cased and stemmed).
 * Slash dates are never dates here.
 */
function tokenize(text, settings) {
  const tok = tokenPatterns(settings);
  const s = clean(text);
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (!/[A-Za-z0-9]/.test(c)) { i++; continue; }
    // a token must start at a boundary
    if (i > 0 && /[A-Za-z0-9]/.test(s[i - 1])) { i++; continue; }
    const rest = s.slice(i, i + 64);
    let m;
    if ((m = tok.iso.exec(rest))) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (validDate(y, mo, d)) { out.push({ t: `${m[1]}-${m[2]}-${m[3]}`, kind: 'date', raw: m[0], y, m: mo, d }); i += m[0].length; continue; }
    }
    if ((m = tok.mdy.exec(rest))) {
      const mo = tok.months[m[1].toLowerCase()], d = +m[2], y = m[3] ? +m[3] : null;
      if (validDate(y, mo, d)) {
        out.push({ t: `${y === null ? '??' : y}-${pad2(mo)}-${pad2(d)}`, kind: 'date', raw: m[0], y, m: mo, d, noYear: y === null });
        i += m[0].length; continue;
      }
    }
    if ((m = tok.dmy.exec(rest))) {
      const d = +m[1], mo = tok.months[m[2].toLowerCase()], y = +m[3];
      if (validDate(y, mo, d)) { out.push({ t: `${y}-${pad2(mo)}-${pad2(d)}`, kind: 'date', raw: m[0], y, m: mo, d }); i += m[0].length; continue; }
    }
    if ((m = tok.my.exec(rest)) && m[1].length >= 3) {
      const mo = tok.months[m[1].toLowerCase()], y = +m[2];
      out.push({ t: `${y}-${pad2(mo)}`, kind: 'month', raw: m[0], y, m: mo }); i += m[0].length; continue;
    }
    if ((m = tok.mag.exec(rest))) {
      const label = m[1];
      out.push({ t: `${label.toLowerCase()}${m[2]}`, kind: 'word', raw: m[0], abbrev: true });
      out.push({ t: `NUM:${m[2]}`, kind: 'num', raw: m[2], value: +m[2], label });
      i += m[0].length; continue;
    }
    if ((m = tok.lab.exec(rest))) {
      const label = m[1], v = m[2];
      out.push({ t: label.toLowerCase(), kind: 'word', raw: label, abbrev: true });
      out.push({ t: `${label.toLowerCase()}=${v}`, kind: 'word', raw: m[0], abbrev: true });
      out.push({ t: `NUM:${parseFloat(v)}`, kind: 'num', raw: v, value: parseFloat(v), label });
      i += m[0].length; continue;
    }
    if ((m = tok.numUnit.exec(rest))) {
      const unit = tok.units.get(m[2].toLowerCase()) || m[2];
      out.push({ t: `${m[1]}${unit.toLowerCase()}`, kind: 'word', raw: m[0], abbrev: true });
      out.push({ t: `NUM:${+m[1]}`, kind: 'num', raw: m[1], value: +m[1], unit });
      i += m[0].length; continue;
    }
    if ((m = tok.num.exec(rest))) {
      const v = +m[1].replace(/,/g, '');
      out.push({ t: `NUM:${v}`, kind: 'num', raw: m[1], value: v });
      i += m[0].length; continue;
    }
    if ((m = tok.word.exec(s.slice(i, i + 200)))) {
      const raw = m[0];
      const lower = raw.toLowerCase();
      let t;
      if (raw.includes('-')) t = lower;                   // hyphenated words kept whole
      else if (isAbbrevWord(raw)) t = lower;              // SSN, Kp, Mw: not stemmed
      else t = stem(lower);
      out.push({ t, kind: 'word', raw, lower });
      i += raw.length; continue;
    }
    i++;
  }
  return out;
}

const ROOT = path.join(__dirname, '..');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pct = x => `${Math.round(x * 100)}%`;
const WAY_BACK = 'Full page: read_page again with mode "full".';

// -- configuration --

const GLOSSARY_TYPES = new Set(['synonym', 'alias', 'abbreviation', 'related', 'ambiguous']);

/** Check a glossary against its schema. Returns a list of problems (empty = fine). */
function checkGlossary(g) {
  const bad = [];
  if (!g || typeof g !== 'object') return ['not an object'];
  if (!Number.isInteger(g.version) || g.version < 1) bad.push('version must be a whole number from 1');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(g.dated || '')) bad.push('dated must be YYYY-MM-DD');
  if (!Array.isArray(g.entries)) return bad.concat('entries must be a list');
  const ids = new Set();
  for (const e of g.entries) {
    const at = `entry ${e && e.id}`;
    if (!e || !e.id || ids.has(e.id)) { bad.push(`${at}: missing or repeated id`); continue; }
    ids.add(e.id);
    if (!GLOSSARY_TYPES.has(e.type)) bad.push(`${at}: unknown type ${e.type}`);
    if (!e.term || typeof e.term !== 'string') bad.push(`${at}: needs a term`);
    if ((e.type === 'synonym' || e.type === 'alias' || e.type === 'related') && !(Array.isArray(e.targets) && e.targets.length)) bad.push(`${at}: needs targets`);
    if (e.type === 'abbreviation' && (typeof e.expands_to !== 'string' || typeof e.unambiguous !== 'boolean')) bad.push(`${at}: needs expands_to and unambiguous`);
    if (e.type === 'ambiguous' && !(Array.isArray(e.meanings) && e.meanings.length >= 2)) bad.push(`${at}: needs two or more meanings`);
    if (e.type === 'related' && !e.why) bad.push(`${at}: needs a why`);
  }
  return bad;
}

/** Load the locked settings and the glossary. The hashes are of the files' bytes. */
function loadConfig({ settingsPath = path.join(ROOT, 'library', 'skimmer-settings.json'),
  glossaryPath = path.join(ROOT, 'library', 'glossary.json') } = {}) {
  const sBytes = fs.readFileSync(settingsPath), gBytes = fs.readFileSync(glossaryPath);
  const settings = JSON.parse(sBytes.toString('utf8')), glossary = JSON.parse(gBytes.toString('utf8'));
  const problems = checkGlossary(glossary);
  if (problems.length) throw new Error(`glossary invalid: ${problems.join('; ')}`);
  if (glossary.version !== settings.glossary_version) throw new Error(`settings expect glossary version ${settings.glossary_version}, found ${glossary.version}`);
  return { settings, settings_hash: sha256(sBytes), glossary, glossary_version: glossary.version, glossary_hash: sha256(gBytes) };
}

// -- concepts from looking_for --

function formTokens(form, settings) { return tokenize(form, settings).map(t => t.t); }

/** Find a token sequence inside a token list. Returns the number of times it appears. */
function countSeq(toks, seq, from = 0) {
  if (!seq.length) return 0;
  let n = 0;
  outer: for (let i = from; i + seq.length <= toks.length; i++) {
    for (let k = 0; k < seq.length; k++) if (toks[i + k].t !== seq[k]) continue outer;
    n++;
  }
  return n;
}

/**
 * Turn looking_for into concepts. Each concept: { key, label, forms: [{seq}|{exact}], via }.
 * Synonyms, aliases and unambiguous abbreviations join one concept. Related and
 * ambiguous terms never join, never count. An ambiguous term in the question is set aside.
 */
function buildConcepts(lookingFor, cfg) {
  const { settings, glossary } = cfg;
  const stop = new Set(settings.stop_words);
  const q = tokenize(lookingFor, settings);
  const used = new Array(q.length).fill(false);
  const concepts = [], ignored = [];
  const groups = [];
  for (const e of glossary.entries) {
    if (e.type === 'synonym' || e.type === 'alias') {
      groups.push({ e, forms: [e.term, ...e.targets].map(f => ({ text: f, seq: formTokens(f, settings) })) });
    } else if (e.type === 'abbreviation' && e.unambiguous) {
      groups.push({ e, forms: [{ text: e.term, exact: e.term }, { text: e.expands_to, seq: formTokens(e.expands_to, settings) }] });
    }
  }
  // longest forms first, so "international sunspot number" wins over "sunspot number"
  const cands = [];
  for (const g of groups) for (const f of g.forms) cands.push({ g, f, len: f.seq ? f.seq.length : 1 });
  cands.sort((a, b) => b.len - a.len || a.g.e.id.localeCompare(b.g.e.id));
  const have = new Map();
  for (const c of cands) {
    for (let i = 0; i < q.length; i++) {
      let hit = false, len = 0;
      if (c.f.exact) { hit = !used[i] && q[i].raw === c.f.exact; len = 1; }
      else {
        len = c.f.seq.length; hit = i + len <= q.length;
        for (let k = 0; hit && k < len; k++) if (used[i + k] || q[i + k].t !== c.f.seq[k]) hit = false;
      }
      if (!hit) continue;
      for (let k = 0; k < len; k++) used[i + k] = true;
      if (!have.has(c.g.e.id)) {
        const con = { key: c.g.e.id, label: c.g.e.term, forms: c.g.forms, via: c.g.e.type };
        have.set(c.g.e.id, con); concepts.push(con);
      }
    }
  }
  // ambiguous terms in the question: set aside, never expanded
  const amb = glossary.entries.filter(e => e.type === 'ambiguous' || (e.type === 'abbreviation' && !e.unambiguous));
  for (let i = 0; i < q.length; i++) {
    if (used[i]) continue;
    const a = amb.find(e => q[i].raw === e.term);
    if (a) { used[i] = true; ignored.push(a.term); }
  }
  // every other content word is its own concept; words that only say what kind of
  // statement is wanted (observed, forecast...) are checked as kind, not counted as topic
  const kindWords = new Set([].concat(...Object.values(settings.kind_cues)).filter(w => !w.includes(' ')));
  const seen = new Set(concepts.flatMap(c => c.forms.filter(f => f.seq && f.seq.length === 1).map(f => f.seq[0])));
  for (let i = 0; i < q.length; i++) {
    const t = q[i];
    if (used[i] || t.kind !== 'word' || t.quantityPart) continue;
    if (stop.has((t.lower || t.raw).toLowerCase()) || kindWords.has((t.lower || t.raw).toLowerCase())) continue;
    if (/\d|=/.test(t.t) || seen.has(t.t)) continue;
    seen.add(t.t);
    concepts.push({ key: `w:${t.t}`, label: (t.lower || t.raw.toLowerCase()), forms: [{ text: t.raw, seq: [t.t] }], via: 'word' });
  }
  return { concepts, ignored, qTokens: q };
}

/** What the question asks about dates, quantities and kind of statement. */
function questionNeeds(lookingFor, qTokens, request, settings) {
  const days = qTokens.filter(t => t.kind === 'date');
  const months = qTokens.filter(t => t.kind === 'month');
  const ranges = [];
  const withYear = days.filter(d => !d.noYear).map(d => d.t).sort();
  if (withYear.length >= 2) ranges.push({ from: withYear[0], to: withYear[withYear.length - 1] });
  else if (withYear.length === 1) ranges.push({ from: withYear[0], to: withYear[0] });
  for (const d of days.filter(x => x.noYear)) ranges.push({ md: d.t.slice(3) });
  for (const m of months) {
    const last = new Date(Date.UTC(m.y, m.m, 0)).getUTCDate();
    ranges.push({ from: `${m.t}-01`, to: `${m.t}-${String(last).padStart(2, '0')}` });
  }
  if (request && request.rows && request.rows.from && request.rows.to) ranges.push({ from: request.rows.from, to: request.rows.to });
  const labels = new Set();
  for (const t of qTokens) if (t.kind === 'num' && (t.label || t.unit)) labels.add(t.label || t.unit);
  const lowerWords = qTokens.filter(t => t.kind === 'word').map(t => (t.lower || t.raw).toLowerCase());
  for (const w of lowerWords) for (const l of (settings.quantity_words[w] || [])) labels.add(l);
  const text = clean(lookingFor).toLowerCase();
  const has = list => list.some(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
  const wantObs = has(settings.kind_cues.observation), wantFc = has(settings.kind_cues.forecast);
  const want = wantObs && !wantFc ? 'observation' : wantFc && !wantObs ? 'forecast' : null;
  return { ranges, labels, want };
}

function dateHit(tok, ranges) {
  for (const r of ranges) {
    if (r.md) { if (tok.kind === 'date' && tok.t.slice(5) === r.md) return true; continue; }
    if (tok.kind === 'date') {
      if (tok.noYear) { const md = tok.t.slice(3); if (md >= r.from.slice(5) && md <= r.to.slice(5)) return true; }
      else if (tok.t >= r.from && tok.t <= r.to) return true;
    } else if (tok.kind === 'month') {
      if (`${tok.t}-31` >= r.from && `${tok.t}-01` <= r.to) return true;
    }
  }
  return false;
}

function kindOf(lowerText, settings) {
  const k = settings.kind_cues;
  const has = list => list.some(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lowerText));
  if (has(k.forecast)) return 'forecast';
  if (has(k.observation)) return 'observation';
  if (has(k.explanation)) return 'explanation';
  if (has(k.reference)) return 'reference';
  return null;
}

// -- the result record and hand-off --

function baseResult(page, cfg, cap) {
  return {
    outcome: null, reasons: [], hand_off: '', chars_in: typeof page.text === 'string' ? page.text.length : null,
    chars_out: 0, cap, cut: null, retrieval: page.retrieval || 'full', partial_reason: page.partial_reason || '',
    kept: [], rows: null, coverage: null,
    page_sha256: page.sha256 || (typeof page.text === 'string' ? sha256(page.text) : null),
    fetched_at: page.fetched_at || null, address: page.final || page.address || null,
    skimmer_version: cfg.settings.skimmer_version, settings_hash: cfg.settings_hash, glossary_version: cfg.glossary_version,
    error: null,
  };
}

function retrievalText(r) { return `retrieval ${r.retrieval}${r.retrieval === 'partial' && r.partial_reason ? ` (${r.partial_reason})` : ''}`; }
const h12 = r => (r.page_sha256 || '').slice(0, 12);

function finish(r) { r.chars_out = r.hand_off.length; return r; }

/** PASSTHROUGH: the reader's own labelled cut, inside the cap. */
function passthrough(page, cfg, cap, label, code, extra = {}) {
  const r = Object.assign(baseResult(page, cfg, cap), extra);
  r.outcome = 'PASSTHROUGH';
  r.reasons = Array.from(new Set([...(extra.reasons || []), code]));
  const text = typeof page.text === 'string' ? page.text : (extra.headText || '');
  const total = typeof page.text === 'string' ? page.text.length : (page.chars || null);
  const tail = label === 'mode full' ? '' : `\n\n${WAY_BACK}${r.retrieval === 'partial' ? ' The frozen copy is partial.' : ''}`;
  const head0 = `PAGE ${r.address || '(no address)'} (${page.type || 'unknown type'}) PASSTHROUGH (${label}), ${retrievalText(r)}, fetched ${r.fetched_at || 'unknown'}, sha256 ${h12(r)}.`;
  let head = head0, room = cap - head.length - 2 - tail.length;
  let body = text;
  if (body.length > room) {
    const cutHead = ` Cut to its first ${fmt(Math.max(0, room - 80))} of ${fmt(total ?? body.length)} characters.`;
    head = head0 + cutHead;
    room = cap - head.length - 2 - tail.length;
    body = body.slice(0, Math.max(0, room));
    r.cut = `first ${body.length} of ${total ?? text.length} characters`;
    head = head0 + ` Cut to its first ${fmt(body.length)} of ${fmt(total ?? text.length)} characters.`;
  }
  r.hand_off = `${head}\n\n${body}${tail}`;
  if (r.hand_off.length > cap) r.hand_off = r.hand_off.slice(0, cap); // cannot happen; belt and braces
  return finish(r);
}

function unavailable(page, cfg, cap) {
  const r = baseResult(page, cfg, cap);
  r.outcome = 'UNAVAILABLE'; r.reasons = ['READER_FAILED'];
  r.hand_off = `PAGE NOT AVAILABLE: ${String(page.error || 'the reader returned no text').slice(0, 300)}`;
  return finish(r);
}

// -- skim --

/**
 * skim(page, request, config, opts) -> Promise<result>
 *  page:    { address, final, type, status, fetched_at, sha256, bytes_received, retrieval, partial_reason, text | path, error }
 *  request: { looking_for, rows: { from, to, columns, where }, mode: 'skim'|'full' }
 *  config:  from loadConfig()
 *  opts:    { cap, logFile, order_id, failAt (tests only: a step name that throws), now }
 */
async function skim(page, request, cfg, opts = {}) {
  const cap = opts.cap || cfg.settings.cap.default_chars;
  request = request || {};
  let result;
  try {
    if (!page || page.ok === false || page.error || (typeof page.text !== 'string' && !page.path)) result = unavailable(page || {}, cfg, cap);
    else result = await skimInner(page, request, cfg, cap, opts);
    if (result.hand_off.length > cap) {
      const over = result.hand_off.length;
      result = passthrough(page, cfg, cap, 'skimmer failed (output over the cap)', 'SKIMMER_FAILED', { error: `hand-off ${over} > cap ${cap}` });
    }
  } catch (e) {
    const kind = e && e.name === 'TimeoutError' ? 'SKIMMER_TIMEOUT' : 'SKIMMER_FAILED';
    const label = `SKIMMER FAILED: ${e && e.name || 'Error'}`;
    let headText = '';
    if (typeof page.text !== 'string' && page.path) { try { headText = readHead(page.path, cap); } catch { headText = ''; } }
    result = passthrough(page, cfg, cap, label, kind, { error: String(e && e.message || e).slice(0, 300), headText });
  }
  if (opts.logFile) writeLog(opts.logFile, result, opts);
  return result;
}

function readHead(file, chars) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(chars * 4); const n = fs.readSync(fd, b, 0, b.length, 0); return b.subarray(0, n).toString('utf8').slice(0, chars); }
  finally { fs.closeSync(fd); }
}

function writeLog(file, r, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    at: new Date((opts.now || Date.now)()).toISOString(), order_id: opts.order_id || null, address: r.address,
    page_sha256: r.page_sha256, outcome: r.outcome, reasons: r.reasons, chars_in: r.chars_in, chars_out: r.chars_out,
    error: r.error, skimmer_version: r.skimmer_version, settings_hash: r.settings_hash, glossary_version: r.glossary_version,
  }) + '\n');
}

async function skimInner(page, request, cfg, cap, opts) {
  const S = cfg.settings;
  const step = name => { if (opts.failAt === name) throw new Error(`forced failure at ${name}`); };
  const now = opts.now || Date.now;

  if (request.mode === 'full') return passthrough(page, cfg, cap, 'mode full', 'MODE_FULL');

  // -- tables --
  step('route');
  const parser = tables.findParser(page);
  if (parser) return tableHandOff(page, request, cfg, cap, parser, opts);
  const type = String(page.type || '').toLowerCase();
  const otherTable = /csv|json|xml|rss/.test(type);
  if (request.rows) {
    const r = baseResult(page, cfg, cap);
    r.outcome = 'ABSTAINED'; r.reasons = ['NO_PARSER'];
    const text = typeof page.text === 'string' ? page.text : readHead(page.path, S.cap.notes_chars);
    const head = `TABLE ${r.address} (${page.type || 'unknown type'}) ABSTAINED, ${retrievalText(r)}, sha256 ${h12(r)}. No parser for this table; rows not filtered.`;
    const first = firstLines(text, Math.min(S.cap.notes_chars, cap - head.length - WAY_BACK.length - 10));
    r.hand_off = `${head}\n${first}\n\n${WAY_BACK}`;
    return finish(r);
  }
  if (otherTable) return passthrough(page, cfg, cap, 'not prose and no parser', 'NOT_PROSE');

  // -- prose --
  const lookingFor = String(request.looking_for || '').trim().slice(0, 300);
  if (!lookingFor) return passthrough(page, cfg, cap, 'no looking_for given', 'NO_LOOKING_FOR');
  const text = typeof page.text === 'string' ? page.text : readHead(page.path, S.limits.prose_max_chars + 1);
  if (text.length > S.limits.prose_max_chars) return passthrough(page, cfg, cap, 'too long to skim', 'TOO_LONG_TO_SKIM');
  if (text.length < S.gate.pass_whole_under_chars) return passthrough(page, cfg, cap, 'short page', 'SHORT_PAGE');
  const deadline = now() + S.limits.prose_ms;
  const tick = () => { if (now() > deadline) { const e = new Error('prose skim took too long'); e.name = 'TimeoutError'; throw e; } };

  step('concepts');
  const { concepts, ignored } = buildConcepts(lookingFor, cfg);
  const needs = questionNeeds(lookingFor, tokenize(lookingFor, S), request, S);
  if (!concepts.length) return passthrough(page, cfg, cap, 'no concept left after stop words', 'NO_CONCEPTS');

  step('split');
  const all = splitSentences(text, S);
  tick();
  step('tokens');
  const seenText = new Map();
  let repeats = 0;
  for (const s of all) {
    s.clean = clean(s.text).replace(/\s+/g, ' ').trim();
    s.toks = tokenize(s.text, S);
    s.lower = s.clean.toLowerCase();
    const prev = seenText.get(s.clean);
    if (prev !== undefined) { s.dupOf = prev; repeats++; } else seenText.set(s.clean, s.sid);
  }
  tick();
  const uniq = all.filter(s => s.dupOf === undefined && s.toks.some(t => t.kind === 'word'));
  if (!uniq.length) return passthrough(page, cfg, cap, 'no sentences left after cleaning', 'NO_SENTENCES');

  step('gate');
  const stop = new Set(S.stop_words);
  for (const s of uniq) {
    s.tf = concepts.map(c => c.forms.reduce((n, f) => n + (f.exact ? s.toks.filter(t => t.raw === f.exact).length : countSeq(s.toks, f.seq)), 0));
    s.len = Math.max(1, s.toks.filter(t => t.kind !== 'word' || !stop.has(t.lower || '')).length);
  }
  const found = concepts.map((c, k) => uniq.some(s => s.tf[k] > 0));
  const nFound = found.filter(Boolean).length;
  const coverage = nFound / concepts.length;
  const reasons = [];
  // ambiguous-only: a missing concept that the page names only through an ambiguous term
  const ambEntries = cfg.glossary.entries.filter(e => e.type === 'ambiguous');
  const pageRaw = new Set(uniq.flatMap(s => s.toks.map(t => t.raw)));
  concepts.forEach((c, k) => {
    if (found[k]) return;
    const names = c.forms.map(f => f.text.toLowerCase()).concat(c.label.toLowerCase());
    if (ambEntries.some(e => pageRaw.has(e.term) && e.meanings.some(m => names.includes(m.toLowerCase())))) reasons.push('AMBIGUOUS_ONLY');
  });
  // related terms seen: shown, never counted
  const related = [];
  for (const e of cfg.glossary.entries.filter(x => x.type === 'related')) {
    const sides = [e.term, ...e.targets];
    const qHas = concepts.some(c => c.forms.some(f => sides.some(sd => sd.toLowerCase() === f.text.toLowerCase())) || sides.some(sd => sd.toLowerCase() === c.label));
    if (!qHas) continue;
    for (const sd of sides) {
      if (concepts.some(c => c.forms.some(f => f.text.toLowerCase() === sd.toLowerCase()) || c.label === sd.toLowerCase())) continue;
      const seq = formTokens(sd, S);
      if (uniq.some(s => countSeq(s.toks, seq) > 0) && !related.includes(sd.toLowerCase())) related.push(sd.toLowerCase());
    }
  }
  // context checks
  const together = (() => {
    for (let i = 0; i < uniq.length; i++) {
      const win = uniq.slice(Math.max(0, i - 1), i + 2);
      const n = concepts.filter((c, k) => win.some(s => s.tf[k] > 0)).length;
      if (n >= S.together.min_concepts) return true;
    }
    return false;
  })();
  const dateAsked = needs.ranges.length > 0;
  const dateOk = dateAsked && uniq.some(s => s.toks.some(t => dateHit(t, needs.ranges)));
  const qtyAsked = needs.labels.size > 0;
  const numOk = qtyAsked && uniq.some(s => s.toks.some(t => t.kind === 'num' && needs.labels.has(t.label || t.unit)));
  let kindCode = 'NO_KIND_ASKED';
  if (needs.want) {
    const matching = uniq.filter(s => s.tf.some(x => x > 0));
    // only sentences that carry a cue vote; most of them must be the other kind for a mismatch
    const kinds = matching.map(s => kindOf(s.lower, S)).filter(k => k === 'forecast' || k === 'observation');
    const other = needs.want === 'observation' ? 'forecast' : 'observation';
    kindCode = kinds.length && kinds.filter(k => k === other).length * 2 > kinds.length ? 'KIND_MISMATCH' : 'KIND_MATCH';
  }
  const ctx = [together ? 'TOGETHER_OK' : 'TOGETHER_WEAK',
    dateAsked ? (dateOk ? 'DATE_IN_RANGE' : 'DATE_OUTSIDE') : 'NO_DATE_ASKED',
    qtyAsked ? (numOk ? 'NUMBER_FOUND' : 'NUMBER_MISSING') : 'NO_NUMBER_ASKED', kindCode];
  const covCode = coverage < S.gate.skip_below ? 'COVERAGE_LOW' : coverage > S.gate.wide_above ? 'COVERAGE_HIGH' : 'COVERAGE_MID';
  const coverageRec = {
    score: Math.round(coverage * 1e6) / 1e6, found: concepts.filter((c, k) => found[k]).map(c => c.label),
    missing: concepts.filter((c, k) => !found[k]).map(c => c.label), ignored, related_seen: related, context: ctx,
  };

  let tier, flags = [];
  if (concepts.length < S.gate.min_concepts) { tier = 'mid'; reasons.push('FEW_CONCEPTS'); }
  else if (coverage < S.gate.skip_below) {
    const rescue = dateAsked && qtyAsked && uniq.some(s => s.tf.some(x => x > 0) && s.toks.some(t => dateHit(t, needs.ranges)) &&
      s.toks.some(t => t.kind === 'num' && needs.labels.has(t.label || t.unit)));
    if (rescue) { tier = 'mid'; flags.push('RESCUED'); } else tier = 'skip';
  } else if (coverage > S.gate.wide_above) {
    if (together && kindCode !== 'KIND_MISMATCH') tier = 'wide';
    else { tier = 'mid'; flags.push('FLAGGED'); }
  } else tier = 'mid';
  const allReasons = Array.from(new Set([covCode, ...ctx, ...reasons, ...flags]));

  if (tier === 'skip') {
    const r = baseResult(page, cfg, cap);
    r.outcome = 'SKIPPED'; r.reasons = allReasons; r.coverage = coverageRec;
    r.hand_off = `PAGE NOT SHOWN (SKIPPED), ${retrievalText(r)}, sha256 ${h12(r)}. Coverage ${pct(coverage)} (found: ${list(coverageRec.found)}; missing: ${list(coverageRec.missing)}). Reasons: ${allReasons.join(', ')}. If you think it holds the answer, read_page again with mode "full".`;
    if (r.hand_off.length > cap) r.hand_off = r.hand_off.slice(0, cap);
    return finish(r);
  }

  step('rank');
  tick();
  const { k1, b, round_decimals: dp } = S.bm25;
  const N = uniq.length;
  const avgdl = uniq.reduce((a, s) => a + s.len, 0) / N;
  const idf = concepts.map((c, k) => { const n = uniq.filter(s => s.tf[k] > 0).length; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); });
  const scale = 10 ** dp;
  for (const s of uniq) {
    let sc = 0;
    concepts.forEach((c, k) => { const tf = s.tf[k]; if (tf > 0) sc += idf[k] * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * s.len / avgdl)); });
    s.score = Math.round(sc * scale) / scale;
  }
  const ranked = uniq.filter(s => s.score > 0).sort((a, c) => c.score - a.score || a.sid - c.sid);
  const want = tier === 'wide' ? S.skim.wide_sentences : S.skim.mid_sentences;
  let chosen = ranked.slice(0, want);
  if (!chosen.length) return passthrough(page, cfg, cap, 'no sentence matched the question', 'NO_MATCHING_SENTENCES', { reasons: allReasons, coverage: coverageRec });

  step('select');
  const outcomeWord = 'SKIMMED';
  const totalChosen = chosen.length;
  const build = (chosenList, cutSingle = null) => {
    const keep = new Set();
    for (const s of chosenList) {
      keep.add(s.sid);
      if (!cutSingle) {
        for (let d = 1; d <= S.skim.neighbours_before; d++) if (s.sid - d >= 1) keep.add(s.sid - d);
        for (let d = 1; d <= S.skim.neighbours_after; d++) if (s.sid + d <= all.length) keep.add(s.sid + d);
      }
    }
    const sids = [...keep].sort((x, y) => x - y);
    const blocks = [];
    for (const sid of sids) { const last = blocks[blocks.length - 1]; if (last && sid === last[last.length - 1] + 1) last.push(sid); else blocks.push([sid]); }
    const lines = blocks.map(bl => bl.map(sid => `[s${sid}] ${all[sid - 1].text}`).join('\n'));
    let body = lines.join(`\n${ELLIPSIS}\n`);
    if (cutSingle !== null) body = body.slice(0, cutSingle) + ' [cut]';
    const keptChars = sids.reduce((a, sid) => a + all[sid - 1].text.length, 0);
    const cutNote = chosenList.length < totalChosen ? ` CUT: kept ${chosenList.length} of ${totalChosen} chosen sentences to fit ${fmt(cap)} characters.` : cutSingle !== null ? ` CUT: one sentence cut to fit ${fmt(cap)} characters.` : '';
    const flagNote = flags.length ? ` Flags: ${flags.join(', ')}.` : '';
    const relNote = related.length ? ` Related terms seen: ${related.join(', ')}.` : '';
    let head = `PAGE ${page.final || page.address} (${page.type || 'unknown type'}) ${outcomeWord}${tier === 'wide' ? ' wide' : ''}, ${retrievalText({ retrieval: page.retrieval || 'full', partial_reason: page.partial_reason })}, fetched ${page.fetched_at || 'unknown'}, sha256 ${(page.sha256 || sha256(text)).slice(0, 12)}. Coverage ${pct(coverage)} (found: ${list(coverageRec.found)}; missing: ${list(coverageRec.missing)}).${relNote}${flagNote} Kept ${chosenList.length} of ${fmt(all.length)} sentences, ${fmt(keptChars)} of ${fmt(text.length)} characters.${cutNote} ${WAY_BACK}`;
    if (head.length > S.cap.reserve_header_chars - 120) head = head.slice(0, S.cap.reserve_header_chars - 121) + ELLIPSIS;
    const countLine = `[end of skim: ${chosenList.length} chosen, ${sids.length - chosenList.length} neighbours, ${blocks.length} block(s)${repeats ? `, ${repeats} repeated sentence(s) ignored` : ''}]`;
    return { text: `${head}\n\n${body}\n\n${countLine}`, sids };
  };
  step('cap');
  let out = build(chosen);
  while (out.text.length > cap && chosen.length > 1) { chosen = chosen.slice(0, -1); out = build(chosen); }
  let cutSingle = null;
  if (out.text.length > cap) {
    // last resort: the single chosen sentence alone, cut and marked
    const probe = build(chosen, 0);
    const room = cap - probe.text.length;
    cutSingle = Math.max(0, room);
    out = build(chosen, cutSingle);
  }
  const r = baseResult(page, cfg, cap);
  r.outcome = 'SKIMMED'; r.reasons = allReasons; r.coverage = coverageRec; r.hand_off = out.text;
  r.kept = out.sids.map(sid => ({ sid, start: all[sid - 1].start, end: all[sid - 1].end }));
  r.cut = chosen.length < totalChosen ? `kept ${chosen.length} of ${totalChosen} chosen sentences` : cutSingle !== null ? 'one sentence cut' : null;
  r.tier = tier; r.flags = flags; r.sentences = all.length; r.repeats = repeats;
  r.chosen = chosen.map(s => ({ sid: s.sid, score: s.score }));
  return finish(r);
}

function list(a) { return a.length ? a.join(', ') : 'none'; }
function firstLines(text, chars) {
  if (text.length <= chars) return text;
  const cut = text.lastIndexOf('\n', chars);
  return text.slice(0, cut > 0 ? cut : chars);
}

// -- tables --

async function tableHandOff(page, request, cfg, cap, parser, opts) {
  const S = cfg.settings;
  if (opts.failAt === 'table') throw new Error('forced failure at table');
  const reserve = S.cap.reserve_header_chars, notesRoom = S.cap.notes_chars;
  const t = await tables.filterTable(page, parser, request.rows || null, S, { rowBudget: cap - reserve - notesRoom, now: opts.now });
  const r = baseResult(page, cfg, cap);
  r.outcome = t.outcome;
  r.reasons = t.reasons;
  r.rows = { total: t.total, matched: t.matched, outside: t.outside, unparsed: t.unparsed, first_date: t.minDate, last_date: t.maxDate,
    unparsed_lines: t.unparsedLines.slice(0, 50), unparsed_why: t.unparsedWhy, parser: parser.id, direction: t.direction };
  if (r.retrieval === 'partial') r.reasons = r.reasons.concat('PARTIAL_RETRIEVAL');
  // notes: the file's own description lines, then the header row, inside the notes room
  let notes = t.notes.join('\n');
  let notesCut = false;
  if (notes.length > notesRoom) { notes = firstLines(notes, notesRoom - 60); notesCut = true; }
  const parts = [];
  if (notes) parts.push(notes);
  if (notesCut) parts.push(`[notes cut to ${fmt(notesRoom)} characters]`);
  if (t.header) parts.push(t.header);
  const span = t.minDate ? `file runs ${t.minDate} to ${t.maxDate}` : 'no dated rows seen';
  const addr = page.final || page.address;
  if (t.outcome === 'ABSTAINED') {
    const asked = request.rows ? ` Rows asked ${request.rows.from} to ${request.rows.to};` : '';
    const head = `TABLE ${addr} (${page.type || 'unknown type'}) ABSTAINED, ${retrievalText(r)}, sha256 ${h12(r)}.${asked} ${t.why}. ${fmt(t.total)} rows read: ${fmt(t.unparsed)} unparsed; ${span}. No rows passed on.`;
    r.hand_off = `${head}\n${parts.join('\n')}\n\n${WAY_BACK}${r.retrieval === 'partial' ? ' The frozen copy is partial.' : ''}`;
    r.why = t.why;
    if (r.hand_off.length > cap) r.hand_off = r.hand_off.slice(0, cap);
    return finish(r);
  }
  const rows = t.kept;
  const lead = request.rows
    ? `${fmt(t.matched)} of ${fmt(t.total)} rows match ${request.rows.from} to ${request.rows.to}${request.rows.where ? ` and ${request.rows.where.column} ${request.rows.where.op} ${request.rows.where.value}` : ''}`
    : `no range asked, showing the latest ${rows.length} of ${fmt(t.total - t.unparsed)} rows`;
  const head = `TABLE ${addr} (${page.type || 'unknown type'}) FILTERED, ${retrievalText(r)}, fetched ${r.fetched_at || 'unknown'}, sha256 ${h12(r)}. ${lead}; ${fmt(t.unparsed)} unparsed; ${span}.`;
  const fixed = `${head}\n${parts.join('\n')}`;
  // whole rows only, in file order, until the next one won't fit
  const tailFor = (n, lastDate) => (n < t.matched && request.rows)
    ? `\n[showing rows 1 to ${fmt(n)} of ${fmt(t.matched)} matched, last date shown ${lastDate}; ask again with a narrower range.]`
    : `\n[end of table: ${fmt(n)} row(s) shown]`;
  let body = '', n = 0;
  for (const row of rows) {
    const next = body + '\n' + row.text;
    if ((fixed + next + tailFor(n + 1, row.date)).length > cap) break;
    body = next; n++;
  }
  if (n === 0 && rows.length && request.rows) {
    // a single row longer than all the room left: cut it, marked
    const room = cap - (fixed + tailFor(1, rows[0].date) + '\n [cut]').length;
    body = '\n' + rows[0].text.slice(0, Math.max(0, room)) + ' [cut]'; n = 1;
    r.cut = 'one row cut';
  }
  const lastDate = n ? rows[n - 1].date : null;
  r.hand_off = `${fixed}${body}${tailFor(n, lastDate)}`;
  if (n < t.matched && request.rows) r.cut = r.cut || `showing rows 1 to ${n} of ${t.matched} matched`;
  r.rows.shown = n;
  return finish(r);
}

module.exports = { skim, loadConfig, checkGlossary, buildConcepts, questionNeeds, countSeq, WAY_BACK,
  clean, splitSentences, tokenize, tokenPatterns, validDate, isAbbrevWord };
