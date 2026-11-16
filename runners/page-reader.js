'use strict';
// ══════════════════════════════════════════════════════════════════════
// PAGE READER — Legion's own way to open a web page. Built 2026-11-16 for
// Trial IX Amendment 4. A shared helper: nothing in the live Legion uses it
// yet (wiring it into a ministry needs Opie's yes).
//
// What it will do: one GET of a public https address, read only, and hand
// back the page as plain text, cut to a size cap.
// What it will never do:
//   - send anything but GET, or any body, cookie or credential
//   - open http, a port other than 443, or an address with a user or password in it
//   - open a private, home-network, loopback, link-local or other reserved
//     address. The host name is looked up once, every answer is checked, and
//     the connection is pinned to a checked address (so a second lookup can't
//     swap in a home address). Every redirect is checked the same way.
//   - read more than MAX_BYTES or wait more than TIMEOUT_MS
//   - when the caller gives a site list (allowHosts), open any site off that
//     list, first address or redirect. A list is what stops a bad page from
//     talking the reader into carrying what it read out to another site.
// ══════════════════════════════════════════════════════════════════════

const https = require('node:https');
const dns   = require('node:dns');
const net   = require('node:net');
const zlib  = require('node:zlib');

const TIMEOUT_MS    = 20_000;          // whole page, every redirect included
const MAX_BYTES     = 5 * 1024 * 1024; // download cap (big CSVs can be read from their end)
const MAX_CHARS     = 32_000;          // text handed back, about 8,000 tokens
const MAX_REDIRECTS = 3;
const MAX_URL       = 2000;
const UA = 'Legion-PageReader/1.0 (read-only research helper)';
const TEXT_TYPES = /^(text\/|application\/(json|geo\+json|xml|rss\+xml|atom\+xml|csv|x-csv|xhtml\+xml)|application\/[a-z.+-]*json)/i;

// ── address checks ───────────────────────────────────────────────────
function v4parts(ip) { return ip.split('.').map(Number); }

/** True for any IPv4 address that is not public unicast. */
function blockedV4(ip) {
  const [a, b, c] = v4parts(ip);
  if (a === 0 || a === 10 || a === 127) return true;               // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true;               // carrier-grade NAT
  if (a === 169 && b === 254) return true;                         // link-local (cloud metadata too)
  if (a === 172 && b >= 16 && b <= 31) return true;                // private
  if (a === 192 && b === 168) return true;                         // private (home routers)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;   // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true;              // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true;            // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;             // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;              // TEST-NET-3
  if (a >= 224) return true;                                       // multicast, reserved, broadcast
  return false;
}

/** Expand an IPv6 address to 8 numbers, or null if it isn't one. */
function v6words(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) {                                         // trailing dotted IPv4 -> two hex words
    const p = m.slice(1).map(Number);
    if (p.some(x => x > 255)) return null;
    s = s.slice(0, m.index) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = x => x ? x.split(':').map(h => /^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN) : [];
  const h = words(halves[0]), r = halves.length === 2 ? words(halves[1]) : [];
  if (halves.length === 1 && h.length !== 8) return null;
  const fillN = 8 - h.length - r.length;
  if (halves.length === 2 && fillN < 1) return null;
  const w = [...h, ...(halves.length === 2 ? new Array(fillN).fill(0) : []), ...r];
  return w.length === 8 && w.every(x => Number.isInteger(x)) ? w : null;
}

/** True for any IPv6 address that is not public unicast. */
function blockedV6(ip) {
  const w = v6words(ip);
  if (!w) return true;
  if (w.every(x => x === 0)) return true;                                   // ::
  if (w.slice(0, 7).every(x => x === 0) && w[7] === 1) return true;         // ::1 loopback
  if (w.slice(0, 5).every(x => x === 0) && (w[5] === 0xffff || w[5] === 0)) // ::ffff:a.b.c.d and ::a.b.c.d
    return blockedV4(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`);
  if (w[0] === 0x64 && w[1] === 0xff9b) return blockedV4(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`); // NAT64
  if ((w[0] & 0xfe00) === 0xfc00) return true;                              // fc00::/7 unique local (home)
  if ((w[0] & 0xffc0) === 0xfe80) return true;                              // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return true;                              // fec0::/10 old site-local
  if ((w[0] & 0xff00) === 0xff00) return true;                              // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;                      // documentation
  if (w[0] === 0x2002) return true;                                         // 6to4 (can wrap a home address)
  if (w[0] === 0x2001 && w[1] === 0) return true;                           // Teredo
  if ((w[0] & 0xe000) !== 0x2000) return true;                              // only 2000::/3 is global unicast
  return false;
}

function blockedAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return blockedV4(ip);
  if (fam === 6) return blockedV6(ip);
  return true;
}

/** True when host is one of the listed sites or under one (usgs.gov covers earthquake.usgs.gov). */
function hostAllowed(host, allowHosts) {
  if (!allowHosts) return true;
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return allowHosts.some(a => { a = String(a).toLowerCase(); return h === a || h.endsWith('.' + a); });
}

/** Check an address string. Returns { ok, url } or { ok: false, error }. */
function checkUrl(raw, allowHosts = null) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'no address given' };
  if (raw.length > MAX_URL) return { ok: false, error: 'address too long' };
  let u;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: 'not a valid address' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'only https addresses can be opened' };
  if (u.username || u.password) return { ok: false, error: 'addresses with a user name or password are refused' };
  if (u.port && u.port !== '443') return { ok: false, error: 'only the standard https port can be opened' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
      || host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.home.arpa') || !host.includes('.') && !net.isIP(host))
    return { ok: false, error: 'home-network and local names are refused' };
  if (net.isIP(host) && blockedAddress(host)) return { ok: false, error: 'private or reserved addresses are refused' };
  if (!hostAllowed(host, allowHosts)) return { ok: false, error: `${host} is not on this reader's site list` };
  u.hash = '';
  return { ok: true, url: u, host };
}

