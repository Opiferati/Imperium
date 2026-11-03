'use strict';
// ══════════════════════════════════════════════════════════════════════
// NORSE IMPERIUM — Preflight (2026-11-01)
// "Electrons in a row" before anything spends a token.
// Exit 0 = go. Exit 1 = stop, reason printed.
// ══════════════════════════════════════════════════════════════════════
const fs    = require('node:fs');
const path  = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
let failures = 0, warnings = 0;
const ok   = m => console.log(`  [ OK ] ${m}`);
const bad  = m => { console.log(`  [FAIL] ${m}`); failures++; };
const warn = m => { console.log(`  [WARN] ${m}`); warnings++; };

async function main() {
  console.log('\n  Preflight checks');
  console.log('  ─────────────────────────────────────────');

  // 1. Node version (node:sqlite needs 22.5+)
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 5)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} — need 22.5 or newer (node:sqlite)`);

  // 2. API key
  let key = process.env.ANTHROPIC_API_KEY;
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/m);
    if (m) key = m[1].replace(/^["']|["']$/g, '');
  } catch {}
  if (!key || key === 'your-api-key-here') bad('ANTHROPIC_API_KEY missing — put it in C:\\Imperium\\.env');
  else ok('API key present in .env');

  // 3. Registry
  let registry = null;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'imperium-registry.json'), 'utf8'));
    ok(`Registry: ${Object.keys(registry.agents).length} ministries, $${registry.budget.daily_limit_usd}/day, Forseti ${(registry.forseti || registry.critic)?.enabled === false ? 'off' : 'on'}, web search: ${Object.entries(registry.agents).filter(([,a]) => a.web_search).map(([k]) => k.replace('ministry-of-','')).join(', ') || 'none'}`);
  } catch (e) { bad(`Registry unreadable: ${e.message}`); }

  // 4. Souls
  if (registry) {
    for (const [id, a] of Object.entries(registry.agents)) {
      if (!fs.existsSync(path.join(ROOT, a.workspace, 'SOUL.md'))) bad(`${id}: SOUL.md missing in ${a.workspace}`);
    }
  }

  // 5. Databases open
  try {
    const { DatabaseSync } = require('node:sqlite');
    for (const [f, t] of [['message_bus.db', 'messages'], ['imperial-ledger.db', 'api_calls']]) {
      const db = new DatabaseSync(path.join(ROOT, 'data', f));
      db.prepare(`SELECT COUNT(*) n FROM ${t}`).get();
      db.close();
    }
    ok('Message bus and ledger open');
  } catch (e) { bad(`Database problem: ${e.message}`); }

  // 6. Code compiles
  const files = ['warden.js', 'imperium-terminal.js', 'send.js', 'check-imperium.js',
                 'runners/code-writer.js', 'runners/forseti.js'];
  const broken = files.filter(f => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); return false; }
    catch { return true; }
  });
  if (broken.length) bad(`Syntax errors in: ${broken.join(', ')}`); else ok(`Code checks out (${files.length} files)`);

  // 7. Leftover queue — things that would start spending the moment the Warden wakes
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(ROOT, 'data', 'message_bus.db'));
    const q = db.prepare(`SELECT COUNT(*) n FROM messages WHERE status IN ('queued','in_progress') AND to_agent <> 'emperor'`).get().n;
    db.close();
    if (q > 0) warn(`${q} leftover message(s) queued from last time — they will run. Clear with: node send.js --clear`);
  } catch {}

  // 8. Key works + models exist (free call: lists models, no tokens)
  if (process.env.IMPERIUM_SKIP_API_CHECK) warn('API check skipped (IMPERIUM_SKIP_API_CHECK set)');
  else if (key && registry && failures === 0) {
    const res = await new Promise(resolve => {
      const req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/models?limit=100', method: 'GET',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, timeout: 8000
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d })); });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
      req.on('error', e => resolve({ status: 0, body: e.message }));
      req.end();
    });
    if (res.status === 200) {
      ok('Anthropic API reachable, key accepted');
      let ids = [], models = [];
      try { models = JSON.parse(res.body).data; ids = models.map(m => m.id); } catch {}
      // Web search: on by default for every org; an admin can switch it off at
      // platform.claude.com/settings/capabilities. Check the model says it supports it.
      for (const [id, a] of Object.entries(registry.agents)) {
        if (!a.web_search) continue;
        const mid = registry.models[a.model] || a.model;
        const ws = models.find(m => m.id === mid)?.capabilities?.server_tools?.web_search?.supported;
        if (ws === false) warn(`${mid} does not support web search — ${id} will fail research jobs. Switch its model in the registry.`);
        else if (ws === true) ok(`Web search supported on ${mid} (${id})`);
      }
      const wanted = [...new Set(Object.values(registry.models))];
      const missing = wanted.filter(m => ids.length && !ids.includes(m));
      if (missing.length) warn(`Model(s) not offered to this key: ${missing.join(', ')}`);
      else if (ids.length) ok(`Models available: ${wanted.join(', ')}`);
    } else if (res.status === 401 || res.status === 403) {
      bad(`API key rejected (HTTP ${res.status}) — check .env`);
    } else {
      warn(`Couldn't reach the API (${res.status || res.body}) — offline? The Warden will report errors per task.`);
    }
  }

  console.log('  ─────────────────────────────────────────');
  if (failures) { console.log(`  ${failures} problem(s). Not starting.\n`); process.exit(1); }
  console.log(`  All clear${warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}.\n`);
}
main();
