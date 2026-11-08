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

/**
 * withRetries(once, opts) → the body of the first good (or non-retryable) reply.
 * once() → Promise<{ status, body, headers } | { error }>   (never rejects)
 * Throws the network error if every try failed on the network; otherwise returns the last body
 * (callers already check body.error).
 */
async function withRetries(once, { delays = [5_000, 15_000, 45_000], sleep = ms => new Promise(r => setTimeout(r, ms)),
                                    log = () => {} } = {}) {
  let outcome;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    outcome = await once();
    if (!isRetryable(outcome)) break;
    if (attempt === delays.length) break;
    const ms = waitFor(outcome, attempt, delays);
    const why = outcome.error ? (outcome.error.code || outcome.error.message) : `${outcome.status} ${outcome.body?.error?.type || ''}`.trim();
    log(`API ${why} — retry ${attempt + 1}/${delays.length} in ${Math.round(ms / 1000)}s`);
    await sleep(ms);
  }
  if (outcome.error) throw outcome.error;
  return outcome.body;
}

module.exports = { withRetries, isRetryable };
