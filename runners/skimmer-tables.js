'use strict';
// ══════════════════════════════════════════════════════════════════════
// PAGE SKIMMER — table parsers and the streaming date filter (Phase 1, 2026-11-17)
//
// Five named sources, one parser each, no guessing. Rows go out exactly as
// the site wrote them. Nothing is averaged, rounded, filled or thrown away:
// every line is a note, the header, a parsed row or a COUNTED unparsed row.
// A range is given only when it can be verified; otherwise the filter abstains.
// ══════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const zlib = require('node:zlib');
const readline = require('node:readline');

class LayoutError extends Error { constructor(msg) { super(msg); this.name = 'LayoutError'; } }
class TimeoutError extends Error { constructor(msg) { super(msg); this.name = 'TimeoutError'; } }

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDay(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return m >= 1 && m <= 12 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const pad2 = n => String(n).padStart(2, '0');
function dayFromParts(y, m, d) {
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return null;
  if (!validDay(+y, +m, +d)) return null;
  return `${y}-${pad2(+m)}-${pad2(+d)}`;
}

/** A quoted-CSV field splitter for one complete record (quotes, doubled quotes, line breaks inside quotes). */
function splitCsvRecord(rec, delim = ',') {
  const fields = [], raws = [];
  let i = 0; const n = rec.length;
  while (true) {
    let start = i, val = '';
    if (rec[i] === '"') {
      i++;
      while (i < n) {
        if (rec[i] === '"') { if (rec[i + 1] === '"') { val += '"'; i += 2; continue; } i++; break; }
        val += rec[i++];
      }
      if (i < n && rec[i] !== delim) throw new LayoutError('text after a closing quote');
    } else {
      while (i < n && rec[i] !== delim) val += rec[i++];
    }
    fields.push(val); raws.push(rec.slice(start, i));
    if (i >= n) break;
    i++; // the delimiter
    if (i === n) { fields.push(''); raws.push(''); break; }
  }
  return { fields, raws };
}
/** Is a CSV record still open (an odd number of quotes)? */
const quoteOpen = s => { let q = 0; for (let i = 0; i < s.length; i++) if (s[i] === '"') q++; return q % 2 === 1; };

/** A small JSON reader that keeps every number and string exactly as written. */
function parseRawJson(text) {
  let i = 0; const s = text;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function val() {
    ws();
    const c = s[i];
    if (c === '{') {
      i++; const obj = { __type: 'obj', keys: [], map: new Map() }; ws();
      if (s[i] === '}') { i++; return obj; }
      while (true) {
        ws(); const k = val(); if (!k || k.__type !== 'prim' || typeof k.v !== 'string') throw new LayoutError('bad JSON key');
        ws(); if (s[i] !== ':') throw new LayoutError('bad JSON'); i++;
        const v = val(); obj.keys.push(k.v); obj.map.set(k.v, v); ws();
        if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return obj; } throw new LayoutError('bad JSON object');
      }
    }
    if (c === '[') {
      i++; const arr = { __type: 'arr', items: [] }; ws();
      if (s[i] === ']') { i++; return arr; }
      while (true) {
        arr.items.push(val()); ws();
        if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return arr; } throw new LayoutError('bad JSON array');
      }
    }
    const start = i;
    if (c === '"') {
      i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
      i++; const raw = s.slice(start, i); return { __type: 'prim', raw, v: JSON.parse(raw) };
    }
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(s.slice(i, i + 40));
    if (!m) throw new LayoutError(`bad JSON value at ${i}`);
    i += m[0].length; return { __type: 'prim', raw: m[0], v: JSON.parse(m[0]) };
  }
  const v = val(); ws(); if (i < s.length) throw new LayoutError('text after the JSON');
  return v;
}

function hostOf(page) {
  try { return new URL(page.final || page.address).hostname.toLowerCase(); } catch { return ''; }
}
function urlOf(page) { try { return new URL(page.final || page.address); } catch { return null; } }
const onHost = (h, base) => h === base || h.endsWith('.' + base);

// ── the five sources ──────────────────────────────────────────────────
// Layouts are declared here, checked against frozen real files before use.

