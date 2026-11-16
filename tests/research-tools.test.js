'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rt = require('../runners/research-tools.js');

const intel = { model: 'haiku', web_search: { max_uses: 5 }, web_fetch: { max_uses: 3, max_content_tokens: 15000 } };

test('the ministry gets search and page reading, with its caps', () => {
  const b = rt.budgetFrom(intel);
  assert.deepEqual(b, { searches: 5, fetches: 3, fetchTokens: 15000, reads: 0 });
  assert.deepEqual(rt.toolsFor(b), [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, max_content_tokens: 15000, citations: { enabled: true } },
  ]);
});

test('an agent without web_fetch in the registry gets no page reader (nothing else changes)', () => {
  const b = rt.budgetFrom({ web_search: { max_uses: 5 } });
  assert.deepEqual(rt.toolsFor(b).map(t => t.name), ['web_search']);
  assert.equal(rt.toolsFor(rt.budgetFrom({ model: 'sonnet' })), null);
  assert.equal(rt.toolsFor(rt.budgetFrom(undefined)), null);
});

test('pause_turn hops resend the same tools: the API counts the turn, so no shrinking here', () => {
  const b = rt.budgetFrom(intel);
  assert.deepEqual(rt.toolsFor(b), rt.toolsFor(b, b));
});

test('the condense retry (a new turn) gets only what is left; a spent tool is left off', () => {
  const b = rt.budgetFrom(intel);
  const used = { searches: 5, fetches: 1 };
  const left = rt.leftAfter(b, used);
  assert.deepEqual(rt.toolsFor(b, left), [
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2, max_content_tokens: 15000, citations: { enabled: true } },
  ]);
  assert.equal(rt.toolsFor(b, rt.leftAfter(b, { searches: 9, fetches: 9 })), null);
});

test('uses are read from usage.server_tool_use, missing counts as zero', () => {
  assert.deepEqual(rt.usesIn({ server_tool_use: { web_search_requests: 2, web_fetch_requests: 3 } }), { searches: 2, fetches: 3 });
  assert.deepEqual(rt.usesIn({}), { searches: 0, fetches: 0 });
  assert.deepEqual(rt.usesIn(undefined), { searches: 0, fetches: 0 });
});

test('condense keeps a page call only with its result (the old filter knew searches only)', () => {
  const content = [
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
    { type: 'server_tool_use', id: 'f1', name: 'web_fetch', input: { url: 'https://earthquake.usgs.gov/x' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'f1', content: { type: 'web_fetch_result', url: 'https://earthquake.usgs.gov/x' } },
    { type: 'server_tool_use', id: 'f2', name: 'web_fetch', input: { url: 'https://pending.example/y' } },
    { type: 'text', text: 'cut off' },
  ];
  const kept = rt.finishedBlocks(content);
  assert.deepEqual(kept.filter(b => b.type === 'server_tool_use').map(b => b.id), ['s1', 'f1']);
  assert.equal(kept.length, 5);
});

test('opened pages go to the Sources record by address and title; failures are counted, never listed', () => {
  const content = [
    { type: 'web_fetch_tool_result', tool_use_id: 'f1', content: { type: 'web_fetch_result', url: 'https://www.swpc.noaa.gov/a',
      content: { type: 'document', title: 'Planetary K-index', source: { type: 'text', data: '...' } } } },
    { type: 'web_fetch_tool_result', tool_use_id: 'f2', content: { type: 'web_fetch_result', url: 'https://www.swpc.noaa.gov/a',
      content: { type: 'document', source: { type: 'text', data: '...' } } } },
    { type: 'web_fetch_tool_result', tool_use_id: 'f3', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_in_prior_context' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'f4', content: { type: 'web_fetch_result', url: 'https://fiscaldata.treasury.gov/b',
      content: { type: 'document', source: { type: 'text', data: '...' } } } },
  ];
  const { opened, failed } = rt.openedPages(content);
  assert.deepEqual([...opened], [['https://www.swpc.noaa.gov/a', 'Planetary K-index'], ['https://fiscaldata.treasury.gov/b', 'https://fiscaldata.treasury.gov/b']]);
  assert.deepEqual(failed, ['url_not_in_prior_context']);
  assert.deepEqual([...rt.openedPages(undefined).opened], []);
});

test('between hops, an order that would carry the day to the $2 wall stops', () => {
  assert.equal(rt.pastWall(1.80, 0.15, 2), false);
  assert.equal(rt.pastWall(1.80, 0.20, 2), true);
  assert.equal(rt.pastWall(2.00, 0, 2), true);
});

// -- read_page: Legion's own reader for the government data sites (2026-11-16, Trial IX Amendment 4) --
const fs = require('node:fs');
const path = require('node:path');
const intelRead = { ...intel, read_page: { max_uses: 3 } };

