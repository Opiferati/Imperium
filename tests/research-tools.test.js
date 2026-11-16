'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rt = require('../runners/research-tools.js');

const intel = { model: 'haiku', web_search: { max_uses: 5 }, web_fetch: { max_uses: 3, max_content_tokens: 15000 } };

test('the ministry gets search and page reading, with its caps', () => {
  const b = rt.budgetFrom(intel);
  assert.deepEqual(b, { searches: 5, fetches: 3, fetchTokens: 15000 });
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
