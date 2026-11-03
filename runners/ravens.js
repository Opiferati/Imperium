// runners/ravens.js — Huginn & Muninn, the Ravens' Report (2026-11-02)
// Plain code, $0. Reads what the Imperium already records and returns a
// "state of the realm" so the Chancellor (and the dashboard) can see the kingdom.
//   Huginn (Thought) — what is happening now: Warden, budget, queue, petitions.
//   Muninn (Memory)  — what has happened: recent tasks, ministries, Skald, Relic Vault.
// Every number comes straight from the databases and files. Nothing is invented.
'use strict';
const fs   = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TZ = 'America/New_York';

function etTime(utc) {               // '2026-11-02 07:56:57' (SQLite UTC) or ms -> 'Nov 2, 2:56 AM'
  if (utc == null) return null;
  const d = typeof utc === 'number' ? new Date(utc) : new Date(String(utc).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(utc);
  return d.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
function utcMs(s) { return new Date(String(s).replace(' ', 'T') + 'Z').getTime(); }
function short(s, n) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function withDb(p, fn, fallback) {
  let db;
  try { db = new DatabaseSync(p); return fn(db); }
  catch { return fallback; }
  finally { try { db && db.close(); } catch {} }
}

function gather(root) {
  const data   = path.join(root, 'data');
  const busP   = path.join(data, 'message_bus.db');
  const ledP   = path.join(data, 'imperial-ledger.db');
  const now    = Date.now();
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(path.join(data, 'imperium-registry.json'), 'utf8')); } catch {}

  // ── Huginn: now ──
  let warden = { alive: false, status: 'offline', current_agent: null, last_beat: null };
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(data, 'warden-heartbeat.json'), 'utf8'));
    const age = now - hb.ts;
    warden = { alive: age < 30000, status: age < 30000 ? (hb.status || 'idle') : 'offline',
               current_agent: hb.current_agent || null, last_beat: ago(age) };
  } catch {}

  const limit = registry.budget?.daily_limit_usd ?? 2;
  const spend = withDb(ledP, db => db.prepare(
    `SELECT COALESCE(SUM(cost_usd),0) t, COUNT(*) n FROM api_calls WHERE date(called_at) = date('now')`).get(), { t: 0, n: 0 });
  const budget = { spent: +spend.t.toFixed(4), calls: spend.n, limit,
                   left: +Math.max(0, limit - spend.t).toFixed(4), pct: Math.round(spend.t / limit * 100),
                   day_note: 'budget day runs midnight-to-midnight UTC (resets 7-8 PM New York)' };

  const queue = withDb(busP, db => db.prepare(
    `SELECT task_id, to_agent, status, created_at FROM messages
     WHERE status IN ('queued','in_progress') ORDER BY created_at LIMIT 10`).all(), [])
    .map(r => ({ task: r.task_id, to: r.to_agent, status: r.status, since: ago(now - utcMs(r.created_at)) }));

  const petitions = withDb(busP, db => db.prepare(
    `SELECT task_id, agent, request, created_at FROM petitions WHERE status='pending' ORDER BY created_at`).all(), [])
    .map(r => ({ task: r.task_id, agent: r.agent, request: short(r.request, 120), when: etTime(r.created_at) }));

  // ── Muninn: memory ──
  const tasks = withDb(busP, db => db.prepare(
    `SELECT id, title, status, cost_usd, forseti_verdict, forseti_fails, artifact_path, created_at
     FROM tasks ORDER BY created_at DESC LIMIT 8`).all(), [])
    .map(r => ({ id: r.id, title: short(r.title, 80), status: r.status, cost: +(r.cost_usd || 0).toFixed(4),
                 forseti: r.forseti_verdict || null, revisions: r.forseti_fails || 0,
                 artifact: r.artifact_path ? String(r.artifact_path).split(/[\\/]/).pop() : null, when: etTime(r.created_at) }));

  const taskStats = withDb(busP, db => db.prepare(
    `SELECT COUNT(*) total, SUM(status='done') done, SUM(status='failed') failed,
            SUM(status IN ('pending','in_progress')) open FROM tasks`).get(), {});

  const lastCalls = withDb(ledP, db => db.prepare(
    `SELECT agent_id, MAX(called_at) last, SUM(date(called_at)=date('now')) today, COUNT(*) total
     FROM api_calls GROUP BY agent_id`).all(), []);
  const byAgent = Object.fromEntries(lastCalls.map(r => [r.agent_id, r]));
  const roster = [...Object.keys(registry.agents || {}), 'forseti', 'ministry-of-skald'];
  const ministries = roster.map(id => {
    const r = byAgent[id];
    return { id, model: registry.agents?.[id]?.model || (id === 'forseti' ? registry.forseti?.model : registry.skald?.model) || null,
             last_worked: r ? etTime(r.last) : 'never', calls_today: r?.today || 0, calls_total: r?.total || 0 };
  });
  const retired = Object.keys(registry.retired || {});

  let skald = null;
  try {
    const lines = fs.readFileSync(path.join(data, 'skald-mood.csv'), 'utf8').trim().split(/\r?\n/);
    if (lines.length > 1) {
      const head = lines[0].split(','), row = lines[lines.length - 1].split(',');
      const g = k => row[head.indexOf(k)];
      skald = { date: g('date'), crypto_mood: +g('crypto_mood'), stock_mood: +g('stock_mood'),
                crypto_fear_greed: +g('crypto_fg'), stock_gauge: +g('stock_gauge'), readings: lines.length - 1 };
    }
  } catch {}

  let relics = [];
  try {
    const out = path.join(root, 'output');
    const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      if (e.name.startsWith('_')) return [];
      const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) return walk(p, r);
      return [{ file: r, ms: fs.statSync(p).mtimeMs }];
    });
    relics = walk(out).sort((a, b) => b.ms - a.ms).slice(0, 5).map(f => ({ file: f.file, when: etTime(f.ms) }));
  } catch {}

  return {
    as_of: etTime(now) + ' (New York)',
    huginn: { warden, budget, queue, petitions },
    muninn: { task_stats: { total: taskStats.total || 0, done: taskStats.done || 0, failed: taskStats.failed || 0, open: taskStats.open || 0 },
              recent_tasks: tasks, ministries, retired, skald, recent_relics: relics }
  };
}

