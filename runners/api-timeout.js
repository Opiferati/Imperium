'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// API TIMEOUT LABELS (2026-11-15, applied on Opie's yes) — so a failure says what really happened.
//
// Found tracing the four Nov 14 "[FAILED] ... API call timed out after 8 min" messages, which all
// came 1.5 to 3 minutes after dispatch. Node's default https agent (keepAlive, timeout: 5000)
// gives every new socket a 5-second timeout while it is still CONNECTING (DNS lookup + TCP
// connect). req.setTimeout(8 min) only takes over once the socket connects. Any socket timeout
// fires the request's 'timeout' event, so a 5-second connect stall ran the 8-minute callback,
// and the error was labelled "after 8 min" no matter which timer fired.
//
// requestOnce() is the Warden's one-try call with the label fixed: it looks at the socket and
// the clock when the timer fires and says which of three things happened. Behaviour is otherwise
// unchanged (same timers, same retries, code stays ETIMEDOUT so api-retry still retries it).
// ─────────────────────────────────────────────────────────────────────────────

const fmt = ms => ms >= 60_000 ? `${+(ms / 60_000).toFixed(1)} min` : `${+(ms / 1000).toFixed(1)} s`;

// req: the ClientRequest whose 'timeout' fired. startedAt: when the try began. idleMs: our own limit.
function timeoutError(req, { startedAt, idleMs, now = Date.now() }) {
  const sock = req && req.socket;
  const elapsedMs = now - startedAt;
  let kind, message;
  if (!sock || sock.connecting) {
    kind = 'connect-timeout';
    message = `API connect timed out after ${fmt(elapsedMs)} (DNS or network: the server was never reached)`;
  } else if (elapsedMs >= idleMs - 1000) {   // 1 s of slack for timer jitter
    kind = 'idle-timeout';
    message = `API call timed out after ${fmt(idleMs)} with no reply`;
  } else {
    kind = 'socket-timeout';
    message = `API socket timed out after ${fmt(elapsedMs)} (an earlier timer than the ${fmt(idleMs)} limit fired)`;
  }
  return Object.assign(new Error(message), { code: 'ETIMEDOUT', kind, elapsedMs });
}

// One try. Never rejects: returns { status, body, headers } or { error } for apiRetry to judge.
// Same body as warden.js's old inline `once`, plus the honest label. `agent` is only for tests.
function requestOnce(https, options, body, { idleMs, agent } = {}) {
  return new Promise((done) => {
    const startedAt = Date.now();
    const req = https.request(agent ? { ...options, agent } : options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { parsed = { error: { type: res.statusCode >= 500 ? 'api_error' : 'invalid_response',
                                    message: `Bad API response (${res.statusCode}): ${data.slice(0, 200)}` } }; }
        done({ status: res.statusCode, body: parsed, headers: res.headers });
      });
      res.on('error', error => done({ error }));
    });
    req.setTimeout(idleMs, () => req.destroy(timeoutError(req, { startedAt, idleMs })));
    req.on('error', error => done({ error }));
    req.write(body);
    req.end();
  });
}

module.exports = { timeoutError, requestOnce, fmt };
