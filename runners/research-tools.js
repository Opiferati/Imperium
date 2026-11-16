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
// kept. Addresses the model has to build (data tables, API queries with dates) go through
// Legion's own reader instead, runners/page-reader.js (shared with Trial IX, Amendment 4), as a
// client tool, read_page, that opens only the government data sites in DATA_HOSTS.
// read_page's budget is kept here in code, like Trial IX: once spent it answers "no page opens
// left". Its definition is sent unchanged on every request of the order.

const SEARCH_TOOL = 'web_search_20250305';
const FETCH_TOOL = 'web_fetch_20250910';
const DEFAULT_FETCH_USES = 3;
const DEFAULT_FETCH_TOKENS = 15000;   // one opened page, cut to about this many tokens (text only; PDFs are not cut)
const DEFAULT_READS = 3;
const READ_TOOL_NAME = 'read_page';
// The same site list as Trial IX's Amendment 4 (trial-ix.js PAGE_HOSTS): USGS, GFZ, NOAA, SIDC, Treasury.
// A list is what stops a bad page from talking the reader into carrying what it read to another site.
const DATA_HOSTS = Object.freeze(['usgs.gov', 'gfz.de', 'gfz-potsdam.de', 'noaa.gov', 'sidc.be', 'treasury.gov']);
const READ_CHARS = 32000;             // page-reader.js MAX_CHARS (a test checks they match)

/** read_page as the model sees it. Fixed for the whole order, so every request sends the same tools. */
function readTool(cap) {
  return {
    name: READ_TOOL_NAME,
    description: 'Open one public web page (https only) on a government data site and read it as plain text. '
      + 'Use it for data tables, CSV, JSON or text files at an address you know or have built, for example a USGS '
      + 'catalogue query or a Treasury table with dates in it. Long pages are cut to about '
      + `${READ_CHARS.toLocaleString('en-US')} characters; set part to "end" to read the end of a long file instead of the start. `
      + `It only opens these sites and their subdomains: ${DATA_HOSTS.join(', ')}. `
      + `You can open up to ${cap} pages for this order.`,
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full https address to open.' },
        part: { type: 'string', enum: ['start', 'end'], description: 'Which end of a long page to keep. Default start.' },
      },
      required: ['url'],
    },
  };
}

/** What one order may spend, from the agent's registry entry. */
function budgetFrom(agentConf) {
  const ws = agentConf && agentConf.web_search;
  const wf = agentConf && agentConf.web_fetch;
  const rp = agentConf && agentConf.read_page;
  return {
    searches: ws ? (ws.max_uses ?? 5) : 0,
    fetches: wf ? (wf.max_uses ?? DEFAULT_FETCH_USES) : 0,
    fetchTokens: wf ? (wf.max_content_tokens ?? DEFAULT_FETCH_TOKENS) : 0,
    reads: rp ? (rp.max_uses ?? DEFAULT_READS) : 0,
  };
}

/** The tools array for a request. `left` defaults to the full budget (first call and pause_turn hops).
 *  read_page is always sent whole when the agent has it: its budget lives in code (runReads), and the
 *  conversation may already hold read_page calls, which need the tool still defined. */
function toolsFor(budget, left = budget) {
  const tools = [];
  if (left.searches > 0) tools.push({ type: SEARCH_TOOL, name: 'web_search', max_uses: left.searches });
  if (left.fetches > 0) tools.push({ type: FETCH_TOOL, name: 'web_fetch', max_uses: left.fetches,
    max_content_tokens: budget.fetchTokens, citations: { enabled: true } });
  if (budget.reads > 0) tools.push(readTool(budget.reads));
  return tools.length ? tools : null;
}

/** Run the read_page calls in one reply. Returns the tool_result blocks for the next user turn,
 *  how many opens were spent and what was opened. `left` is what the order has left.
 *  reader/asText default to page-reader.js (loaded only when needed). */
async function runReads(content, left, { reader, asText } = {}) {
  if (!reader || !asText) {
    const pr = require('./page-reader.js');
    reader = reader || pr.readPage; asText = asText || pr.asToolText;
  }
  const results = [], opened = [];
  let used = 0;
  for (const b of content || []) {
    if (b.type !== 'tool_use') continue;
    let out;
    if (b.name !== READ_TOOL_NAME) out = `UNKNOWN TOOL ${b.name}`;
    else if (used >= left) out = 'PAGE NOT OPENED: no page opens left for this order. Write your reply now.';
    else {
      used++;
      const input = b.input || {};
      const url = String(input.url || '');
      let got;
      try { got = await reader(url, { part: input.part === 'end' ? 'end' : 'start', allowHosts: DATA_HOSTS }); }
      catch (e) { got = { ok: false, address: url, error: 'the reader failed' }; }
      opened.push({ url: url.slice(0, 300), final: got.ok ? got.final : undefined, ok: !!got.ok, error: got.ok ? undefined : got.error });
      out = asText(got);
    }
    results.push({ type: 'tool_result', tool_use_id: b.id, content: out });
  }
  return { results, used, opened };
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
    reads: budget.reads,
  };
}

/** Ids of server tool calls that came back with a result (search OR page). The condense retry keeps
 *  only these; a call kept without its result, or a result without its call, is a 400. */
function answeredIds(content) {
  return new Set((content || [])
    .filter(b => b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result')
    .map(b => b.tool_use_id));
}

/** Blocks safe to resend as a finished assistant turn: unanswered server calls dropped, and any
 *  read_page call dropped (its result would have to come in the next user turn). */
function finishedBlocks(content) {
  const done = answeredIds(content);
  return (content || []).filter(b => b.type !== 'tool_use' && (b.type !== 'server_tool_use' || done.has(b.id)));
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

module.exports = { SEARCH_TOOL, FETCH_TOOL, READ_TOOL_NAME, DATA_HOSTS, READ_CHARS, budgetFrom, toolsFor, readTool,
  runReads, usesIn, leftAfter, answeredIds, finishedBlocks, openedPages, pastWall };