// Compact text block for the Chancellor's system prompt (~300-500 words)
function toPrompt(r) {
  const h = r.huginn, m = r.muninn, L = [];
  L.push(`## THE RAVENS' REPORT — state of the realm as of ${r.as_of}`);
  L.push(`Gathered by plain code from the ledger, bus and files. These are facts; use them for any status question. Do not invent numbers that are not here.`);
  L.push(`### Huginn (now)`);
  L.push(`- Warden: ${h.warden.status}${h.warden.current_agent ? ` (working: ${h.warden.current_agent})` : ''}, last heartbeat ${h.warden.last_beat ?? 'unknown'}`);
  L.push(`- Budget: $${h.budget.spent} of $${h.budget.limit} spent today (${h.budget.pct}%, ${h.budget.calls} calls), $${h.budget.left} left — ${h.budget.day_note}`);
  L.push(`- Queue: ${h.queue.length ? h.queue.map(q => `${q.task} -> ${q.to} [${q.status}, ${q.since}]`).join('; ') : 'empty'}`);
  L.push(`- Petitions awaiting the Emperor: ${h.petitions.length ? h.petitions.map(p => `${p.agent}: ${p.request}`).join('; ') : 'none'}`);
  L.push(`### Muninn (memory)`);
  const s = m.task_stats;
  L.push(`- Saga ledger: ${s.total} tasks — ${s.done} done, ${s.failed} failed, ${s.open} open`);
  L.push(`- Recent tasks (newest first):`);
  for (const t of m.recent_tasks)
    L.push(`  - ${t.when} | ${t.status}${t.forseti ? ` | Forseti ${t.forseti}` : ''}${t.revisions ? ` (${t.revisions} fails)` : ''} | $${t.cost} | ${t.title}${t.artifact ? ` -> ${t.artifact}` : ''}`);
  L.push(`- Ministries (last worked / calls today / all-time):`);
  for (const x of m.ministries) L.push(`  - ${x.id} [${x.model ?? '?'}]: ${x.last_worked} / ${x.calls_today} / ${x.calls_total}`);
  if (m.retired.length) L.push(`- Retired: ${m.retired.join(', ')}`);
  L.push(m.skald ? `- Skald, last reading ${m.skald.date}: crypto mood ${m.skald.crypto_mood} (Fear & Greed ${m.skald.crypto_fear_greed}), stock mood ${m.skald.stock_mood} (gauge ${m.skald.stock_gauge}); ${m.skald.readings} reading(s) on file`
                 : `- Skald: no readings on file yet`);
  if (m.recent_relics.length) L.push(`- Newest in the Relic Vault: ${m.recent_relics.map(f => `${f.file} (${f.when})`).join('; ')}`);
  return L.join('\n');
}

module.exports = { gather, toPrompt };

if (require.main === module) {                       // node runners/ravens.js [--json]
  const r = gather(path.join(__dirname, '..'));
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : toPrompt(r));
}
