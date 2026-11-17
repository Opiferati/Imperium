'use strict';
// Glossary and concept tests for the Page Skimmer (Phase 1, offline).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sk = require(path.join(__dirname, '..', 'runners', 'skimmer.js'));

const LIB = path.join(__dirname, '..', 'library');
const cfg = sk.loadConfig();
const labels = q => sk.buildConcepts(q, cfg).concepts.map(c => c.label);

test('the glossary passes its own schema check', () => {
  assert.deepStrictEqual(sk.checkGlossary(cfg.glossary), []);
});

test('the change log parses and starts at version 1', () => {
  const lines = fs.readFileSync(path.join(LIB, 'glossary-changes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(lines[0].version, 1);
  assert.strictEqual(lines[lines.length - 1].version, cfg.glossary.version);
});

test('bad entries are refused', () => {
  const g = JSON.parse(JSON.stringify(cfg.glossary));
  g.entries.push({ id: 'g001', term: 'x', type: 'synonym', targets: ['y'] });          // repeated id
  g.entries.push({ id: 'z1', term: 'x', type: 'related', targets: ['y'] });            // no why
  g.entries.push({ id: 'z2', term: 'x', type: 'ambiguous', meanings: ['one'] });       // one meaning
  g.entries.push({ id: 'z3', term: 'x', type: 'cousin', targets: ['y'] });             // unknown type
  assert.strictEqual(sk.checkGlossary(g).length, 4);
});

test('related terms never sit inside a synonym or alias group', () => {
  const groups = cfg.glossary.entries.filter(e => e.type === 'synonym' || e.type === 'alias');
  const inGroup = new Set(groups.flatMap(e => [e.term, ...e.targets]).map(s => s.toLowerCase()));
  for (const r of cfg.glossary.entries.filter(e => e.type === 'related')) {
    for (const t of r.targets) assert.ok(!inGroup.has(t.toLowerCase()) || t.toLowerCase() === r.term.toLowerCase(), `${t} is related to ${r.term} but also a synonym`);
  }
});

test('synonyms join one concept: quake and earthquake', () => {
  assert.deepStrictEqual(labels('earthquake'), labels('quake'));
  assert.deepStrictEqual(labels('earthquake quake'), ['earthquake']);
});

test('aliases join: Wolf number is sunspot number', () => {
  assert.deepStrictEqual(labels('Wolf number'), ['sunspot number']);
  assert.deepStrictEqual(labels('international sunspot number'), ['sunspot number']);
});

test('an unambiguous abbreviation joins only on its exact capitals', () => {
  assert.deepStrictEqual(labels('Mw'), ['Mw']);
  assert.deepStrictEqual(labels('moment magnitude'), ['Mw']);
  assert.notDeepStrictEqual(labels('mw'), ['Mw']);
});

test('related terms do not join: tremor stays its own concept', () => {
  assert.deepStrictEqual(labels('earthquake tremor'), ['earthquake', 'tremor']);
  assert.deepStrictEqual(labels('Kp geomagnetic storm'), ['kp', 'geomagnetic', 'storm']);
});

test('ambiguous terms in the question are set aside, not expanded', () => {
  const b = sk.buildConcepts('SSN in October', cfg);
  assert.deepStrictEqual(b.ignored, ['SSN']);
  assert.deepStrictEqual(b.concepts.map(c => c.label), ['october']);
});

test('number and date pieces never become concepts', () => {
  assert.deepStrictEqual(labels('M6.1 earthquake on March 3, 2026 with Kp 7'), ['earthquake', 'kp']);
});

test('a settings file expecting another glossary version is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skim-gloss-'));
  try {
    const s = JSON.parse(fs.readFileSync(path.join(LIB, 'skimmer-settings.json'), 'utf8'));
    s.glossary_version = 2;
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify(s));
    assert.throws(() => sk.loadConfig({ settingsPath: path.join(dir, 's.json') }), /glossary version/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the settings hash is the hash of the file bytes', () => {
  const crypto = require('node:crypto');
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(LIB, 'skimmer-settings.json'))).digest('hex');
  assert.strictEqual(cfg.settings_hash, h);
});