test('with read_page in the registry, the ministry gets it third, and it stays on every request', () => {
  const b = rt.budgetFrom(intelRead);
  assert.equal(b.reads, 3);
  const tools = rt.toolsFor(b);
  assert.deepEqual(tools.map(t => t.name), ['web_search', 'web_fetch', 'read_page']);
  assert.match(tools[2].description, /up to 3 pages/);
  assert.match(tools[2].description, /usgs\.gov, gfz\.de, gfz-potsdam\.de, noaa\.gov, sidc\.be, treasury\.gov/);
  // condense after everything is spent: the server tools drop, read_page stays defined (its budget is in code)
  const spent = rt.toolsFor(b, rt.leftAfter(b, { searches: 5, fetches: 3 }));
  assert.deepEqual(spent.map(t => t.name), ['read_page']);
  assert.deepEqual(rt.toolsFor(b), rt.toolsFor(b, b));
});

test('runReads opens within the budget, on the site list only, and answers every call', async () => {
  const seen = [];
  const reader = async (url, opts) => { seen.push([url, opts]); return { ok: true, final: url, text: 'x' }; };
  const asText = r => (r.ok ? `PAGE ${r.final}` : `PAGE NOT OPENED: ${r.error}`);
  const content = [
    { type: 'text', text: 'reading' },
    { type: 'tool_use', id: 't1', name: 'read_page', input: { url: 'https://earthquake.usgs.gov/q?starttime=2026-11-01', part: 'end' } },
    { type: 'tool_use', id: 't2', name: 'read_page', input: { url: 'https://services.swpc.noaa.gov/k.json' } },
    { type: 'tool_use', id: 't3', name: 'something_else', input: {} },
  ];
  const r = await rt.runReads(content, 1, { reader, asText });
  assert.equal(r.used, 1);
  assert.deepEqual(r.results.map(x => x.tool_use_id), ['t1', 't2', 't3']);
  assert.equal(r.results[0].content, 'PAGE https://earthquake.usgs.gov/q?starttime=2026-11-01');
  assert.match(r.results[1].content, /no page opens left/);
  assert.match(r.results[2].content, /UNKNOWN TOOL something_else/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1].part, 'end');
  assert.deepEqual(seen[0][1].allowHosts, rt.DATA_HOSTS);
  assert.deepEqual(r.opened, [{ url: 'https://earthquake.usgs.gov/q?starttime=2026-11-01', final: 'https://earthquake.usgs.gov/q?starttime=2026-11-01', ok: true, error: undefined }]);
});

test('runReads records a refused page as a failure, never as a source', async () => {
  const reader = async url => ({ ok: false, address: url, error: 'evil.example is not on this reader\'s site list' });
  const asText = r => `PAGE NOT OPENED: ${r.error}`;
  const r = await rt.runReads([{ type: 'tool_use', id: 'a', name: 'read_page', input: { url: 'https://evil.example/?d=secret' } }], 3, { reader, asText });
  assert.equal(r.used, 1);
  assert.equal(r.opened[0].ok, false);
  assert.equal(r.opened[0].final, undefined);
  assert.match(r.results[0].content, /not on this reader's site list/);
});

test('condense drops a read_page call (its result would belong to the next turn)', () => {
  const kept = rt.finishedBlocks([
    { type: 'text', text: 'a' },
    { type: 'tool_use', id: 'r1', name: 'read_page', input: { url: 'https://earthquake.usgs.gov/x' } },
  ]);
  assert.deepEqual(kept.map(b => b.type), ['text']);
});

const READER = path.join(__dirname, '..', 'runners', 'page-reader.js');
test('read_page settings match the shared reader and Trial IX\'s site list', { skip: !fs.existsSync(READER) }, () => {
  const pr = require(READER);
  assert.equal(rt.READ_CHARS, pr.MAX_CHARS);
  const trialIx = path.join(__dirname, '..', 'runners', 'trial-ix.js');
  if (fs.existsSync(trialIx)) {
    const m = /const PAGE_HOSTS = Object\.freeze\((\[[^\]]*\])\)/.exec(fs.readFileSync(trialIx, 'utf8'));
    assert.ok(m, 'PAGE_HOSTS not found in trial-ix.js');
    assert.deepEqual([...rt.DATA_HOSTS], JSON.parse(m[1].replace(/'/g, '"')));
  }
  for (const h of rt.DATA_HOSTS) assert.equal(pr.hostAllowed('www.' + h, rt.DATA_HOSTS), true);
  assert.equal(pr.hostAllowed('usgs.gov.evil.example', rt.DATA_HOSTS), false);
});
