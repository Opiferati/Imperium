'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE SKALD v1.0 (2026-11-01) — the Imperium's mood-reader
// Once a day it combs live headlines (web search), scores the mood of the
// crypto and stock markets 0–100 with a fixed rubric, and says WHY.
// Measurement only (Edict VI): the Skald never touches a trade.
// The Lawspeaker (plain code, zero tokens) rejects any reading whose sources
// weren't actually returned by the search, or whose format is wrong.
// ══════════════════════════════════════════════════════════════════════
const fs   = require('node:fs');
const path = require('node:path');
const translator = require('./translator.js');

const RUBRIC_VERSION = 'skald-rubric-v1 (2026-11-01)';
const CSV_HEADER_V1 = 'date,crypto_mood,stock_mood,crypto_fg,stock_gauge,model,rubric,n_sources,searches,cost_usd,crypto_why,stock_why';
// 2026-11-03: gauge dates + a stale flag added at the end (Thesis C Amendment 1). Older rows leave them blank.
const CSV_HEADER_V2 = CSV_HEADER_V1 + ',crypto_fg_date,stock_gauge_date,stale';
// 2026-11-03 (Amendment 2): quality = pass | thin, and why it's thin. Older rows leave them blank (= pass).
const CSV_HEADER = CSV_HEADER_V2 + ',quality,thin_why';

const SYSTEM = `You are the Skald of the Norse Imperium: you read the mood of the markets from today's news.
Rules you never break:
- Use the web_search tool. Cover ALL five beats, one search each:
  1. crypto market news today   2. bitcoin and ethereum price news today
  3. stock market news today     4. Federal Reserve, rates, inflation or economy news this week
  5. crypto hacks, exchange failures or regulation news this week
- Judge only from what you found published in roughly the last 48 hours. Ignore your own memory of events.
- Score each market 0–100 on this fixed scale:
    0–10  panic: crash, collapse, contagion headlines dominate
    11–25 extreme fear: heavy selling, major negative shock, alarm in coverage
    26–45 fear: worry and caution outweigh optimism
    46–55 neutral: mixed, nothing dominant
    56–75 greed: optimism, rallies, risk-on language
    76–90 extreme greed: records, euphoria, FOMO
    91–100 mania: bubble talk, "can't lose" tone
- Score the MOOD of the coverage, not your prediction of prices.
- Every driver must name the event in plain words and cite at least one source URL from your searches.
  Cite the specific article page, never a site's homepage or section front.
Reply with ONE JSON object and nothing else:
{"crypto_mood": <int>, "stock_mood": <int>,
 "crypto_drivers": [{"event": "...", "effect": "fear|greed|neutral", "url": "https://..."}],
 "stock_drivers":  [{"event": "...", "effect": "fear|greed|neutral", "url": "https://..."}],
 "headlines": [{"title": "...", "url": "https://...", "market": "crypto|stocks"}]}
2–5 drivers per market. 6–15 headlines.
The Lawspeaker (plain code) checks your reply. To pass in full:
- at least 3 searches ran;
- every driver and headline URL is one your searches actually returned, and is an article page (not a homepage);
- each market has 2+ such drivers, and 3+ headlines trace back to your searches.
A reading with real but fewer sources is recorded as THIN (flagged: few sources, unverified). A link your searches never returned fails the reading outright. Never invent or guess a URL.`;

function userPrompt(dateEt) {
  return `Today is ${dateEt} (New York). Run your five searches and give today's Skald reading.`;
}

function etNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour };
}

function csvPath(root) { return path.join(root, 'data', 'skald-mood.csv'); }

function loggedDates(root) {
  try {
    return new Set(fs.readFileSync(csvPath(root), 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.slice(0, 10)));
  } catch { return new Set(); }
}

// Due once per New York day, after the reading hour (default 18:00 — after the US close)
function isDue(root, conf = {}, now = new Date()) {
  const et = etNow(now);
  return et.hour >= (conf.run_after_hour_et ?? 18) && !loggedDates(root).has(et.date);
}

function searchResultUrls(content) {
  const urls = new Set();
  for (const b of content || []) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content))
      for (const r of b.content) if (r.url) urls.add(r.url);
    for (const c of b.citations || []) if (c.url) urls.add(c.url);
  }
  return urls;
}