const PARSERS = [
  {
    id: 'gfz-kp-file', source: 'GFZ Kp file (Kp_ap_since_1932.txt)', kind: 'lines', delim: ' ',
    match: p => { const u = urlOf(p); return !!u && (onHost(u.hostname, 'gfz.de') || onHost(u.hostname, 'gfz-potsdam.de')) && /\/Kp_ap_since_1932\.txt$/.test(u.pathname); },
    names: ['YYYY', 'MM', 'DD', 'hh.h', 'hh._m', 'days', 'days_m', 'Kp', 'ap', 'D'],
    classify(line) {
      if (/^\s*$/.test(line)) return { type: 'blank' };
      if (line.startsWith('#')) return { type: 'note' };
      const f = line.trim().split(/\s+/);
      if (f.length !== this.names.length) return { type: 'unparsed', why: `expected ${this.names.length} fields, found ${f.length}` };
      const date = dayFromParts(f[0], f[1], f[2]);
      if (!date) return { type: 'unparsed', why: 'date did not parse' };
      return { type: 'row', date, fields: f, raws: f };
    },
  },
  {
    id: 'sidc-sn-daily', source: 'SIDC daily sunspot number (SN_d_tot_V2.0)', kind: 'lines', delim: null,
    match: p => { const u = urlOf(p); return !!u && onHost(u.hostname, 'sidc.be') && /\/SN_d_tot_V2\.0\.(csv|txt)$/i.test(u.pathname); },
    names: ['year', 'month', 'day', 'date_fraction', 'SN', 'std_dev', 'observations', 'definitive'],
    classify(line) {
      if (/^\s*$/.test(line)) return { type: 'blank' };
      if (line.startsWith('#')) return { type: 'note' };
      const semi = line.includes(';');
      const f = (semi ? line.split(';') : line.trim().split(/\s+/)).map(x => x.trim());
      if (f.length !== this.names.length) return { type: 'unparsed', why: `expected ${this.names.length} fields, found ${f.length}` };
      const date = dayFromParts(f[0], f[1], f[2]);
      if (!date) return { type: 'unparsed', why: 'date did not parse' };
      return { type: 'row', date, fields: f, raws: f, delim: semi ? ';' : ' ' };
    },
  },
  {
    id: 'usgs-fdsn-csv', source: 'USGS earthquake catalogue (fdsnws, format=csv)', kind: 'csv', delim: ',',
    match: p => { const u = urlOf(p); return !!u && u.hostname === 'earthquake.usgs.gov' && u.pathname.startsWith('/fdsnws/event/1/query') && /^csv$/i.test(u.searchParams.get('format') || ''); },
    headerStarts: ['time', 'latitude', 'longitude', 'depth', 'mag'], dateColumn: 'time',
    dateOf(v) { const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.exec(v); return m ? dayFromParts(m[1], m[2], m[3]) : null; },
  },
  {
    id: 'treasury-yield-csv', source: 'Treasury daily yield curve CSV', kind: 'csv', delim: ',',
    match: p => { const u = urlOf(p); return !!u && onHost(u.hostname, 'treasury.gov') && /daily-treasury-rates\.csv/i.test(u.pathname) && /daily_treasury_yield_curve/.test(u.search); },
    headerStarts: ['Date'], dateColumn: 'Date',
    // US slash dates are read here and nowhere else.
    dateOf(v) { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v); return m ? dayFromParts(m[3], m[1], m[2]) : null; },
  },
  {
    id: 'gfz-kp-json', source: 'GFZ Kp web service (kp.gfz.de/app/json)', kind: 'json',
    match: p => { const u = urlOf(p); return !!u && u.hostname === 'kp.gfz.de' && /^\/app\/json\/?$/.test(u.pathname); },
    fromJson(root) {
      if (root.__type !== 'obj' || !root.map.has('datetime')) throw new LayoutError('expected an object with a datetime list');
      const dt = root.map.get('datetime');
      if (dt.__type !== 'arr') throw new LayoutError('datetime is not a list');
      const cols = ['datetime'], lists = [dt];
      const notes = [];
      for (const k of root.keys) {
        if (k === 'datetime') continue;
        const v = root.map.get(k);
        if (v.__type === 'arr') {
          if (v.items.length !== dt.items.length) throw new LayoutError(`list ${k} has ${v.items.length} items, datetime has ${dt.items.length}`);
          cols.push(k); lists.push(v);
        } else notes.push(`${k}: ${rawText(v)}`);
      }
      const rows = dt.items.map((d, i) => {
        const raws = lists.map(l => rawText(l.items[i]));
        const v = d.__type === 'prim' && typeof d.v === 'string' ? d.v : '';
        const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(v);
        return { date: m ? dayFromParts(m[1], m[2], m[3]) : null, raws, fields: raws, line: raws.join(',') };
      });
      return { notes, names: cols, header: cols.join(','), rows };
    },
  },
  {
    id: 'noaa-swpc-json', source: 'NOAA SWPC JSON (list of lists)', kind: 'json',
    match: p => { const u = urlOf(p); return !!u && u.hostname === 'services.swpc.noaa.gov' && /^\/products\/[^/]+\.json$/.test(u.pathname); },
    fromJson(root) {
      if (root.__type !== 'arr' || !root.items.length) throw new LayoutError('expected a list of lists');
      const head = root.items[0];
      if (head.__type !== 'arr' || head.items.some(x => x.__type !== 'prim' || typeof x.v !== 'string')) throw new LayoutError('the first list is not a header of names');
      const names = head.items.map(x => x.v);
      const di = names.indexOf('time_tag');
      if (di < 0) throw new LayoutError('no time_tag column');
      const rows = root.items.slice(1).map(r => {
        if (r.__type !== 'arr' || r.items.length !== names.length) return { unparsed: true, why: 'row is not a list of the header\'s length', line: rawText(r) };
        const raws = r.items.map(rawText);
        const t = r.items[di].__type === 'prim' ? String(r.items[di].v) : '';
        const m = /^(\d{4})-(\d{2})-(\d{2})[ T]/.exec(t);
        return { date: m ? dayFromParts(m[1], m[2], m[3]) : null, raws, fields: raws, line: '[' + raws.join(',') + ']' };
      });
      return { notes: [], names, header: '[' + head.items.map(rawText).join(',') + ']', rows };
    },
  },
];

