'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE SUPERVISOR (2026-11-09) — borrowed from Erlang/OTP. A part, not a runner.
//
// WHAT WE TOOK, AND WHY:
//  1. RESTART INTENSITY. A supervisor retries a failing child, but only R times within T — and when that
//     budget is spent it stops trying and escalates. This is the whole idea. Unbounded retry is not
//     resilience, it's a machine quietly beating a dead horse all night.
//  2. CHILD TYPES. permanent (always retry), transient (retry only on an unexpected fault),
//     temporary (never retry — one shot, failure is fine).
//  3. REST_FOR_ONE. A child that depends on a failed child is SKIPPED, not run on stale data. The Ravens
//     read the twins' results; flying them after a twin fails produces a confident, wrong league table.
//  4. LET IT CRASH. Don't defensively patch around a fault — fail clean and restart from known state.
//     The Empire already earns this: every scan recomputes from frozen data, so a retry is always safe.
//
// WHAT WE CHANGED, AND WHY: OTP supervises long-lived processes. The Empire's children are short-lived
// nightly jobs. So "restart" means "retry the job", and "the supervisor itself dies" becomes "disable
// this child and tell the Emperor". Same shape, honest about the difference.
//
// LEGO CONTRACT:  supervise(name, fn, policy) -> result   ·   health(name)   ·   report()
// The supervisor never does the work and never knows what the work is. It only starts, watches, decides.
// ══════════════════════════════════════════════════════════════════════

const DEFAULTS = { restart: 'permanent', attempts: 2, backoff_s: [5, 20], max_failures: 4, within_hours: 24, after: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeSupervisor({ board = null, log = console, now = () => new Date() } = {}) {
  const children = new Map();   // name -> {failures: [iso], disabledAt, lastError, lastOk, runs}

  const get = name => {
    if (!children.has(name)) children.set(name, { failures: [], disabledAt: null, lastError: null, lastOk: null, runs: 0 });
    return children.get(name);
  };

  const recent = (c, hours) => {
    const cutoff = now().getTime() - hours * 3600_000;
    c.failures = c.failures.filter(t => Date.parse(t) >= cutoff);     // the window slides; old faults are forgiven
    return c.failures.length;
  };

  function publish(name, c, policy) {
    if (!board) return;
    try {
      board.post({ topic: `supervisor.${name}.health`, author: 'supervisor',
                   value: { state: c.disabledAt ? 'disabled' : (c.failures.length ? 'shaky' : 'ok'),
                            failures_in_window: c.failures.length, max: policy.max_failures,
                            last_error: c.lastError, last_ok: c.lastOk, disabled_at: c.disabledAt },
                   as_of: now().toISOString().slice(0, 10), source: 'supervision', if_changed: true });
    } catch (e) { log.warn?.(`[SUPERVISOR] could not publish ${name} health: ${e.message}`); }
  }

  return {
    /** Run a child under supervision. Never throws: a failure is a result, not an exception. */
    async supervise(name, fn, policy = {}) {
      const p = { ...DEFAULTS, ...policy };
      const c = get(name);

      // rest_for_one: a child whose dependency is down is skipped, not fed stale data.
      for (const dep of p.after) {
        const d = children.get(dep);
        if (d && (d.disabledAt || (d.lastError && !d.lastOk))) {
          const why = `skipped: depends on ${dep}, which is ${d.disabledAt ? 'disabled' : 'failing'}`;
          log.warn?.(`[SUPERVISOR] ${name} ${why}`);
          return { ok: false, skipped: true, state: 'skipped', reason: why, attempts: 0, name };
        }
      }

      if (c.disabledAt) {
        return { ok: false, skipped: true, state: 'disabled', attempts: 0, name,
                 reason: `disabled after ${p.max_failures} failure(s) in ${p.within_hours}h — last: ${c.lastError}` };
      }

      const tries = p.restart === 'temporary' ? 1 : Math.max(1, p.attempts);
      let lastErr = null;
      for (let i = 0; i < tries; i++) {
        if (i) {
          const wait = (p.backoff_s[Math.min(i - 1, p.backoff_s.length - 1)] ?? 5) * 1000;
          log.log?.(`[SUPERVISOR] ${name} failed (${lastErr}); retry ${i + 1}/${tries} in ${wait / 1000}s`);
          await sleep(wait);
        }
        try {
          const value = await fn();
          c.runs += 1;
          c.lastOk = now().toISOString();
          c.lastError = null;
          publish(name, c, p);
          return { ok: true, value, attempts: i + 1, state: c.failures.length ? 'recovered' : 'ok', name };
        } catch (e) {
          lastErr = e && e.message ? e.message : String(e);
          if (p.restart === 'transient' && e && e.expected) break;   // an expected condition is not a fault
        }
      }

      // Out of attempts. Spend one from the restart-intensity budget and decide whether to escalate.
      c.failures.push(now().toISOString());
      c.lastError = lastErr;
      const n = recent(c, p.within_hours);
      let state = 'failed';
      if (n >= p.max_failures) {
        c.disabledAt = now().toISOString();
        state = 'disabled';
        log.warn?.(`[SUPERVISOR] ${name} DISABLED — ${n} failure(s) in ${p.within_hours}h. Last: ${lastErr}`);
      }
      publish(name, c, p);
      return { ok: false, error: lastErr, attempts: tries, state, name,
               failures_in_window: n, max_failures: p.max_failures };
    },

    /** How is this child doing? */
    health(name) {
      const c = children.get(name);
      if (!c) return { name, state: 'unknown' };
      return { name, state: c.disabledAt ? 'disabled' : (c.failures.length ? 'shaky' : 'ok'),
               failures_in_window: c.failures.length, last_error: c.lastError,
               last_ok: c.lastOk, disabled_at: c.disabledAt, runs: c.runs };
    },

    /** Everyone's health, worst first. */
    report() {
      const order = { disabled: 0, shaky: 1, ok: 2, unknown: 3 };
      return [...children.keys()].map(n => this.health(n))
        .sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
    },

    /** One line for the nightly log. Silent when everything is well. */
    summaryLine() {
      const bad = this.report().filter(h => h.state !== 'ok');
      if (!bad.length) return null;
      return '[SUPERVISOR] ' + bad.map(h => `${h.name}: ${h.state}`
        + (h.state === 'disabled' ? ` (${h.failures_in_window} failures; clear it with --revive ${h.name})` : '')
        + (h.last_error ? ` — ${h.last_error}` : '')).join(' | ');
    },

    /** Opie's override: forgive a child and let it try again. The only way out of 'disabled'. */
    revive(name) {
      const c = children.get(name);
      if (!c) return false;
      c.disabledAt = null;
      c.failures = [];
      c.lastError = null;
      log.log?.(`[SUPERVISOR] ${name} revived by the Emperor`);
      return true;
    },
  };
}

module.exports = { makeSupervisor, DEFAULTS };