// Lawspeaker v1.1 (2026-11-01): a homepage or section front ("cnbc.com/", "google.com/finance") is not a
// citation. A source must point at an actual article. Scoring rubric unchanged (still skald-rubric-v1).
function isArticleUrl(u) {
  try {
    const segs = new URL(u).pathname.split('/').filter(Boolean);
    if (segs.length === 0) return false;
    if (segs.length === 1 && segs[0].length < 15 && !/[-_\d.]/.test(segs[0])) return false;
    return true;
  } catch { return false; }
}

// The Lawspeaker v2 (2026-11-03): a graded verdict. Returns { verdict, ok, thin, problems, thinWhy, reading }
//   PASS — full sourcing.   THIN — real but few sources (recorded, flagged "few sources, unverified").
//   FAIL — not JSON, bad scores, under 3 searches, an invented link, or nothing real to stand on.
// (Opie, 2026-11-03: "I've got something, but it's weak" beats silently throwing a reading away.)
function lawspeaker(content, searches, priorContent = []) {   // priorContent: earlier attempts' blocks (2026-11-02)
  const hard = [], thin = [];
  const text = (content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  // The Translator (2026-11-07) fixes form only (syntax, "70"→70, case); the checks below still judge.
  const tr = translator.translate(text, translator.FORMS.skald);
  const j = tr.parsed && tr.value && typeof tr.value === 'object' && !Array.isArray(tr.value) ? tr.value : null;
  if (!j) return { verdict: 'FAIL', ok: false, thin: false, problems: [`Reply was not a readable JSON object: ${tr.errors[0] || 'unknown'}`],
                   thinWhy: '', reading: null, translated: [] };
  const found = searchResultUrls([...priorContent, ...(content || [])]);
  if (searches < 3) hard.push(`Only ${searches} web search(es) ran — need at least 3 of the 5 beats.`);
  for (const k of ['crypto_mood', 'stock_mood']) {
    if (!Number.isInteger(j[k]) || j[k] < 0 || j[k] > 100) hard.push(`${k} must be a whole number 0–100 (got ${JSON.stringify(j[k])}).`);
  }
  for (const k of ['crypto_drivers', 'stock_drivers']) {
    const arr = Array.isArray(j[k]) ? j[k] : [];
    const good = [];
    for (const d of arr) {
      if (!d || !d.event || !/^https:\/\//.test(d.url || '')) { hard.push(`${k}: a driver is missing its event or https link.`); continue; }
      if (!found.has(d.url)) { hard.push(`${k}: "${String(d.event).slice(0, 60)}" cites a link the search never returned (${d.url}).`); continue; }
      if (!isArticleUrl(d.url)) { thin.push(`${k}: "${String(d.event).slice(0, 60)}" cites a homepage, not an article — dropped.`); continue; }
      good.push(d);
    }
    j[k] = good;
    if (good.length === 0) hard.push(`${k}: no driver with a real article link.`);
    else if (good.length < 2) thin.push(`${k}: only 1 sourced driver (want 2+).`);
  }
  const heads = (Array.isArray(j.headlines) ? j.headlines : []).filter(h => h && h.url && found.has(h.url) && isArticleUrl(h.url));
  if (heads.length === 0) hard.push('No headline traces back to a real search result.');
  else if (heads.length < 3) thin.push(`Only ${heads.length} headline(s) trace back to real search results (want 3+).`);
  j.headlines = heads;
  const verdict = hard.length ? 'FAIL' : thin.length ? 'THIN' : 'PASS';
  return { verdict, ok: verdict === 'PASS', thin: verdict === 'THIN', problems: [...hard, ...thin],
           thinWhy: verdict === 'THIN' ? thin.join(' ') : '', reading: j, translated: tr.repairs };
}

function latest(file, onOrBefore) {
  try {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
    let v = null;
    for (const [d, x] of rows) if (d <= onOrBefore) v = [d, parseFloat(x)];
    return v;
  } catch { return null; }
}

function gauges(conf, dateEt) {
  const toWsl = p => { const m = String(p).match(/^([A-Za-z]):[\\/](.*)/); return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p; };
  const dir = path.join(toWsl(conf.finalance_dir || 'C:\\Finalance'), 'data', 'v2_prices');
  const c = latest(path.join(dir, '_fear_greed.csv'), dateEt);
  const s = latest(path.join(dir, '_stock_fear_gauge.csv'), dateEt);
  // Stale = not from the reading's own day. Crypto trades daily; stocks only on weekdays
  // (a holiday flags stocks too, which is harmless: Thesis C only scores SPY trading days).
  const weekday = new Date(dateEt + 'T12:00:00Z').getUTCDay() % 6 !== 0;
  const stale = [!c || c[0] !== dateEt ? 'crypto' : '', weekday && (!s || s[0] !== dateEt) ? 'stock' : ''].filter(Boolean).join('+');
  return { crypto_fg: c ? c[1] : null, crypto_fg_date: c ? c[0] : '',
           stock_gauge: s ? s[1] : null, stock_gauge_date: s ? s[0] : '', stale };
}

const q = s => `"${String(s).replace(/"/g, "'").replace(/[\r\n]+/g, ' ')}"`;
const why = arr => (arr || []).map(d => d.event).join('; ');

function record(root, conf, dateEt, reading, meta, rawContent) {
  const g = gauges(conf, dateEt);
  const f = csvPath(root);
  if (!fs.existsSync(f)) fs.writeFileSync(f, CSV_HEADER + '\n');
  else {   // one-time header upgrade; existing rows are left exactly as they were
    const txt = fs.readFileSync(f, 'utf8');
    for (const old of [CSV_HEADER_V2, CSV_HEADER_V1])
      if (txt.startsWith(old + '\n')) { fs.writeFileSync(f, CSV_HEADER + txt.slice(old.length)); break; }
  }
  fs.appendFileSync(f, [dateEt, reading.crypto_mood, reading.stock_mood, g.crypto_fg ?? '', g.stock_gauge ?? '',
    meta.model, q(RUBRIC_VERSION), reading.headlines.length, meta.searches, meta.cost.toFixed(4),
    q(why(reading.crypto_drivers)), q(why(reading.stock_drivers)), g.crypto_fg_date, g.stock_gauge_date, g.stale,
    meta.quality || 'pass', q(meta.thin_why || '')].join(',') + '\n');
  // Raw archive: the exact headlines seen today, kept for future studies
  const arch = path.join(root, 'data', 'skald-archive');
  fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(path.join(arch, `${dateEt}.json`), JSON.stringify({ date: dateEt, rubric: RUBRIC_VERSION, ...meta, reading,
    search_results: [...searchResultUrls(rawContent)] }, null, 2));
  return g;
}

const label = v => v == null ? '—' : v <= 10 ? 'Panic' : v <= 25 ? 'Extreme Fear' : v <= 45 ? 'Fear' : v <= 55 ? 'Neutral' : v <= 75 ? 'Greed' : v <= 90 ? 'Extreme Greed' : 'Mania';

function report(dateEt, reading, g, meta) {
  const drv = arr => (arr || []).map(d => `- **${d.effect || '?'}** — ${d.event} ([source](${d.url}))`).join('\n');
  return `# Skald reading — ${dateEt}
${meta.translated ? `\n> 🔤 **Translated (form only):** ${meta.translated}\n` : ''}${meta.quality === 'thin' ? `\n> ⚠ **THIN — few sources, unverified.** ${meta.thin_why}\n` : ''}
| | Skald (news mood) | Price gauge |
|---|---|---|
| **Crypto** | **${reading.crypto_mood}** ${label(reading.crypto_mood)} | ${g.crypto_fg ?? '—'} ${label(g.crypto_fg)} (alternative.me) |
| **Stocks** | **${reading.stock_mood}** ${label(reading.stock_mood)} | ${g.stock_gauge ?? '—'} ${label(g.stock_gauge)} (Stock Fear Gauge) |

## Why — crypto
${drv(reading.crypto_drivers)}

## Why — stocks
${drv(reading.stock_drivers)}

## Headlines read
${reading.headlines.map(h => `- [${h.title}](${h.url}) · ${h.market || ''}`).join('\n')}

---
*${meta.model} · ${meta.searches} searches · $${meta.cost.toFixed(4)} · ${RUBRIC_VERSION} · measurement only, never a trade (Edict VI)*
`;
}

module.exports = { isArticleUrl, SYSTEM, userPrompt, etNow, isDue, lawspeaker, record, report, label, RUBRIC_VERSION, CSV_HEADER };