function rawText(v) {
  if (!v) return '';
  if (v.__type === 'prim') return v.raw;
  if (v.__type === 'arr') return '[' + v.items.map(rawText).join(',') + ']';
  return '{' + v.keys.map(k => JSON.stringify(k) + ':' + rawText(v.map.get(k))).join(',') + '}';
}

function findParser(page) { return PARSERS.find(p => p.match(page)) || null; }

/** Lines of a page, one at a time: from its text, or streamed from its frozen file (gzip unpacked as it goes). */
async function* pageLines(page) {
  if (typeof page.text === 'string') {
    const s = page.text; let i = 0;
    while (i <= s.length) {
      let j = s.indexOf('\n', i); if (j < 0) j = s.length;
      let line = s.slice(i, j); if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!(j === s.length && line === '' && i === s.length)) yield line;
      i = j + 1;
    }
    return;
  }
  if (!page.path) throw new Error('page has neither text nor path');
  let stream = fs.createReadStream(page.path);
  if (/\.gz$/i.test(page.path)) stream = stream.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

async function readAllText(page, limit) {
  if (typeof page.text === 'string') return page.text;
  let out = '';
  for await (const line of pageLines(page)) { out += (out ? '\n' : '') + line; if (out.length > limit) throw new LayoutError('too large to read as JSON'); }
  return out;
}

/**
 * Filter one table page. Never throws for a layout problem: it returns
 * { outcome: 'FILTERED' | 'ABSTAINED', why, ... } with every counter.
 * Throws only for real errors (and TimeoutError), which the caller turns into PASSTHROUGH.
 */