/** Look the host up; refuse if ANY answer is not public. Returns the address to connect to. */
async function vetHost(host, lookupAll) {
  if (net.isIP(host)) return blockedAddress(host) ? null : { address: host, family: net.isIP(host) };
  let answers;
  try { answers = await lookupAll(host); } catch { return { error: 'the site name could not be found' }; }
  if (!answers || !answers.length) return { error: 'the site name could not be found' };
  if (answers.some(a => blockedAddress(a.address))) return null;
  return answers[0];
}

const defaultLookupAll = host => new Promise((res, rej) =>
  dns.lookup(host, { all: true, verbatim: true }, (err, list) => err ? rej(err) : res(list)));

/** One GET to a vetted, pinned address. Resolves { status, headers, body } or rejects. */
function defaultTransport(url, pinned, { deadline, maxBytes }) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new Error('timed out'));
    const req = https.request({
      method: 'GET', protocol: 'https:', hostname: url.hostname.replace(/^\[|\]$/g, ''), port: 443,
      path: url.pathname + url.search, servername: net.isIP(url.hostname) ? undefined : url.hostname,
      headers: { 'user-agent': UA, accept: 'text/html,text/plain,text/csv,application/json,application/xml;q=0.9,*/*;q=0.1', 'accept-encoding': 'gzip, deflate, br' },
      lookup: (_h, opts, cb) => opts && opts.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family),
      agent: false, timeout: left,
    }, res => {
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > maxBytes) { req.destroy(new Error('page too large')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

function decode(body, enc) {
  enc = String(enc || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(body, { maxOutputLength: MAX_BYTES * 4 });
  if (enc === 'deflate') return zlib.inflateSync(body, { maxOutputLength: MAX_BYTES * 4 });
  if (enc === 'br') return zlib.brotliDecompressSync(body, { maxOutputLength: MAX_BYTES * 4 });
  return body;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', deg: '°' };
function entities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML to readable text. Links keep their full address so the reader can follow them. */
function htmlToText(html, base) {
  let s = html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (m, _q, a, b, c, inner) => {
    const href = entities(a ?? b ?? c ?? '');
    let abs = '';
    try { const u = new URL(href, base); if (u.protocol === 'https:' || u.protocol === 'http:') abs = u.href; } catch { /* skip */ }
    const t = inner.replace(/<[^>]+>/g, ' ').trim();
    return abs ? ` ${t} [${abs}] ` : ` ${t} `;
  });
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|pre)>|<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, '\t');
  s = entities(s.replace(/<[^>]+>/g, ' '));
  return s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * Open one page. part: 'start' (default) or 'end' — for a long file, which end to keep.
 * Never throws: always resolves { ok, ... }.
 */
async function readPage(address, { part = 'start', allowHosts = null, lookupAll = defaultLookupAll, transport = defaultTransport,
  timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, maxChars = MAX_CHARS, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  let check = checkUrl(address, allowHosts);
  if (!check.ok) return { ok: false, address, error: check.error };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const pinned = await vetHost(check.host, lookupAll);
    if (pinned === null) return { ok: false, address, error: 'the site resolves to a private or reserved address, refused' };
    if (pinned.error) return { ok: false, address, error: pinned.error };
    let r;
    try { r = await transport(check.url, pinned, { deadline, maxBytes }); }
    catch (e) { return { ok: false, address, error: `could not open the page (${String(e && e.message || e).slice(0, 80)})` }; }
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      if (hop === MAX_REDIRECTS) return { ok: false, address, error: 'too many redirects' };
      let next;
      try { next = new URL(r.headers.location, check.url).href; } catch { return { ok: false, address, error: 'bad redirect' }; }
      check = checkUrl(next, allowHosts);
      if (!check.ok) return { ok: false, address, error: `redirect refused: ${check.error}` };
      continue;
    }
    if (r.status < 200 || r.status >= 300) return { ok: false, address, status: r.status, error: `the site answered ${r.status}` };
    const type = String(r.headers['content-type'] || '').split(';')[0].trim();
    if (type && !TEXT_TYPES.test(type)) return { ok: false, address, error: `not a text page (${type})` };
    let body;
    try { body = decode(r.body, r.headers['content-encoding']); } catch { return { ok: false, address, error: 'could not decode the page' }; }
    let text = body.toString('utf8');
    if (/html/i.test(type) || (!type && /^\s*<(!doctype|html)/i.test(text))) text = htmlToText(text, check.url.href);
    const total = text.length;
    const truncated = total > maxChars;
    if (truncated) text = part === 'end' ? text.slice(total - maxChars) : text.slice(0, maxChars);
    return { ok: true, address, final: check.url.href, status: r.status, type, chars: total, truncated, part: truncated ? part : 'all', text };
  }
  return { ok: false, address, error: 'too many redirects' };
}

/** The result as the model sees it: a short header line, then the text. */
function asToolText(r) {
  if (!r.ok) return `PAGE NOT OPENED: ${r.error}`;
  const cut = r.truncated ? `, cut to its ${r.part === 'end' ? 'last' : 'first'} ${MAX_CHARS} of ${r.chars} characters` : '';
  return `PAGE ${r.final} (${r.type || 'unknown type'}${cut})\n\n${r.text}`;
}

module.exports = { readPage, asToolText, checkUrl, hostAllowed, blockedAddress, blockedV4, blockedV6, v6words, htmlToText, vetHost,
  TIMEOUT_MS, MAX_BYTES, MAX_CHARS, MAX_REDIRECTS };
