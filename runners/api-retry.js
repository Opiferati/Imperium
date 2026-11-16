'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// API RETRY (2026-11-07) — so one hiccup at Anthropic doesn't freeze or fail the court.
// Found in the resource audit: callAnthropic had no timeout (a dropped connection could hang
// the Warden — and everything queued behind it — until a restart) and no retry (a routine
// "overloaded, try again" failed the Skald outright and burned one of its 2 daily runs).
//
// Retries ONLY what's worth retrying: timeouts, network errors, HTTP 429/500/502/503/504/529,
// and overloaded / rate-limit / api errors. A bad request, bad key or out-of-credit error is
// returned at once — retrying those just wastes time.
// Note: a timed-out call may already have been processed (and billed) on Anthropic's side;
// the timeout is long enough that this should be rare.
//
// 2026-11-15 (timeout labels, on Opie's yes): when every try fails on the network, the thrown error now
// carries the whole story — how many tries, over how long, and what each one hit — instead of
// only the last try's message. The retry logic itself is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRY_TYPES = new Set(['overloaded_error', 'rate_limit_error', 'api_error', 'timeout_error']);
const RETRY_NET = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|timed out/i;

// outcome: { status, body, headers } from a finished HTTP call, or { error } for a network failure
function isRetryable(outcome) {
  if (outcome.error) return RETRY_NET.test(String(outcome.error.code || '') + ' ' + String(outcome.error.message || ''));
  if (RETRY_STATUS.has(outcome.status)) return true;
  const t = outcome.body && outcome.body.error && outcome.body.error.type;
  return Boolean(t && RETRY_TYPES.has(t));
}

function waitFor(outcome, attempt, delays) {
  const ra = Number(outcome.headers && outcome.headers['retry-after']);
  const base = delays[Math.min(attempt, delays.length - 1)];
  return Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : base, 60_000);
}

// A short tag for one try: the timeout kind if api-timeout labelled it, else the code, else HTTP status.
function tag(outcome) {
  if (outcome.error) return outcome.error.kind || outcome.error.code || String(outcome.error.message || 'error').slice(0, 60);
  return `HTTP ${outcome.status} ${outcome.body?.error?.type || ''}`.trim();
}

// ['connect-timeout','connect-timeout','HTTP 529 overloaded_error'] -> 'connect-timeout x2, HTTP 529 overloaded_error'
function summarize(tags) {
  const runs = [];
  for (const t of tags) {
    const last = runs[runs.length - 1];
    if (last && last.t === t) last.n++; else runs.push({ t, n: 1 });
  }
  return runs.map(r => r.n > 1 ? `${r.t} x${r.n}` : r.t).join(', ');
}

/**
 * withRetries(once, opts) → the body of the first good (or non-retryable) reply.
 * once() → Promise<{ status, body, headers } | { error }>   (never rejects)
 * Throws the network error if every try failed on the network; otherwise returns the last body
 * (callers already check body.error). A thrown error after more than one try names every try.
 */
async function withRetries(once, { delays = [5_000, 15_000, 45_000], sleep = ms => new Promise(r => setTimeout(r, ms)),
                                    log = () => {}, now = Date.now } = {}) {
  let outcome;
  const t0 = now();
  const tags = [];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    outcome = await once();
    tags.push(tag(outcome));
    if (!isRetryable(outcome)) break;
    if (attempt === delays.length) break;
    const ms = waitFor(outcome, attempt, delays);
    const why = outcome.error ? (outcome.error.code || outcome.error.message) : `${outcome.status} ${outcome.body?.error?.type || ''}`.trim();
    log(`API ${why} — retry ${attempt + 1}/${delays.length} in ${Math.round(ms / 1000)}s`);
    await sleep(ms);
  }
  if (outcome.error) {
    const e = outcome.error;
    e.attempts = tags;
    if (tags.length > 1) e.message = `${e.message} [${tags.length} tries over ${Math.round((now() - t0) / 1000)} s: ${summarize(tags)}]`;
    throw e;
  }
  return outcome.body;
}

module.exports = { withRetries, isRetryable, summarize };