async function filterTable(page, parser, rowsReq, settings, opts = {}) {
  const deadline = (opts.now || Date.now)() + settings.limits.table_ms;
  const now = opts.now || Date.now;
  const lastN = settings.tables.default_last_rows;
  const budget = opts.rowBudget;                 // characters of rows we may hold
  const st = {
    parser: parser.id, total: 0, matched: 0, outside: 0, unparsed: 0, unparsedLines: [], unparsedWhy: {},
    first_date: null, last_date: null, minDate: null, maxDate: null, direction: 0, orderBrokenAt: null,
    firstMatchLine: null, lastMatchLine: null, notes: [], header: null, names: null,
    kept: [], keptChars: 0, keptFull: false, lastShownDate: null, recent: [], earliest: [],
  };
  // validate the request first
  let from = null, to = null, cols = null, where = null;
  const asked = !!rowsReq;
  if (asked) {
    if (!rowsReq.from || !rowsReq.to) return abstain(st, 'rows.from and rows.to are both needed');
    if (!ISO_DAY.test(rowsReq.from) || !ISO_DAY.test(rowsReq.to)) return abstain(st, 'rows.from and rows.to must be YYYY-MM-DD');
    from = rowsReq.from; to = rowsReq.to;
    if (from > to) return abstain(st, 'rows.from is after rows.to');
  }
  const unparsedAt = (lineNo, why) => {
    st.unparsed++; st.total++;
    if (st.unparsedLines.length < 100000) st.unparsedLines.push(lineNo);
    st.unparsedWhy[why] = (st.unparsedWhy[why] || 0) + 1;
  };
  let delimOut = parser.delim;
  const take = (row, lineNo) => {
    st.total++;
    const d = row.date;
    if (st.last_date !== null) {
      const dir = d > st.last_date ? 1 : d < st.last_date ? -1 : 0;
      if (dir !== 0) {
        if (st.direction === 0) st.direction = dir;
        else if (dir !== st.direction && st.orderBrokenAt === null) st.orderBrokenAt = lineNo;
      }
    }
    if (st.first_date === null) st.first_date = d;
    st.last_date = d;
    if (st.minDate === null || d < st.minDate) st.minDate = d;
    if (st.maxDate === null || d > st.maxDate) st.maxDate = d;
    let ok = true;
    if (asked) {
      ok = d >= from && d <= to;
      if (ok && where) ok = testWhere(row, where, st.names);
    }
    if (!ok) { st.outside++; return; }
    st.matched++;
    if (st.firstMatchLine === null) st.firstMatchLine = lineNo;
    st.lastMatchLine = lineNo;
    const text = render(row);
    if (asked) {
      if (!st.keptFull && (budget === undefined || st.keptChars + text.length + 1 <= budget)) {
        st.kept.push({ text, date: d }); st.keptChars += text.length + 1;
      } else st.keptFull = true;
    } else {
      st.recent.push({ text, date: d }); if (st.recent.length > lastN) st.recent.shift();
      if (st.earliest.length < lastN) st.earliest.push({ text, date: d });
    }
  };
  const render = row => {
    if (!cols) return row.line;
    const idx = cols.map(c => st.names.indexOf(c));
    const d = row.delim || delimOut || ',';
    return idx.map(k => row.raws[k]).join(d === ' ' ? '  ' : d);
  };
  const setNames = names => {
    st.names = names;
    if (asked && rowsReq.columns) {
      const bad = rowsReq.columns.filter(c => !names.includes(c));
      if (bad.length) throw new LayoutError(`unknown column(s): ${bad.join(', ')}`);
      cols = rowsReq.columns.slice();
    }
    if (asked && rowsReq.where) {
      const w = rowsReq.where;
      if (!names.includes(w.column)) throw new LayoutError(`unknown column in where: ${w.column}`);
      if (!['>=', '<=', '=', '>', '<'].includes(w.op) || typeof w.value !== 'number') throw new LayoutError('where needs one of >= <= = > < and a number');
      where = w;
    }
  };

  try {
    if (parser.kind === 'json') {
      const text = await readAllText(page, settings.limits.json_table_max_chars);
      if (text.length > settings.limits.json_table_max_chars) throw new LayoutError('too large to read as JSON');
      const t = parser.fromJson(parseRawJson(text));
      st.notes = t.notes; st.header = t.header; setNames(t.names);
      let lineNo = 1;
      for (const r of t.rows) {
        lineNo++;
        if ((lineNo & 1023) === 0 && now() > deadline) throw new TimeoutError('table filter took too long');
        if (r.unparsed || !r.date) unparsedAt(lineNo, r.why || 'date did not parse');
        else take(r, lineNo);
      }
    } else if (parser.kind === 'lines') {
      setNames(parser.names);
      st.header = null;
      let lineNo = 0;
      for await (const line of pageLines(page)) {
        lineNo++;
        if ((lineNo & 1023) === 0 && now() > deadline) throw new TimeoutError('table filter took too long');
        const c = parser.classify(line);
        if (c.type === 'blank') continue;
        if (c.type === 'note') { st.notes.push(line); continue; }
        if (c.type === 'unparsed') { unparsedAt(lineNo, c.why); continue; }
        if (c.delim) delimOut = c.delim;
        take({ date: c.date, fields: c.fields, raws: c.raws, line, delim: c.delim }, lineNo);
      }
    } else { // csv
      let lineNo = 0, recStart = 0, rec = null, dateIdx = -1;
      for await (const line of pageLines(page)) {
        lineNo++;
        if ((lineNo & 1023) === 0 && now() > deadline) throw new TimeoutError('table filter took too long');
        if (rec === null) { if (/^\s*$/.test(line)) continue; rec = line; recStart = lineNo; }
        else rec += '\n' + line;
        if (quoteOpen(rec)) continue;                     // a quoted field runs onto the next line
        const r = rec; rec = null;
        if (st.names === null) {
          const { fields } = splitCsvRecord(r, ',');
          const want = parser.headerStarts;
          if (want.some((w, k) => fields[k] !== w)) throw new LayoutError(`header differs: expected it to start ${want.join(',')}, found ${fields.slice(0, want.length).join(',')}`);
          st.header = r; setNames(fields); dateIdx = fields.indexOf(parser.dateColumn);
          continue;
        }
        let sp;
        try { sp = splitCsvRecord(r, ','); } catch { unparsedAt(recStart, 'bad quoting'); continue; }
        if (sp.fields.length !== st.names.length) { unparsedAt(recStart, `expected ${st.names.length} fields, found ${sp.fields.length}`); continue; }
        const date = parser.dateOf(sp.fields[dateIdx]);
        if (!date) { unparsedAt(recStart, 'date did not parse'); continue; }
        take({ date, fields: sp.fields, raws: sp.raws, line: r }, recStart);
      }
      if (rec !== null) unparsedAt(recStart, 'quoted field never closed');
      if (st.names === null) throw new LayoutError('no header row found');
    }
  } catch (e) {
    if (e instanceof LayoutError) return abstain(st, e.message, 'LAYOUT_MISMATCH');
    throw e;
  }

  const parsedRows = st.total - st.unparsed;
  if (!asked) {
    st.kept = st.direction < 0 ? st.earliest : st.recent;
    st.matched = parsedRows; st.outside = 0;
    if (parsedRows === 0) return abstain(st, 'no rows parsed', 'NO_ROWS_PARSED');
    return { ...st, outcome: 'FILTERED', reasons: ['NO_ROWS_ASKED'], why: null, shownMostRecent: true };
  }
  if (parsedRows === 0) return abstain(st, 'no rows parsed', 'NO_ROWS_PARSED');
  if (st.orderBrokenAt !== null) return abstain(st, `dates out of order at line ${st.orderBrokenAt}`, 'DATES_OUT_OF_ORDER');
  if (!(st.minDate <= from && st.maxDate >= to)) {
    return abstain(st, `rows seen run ${spanText(st)} only, so the range can't be verified`, 'RANGE_NOT_VERIFIED');
  }
  if (st.firstMatchLine !== null) {
    const inside = st.unparsedLines.filter(l => l > st.firstMatchLine && l < st.lastMatchLine);
    if (inside.length) return abstain(st, `unparsed line(s) ${inside.slice(0, 10).join(', ')}${inside.length > 10 ? ', …' : ''} sit between matched rows`, 'UNPARSED_BETWEEN_MATCHES', inside);
  }
  return { ...st, outcome: 'FILTERED', reasons: ['RANGE_VERIFIED'], why: null };
}

function spanText(st) {
  const a = st.direction < 0 ? st.last_date : st.first_date, b = st.direction < 0 ? st.first_date : st.last_date;
  return `${a} to ${b}`;
}

function abstain(st, why, code = 'ABSTAINED', lines = null) {
  return { ...st, kept: [], outcome: 'ABSTAINED', reasons: [code], why, unparsedInside: lines };
}

function testWhere(row, w, names) {
  const raw = row.fields[names.indexOf(w.column)];
  const v = Number(String(raw).replace(/^"|"$/g, ''));
  if (String(raw).trim() === '' || !Number.isFinite(v)) return false;
  switch (w.op) { case '>=': return v >= w.value; case '<=': return v <= w.value; case '=': return v === w.value; case '>': return v > w.value; case '<': return v < w.value; }
  return false;
}

module.exports = { PARSERS, findParser, filterTable, splitCsvRecord, parseRawJson, pageLines, spanText, LayoutError, TimeoutError, dayFromParts };
