'use strict';
// Research tools for a ministry order (2026-11-16).
// The ministry could search but not open pages, so it wrote from search snippets.
// This adds Anthropic's own page reader (web_fetch) beside web_search.
//
// Versions: the BASIC ones (web_search_20250305, web_fetch_20250910). The ministry runs on
// Haiku 5.5, and the basic versions need nothing else (no dynamic filtering, no code execution).
// Trial IX uses the same two versions (Amendment 3).
//
// Budgets. The API counts a tool's uses across every request of one turn, and a request that
// resumes after pause_turn is the same turn (platform docs, web fetch + web search, "max_uses").
// So pause_turn hops resend the SAME tools array unchanged: the server already holds the line,
// and the docs say a resume that drops a tool can fail with a 400 when the paused turn ends on a
// call to it. The condense retry is a NEW turn (it adds a user message), so it gets only what is
// left, and a tool with nothing left is left off. Spent is counted from usage.server_tool_use.
//
// The page reader only opens addresses already seen in the conversation: user messages, search
// results, earlier pages. A made-up address comes back as url_not_in_prior_context. That is the
// API's guard against a page talking the model into sending data out in an address, and it is
// kept. Addresses the model would have to build (data tables) wait for Legion's own reader
// (shared with Trial IX, limited to a short list of government data sites); not wired yet.

const SEARCH_TOOL = 'web_search_20250305';
const FETCH_TOOL = 'web_fetch_20250910';
const DEFAULT_FETCH_USES = 3;
const DEFAULT_FETCH_TOKENS = 15000;   // one opened page, cut to about this many tokens (text only; PDFs are not cut)

/** What one order may spend, from the agent's registry entry. */
function budgetFrom(agentConf) {
  const ws = agentConf && agentConf.web_search;
  const wf = agentConf && agentConf.web_fetch;
  return {
    searches: ws ? (ws.max_uses ?? 5) : 0,
    fetches: wf ? (wf.max_uses ?? DEFAULT_FETCH_USES) : 0,
    fetchTokens: wf ? (wf.max_content_tokens ?? DEFAULT_FETCH_TOKENS) : 0,
  };
}

/** The tools array for a request. `left` defaults to the full budget (first call and pause_turn hops). */
function toolsFor(budget, left = budget) {
  const tools = [];
  if (left.searches > 0) tools.push({ type: SEARCH_TOOL, name: 'web_search', max_uses: left.searches });
  if (left.fetches > 0) tools.push({ type: FETCH_TOOL, name: 'web_fetch', max_uses: left.fetches,
    max_content_tokens: budget.fetchTokens, citations: { enabled: true } });
  return tools.length ? tools : null;
}

/** Uses reported by one response. */
function usesIn(usage) {
  const s = (usage && usage.server_tool_use) || {};
  return { searches: s.web_search_requests || 0, fetches: s.web_fetch_requests || 0 };
}

/** What is left after `used`, never below zero. */
function leftAfter(budget, used) {
  return {
    searches: Math.max(0, budget.searches - used.searches),
    fetches: Math.max(0, budget.fetches - used.fetches),
    fetchTokens: budget.fetchTokens,
  };
}

/** Ids of server tool calls that came back with a result (search OR page). The condense retry keeps
 *  only these; a call kept without its result, or a result without its call, is a 400. */
function answeredIds(content) {
  return new Set((content || [])
    .filter(b => b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result')
    .map(b => b.tool_use_id));
}

/** Blocks safe to resend as a finished assistant turn: unanswered calls dropped. */
function finishedBlocks(content) {
  const done = answeredIds(content);
  return (content || []).filter(b => b.type !== 'server_tool_use' || done.has(b.id));
}

/** Pages actually opened, for the Sources record (fetch citations carry no address, so the
 *  address comes from the result block). Failed opens are listed apart, never as sources. */
function openedPages(content) {
  const opened = new Map(), failed = [];
  for (const b of content || []) {
    if (b.type !== 'web_fetch_tool_result' || !b.content) continue;
    const c = b.content;
    if (c.type === 'web_fetch_result' && c.url) {
      if (!opened.has(c.url)) opened.set(c.url, (c.content && c.content.title) || c.url);
    } else if (c.type === 'web_fetch_tool_result_error' || c.error_code) {
      failed.push(c.error_code || 'error');
    }
  }
  return { opened, failed };
}

/** Before another paid hop: would this order's running cost carry the day past the wall?
 *  The Warden's gate runs once per tick, before the order; this one runs between hops. */
function pastWall(spentToday, orderCost, limit) {
  return spentToday + orderCost >= limit - 1e-9;
}

module.exports = { SEARCH_TOOL, FETCH_TOOL, budgetFrom, toolsFor, usesIn, leftAfter,
  answeredIds, finishedBlocks, openedPages, pastWall };
