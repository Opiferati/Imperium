'use strict';
// ══════════════════════════════════════════════════════════════════════
// THE FORGE — one owner of model calls (2026-11-10)
//
// Taken from IEAS-001's "Inference Coordinator", which was the one piece of
// that design worth lifting wholesale: ONE place owns model calls, so the
// budget, the accounting and the call rate are coordinated in a single spot
// and NO CARD EVER HOLDS AN API KEY.
//
// Deliberately thin. It is a gate and a meter, not an agent. It makes no
// decision about what to ask or what the answer means.
//
// HONEST LIMIT on "abstains rather than exceeding the budget": the cost of a
// call is only known after it returns, so the gate reserves `reserve_usd` of
// headroom and refuses when the day's spend plus that reserve would breach
// the limit. A single call whose real cost exceeds the reserve can therefore
// still overshoot, by less than one call. Stated rather than implied.
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_RESERVE_USD = 0.25;
const DEFAULT_MAX_CALLS   = 40;

class BudgetRefusal extends Error {
  constructor(msg) { super(msg); this.budget = true; }
}

/**
 * @param call         (model, system, messages, maxTokens) => Promise<api result>
 * @param estimateCost (model, inTok, outTok) => usd
 * @param logCall      ({model, input_tokens, output_tokens, cost_usd}) => void
 * @param spentToday   () => usd spent so far today
 * @param limit        usd/day ceiling
 * @param models       short name -> api model id
 */
function makeForge({ call, estimateCost, logCall, spentToday, limit, models = {}, log = () => {},
                     reserve_usd = DEFAULT_RESERVE_USD, max_calls = DEFAULT_MAX_CALLS } = {}) {
  let calls = 0;
  let spent = 0;

  const resolve = (name) => models[name] || name;

  async function infer({ model, system = '', messages, max_tokens = 1024 }) {
    if (!model) throw new Error('forge: no model named');
    if (!Array.isArray(messages) || !messages.length) throw new Error('forge: no messages');

    // A runaway loop must not be able to spend the day's budget one call at a time.
    if (calls >= max_calls) {
      throw new BudgetRefusal(`forge: ${max_calls} calls already made this run`);
    }
    const today = Number(spentToday()) || 0;
    if (Number.isFinite(limit) && today + reserve_usd > limit) {
      throw new BudgetRefusal(
        `forge: $${today.toFixed(4)} spent of $${limit} and a call needs $${reserve_usd} of headroom`);
    }

    const id = resolve(model);
    calls += 1;
    const res = await call(id, system, messages, max_tokens);

    const inTok  = (res && res.usage && res.usage.input_tokens)  || 0;
    const outTok = (res && res.usage && res.usage.output_tokens) || 0;
    const cost   = Number(estimateCost(id, inTok, outTok)) || 0;
    spent += cost;
    try { logCall({ model: id, input_tokens: inTok, output_tokens: outTok, cost_usd: cost }); }
    catch (e) { log(`forge: could not log the call — ${e.message}`); }

    const text = Array.isArray(res && res.content)
      ? res.content.filter(c => c.type === 'text').map(c => c.text).join('')
      : '';

    return {
      text, model: id, input_tokens: inTok, output_tokens: outTok, cost_usd: cost,
      stop_reason: res && res.stop_reason,
    };
  }

  return {
    infer,
    spent: () => spent,
    calls: () => calls,
    BudgetRefusal,
  };
}

module.exports = { makeForge, BudgetRefusal, DEFAULT_RESERVE_USD, DEFAULT_MAX_CALLS };
