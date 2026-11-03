'use strict';
// ── check-imperium.js — Status check for the Norse Imperium
// Shows: Warden status, daily spend, last 10 tasks, pending messages

const fs   = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT           = __dirname;
const BUS_DB_PATH    = path.join(ROOT, 'data', 'message_bus.db');
const LEDGER_DB_PATH = path.join(ROOT, 'data', 'imperial-ledger.db');
const HEARTBEAT_PATH = path.join(ROOT, 'data', 'warden-heartbeat.json');

console.log('');
console.log('=== NORSE IMPERIUM STATUS ===');
console.log('─────────────────────────────────────────');

// ── Warden heartbeat ──
try {
  const hb  = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
  const age = Math.round((Date.now() - hb.ts) / 1000);
  const alive = age < 30;
  console.log(`Warden:   ${alive ? 'ACTIVE' : 'OFFLINE'} (last heartbeat ${age}s ago)`);
  console.log(`Session:  ${hb.session_messages || 0} messages, ${hb.session_tokens || 0} tokens`);
} catch {
  console.log('Warden:   OFFLINE (no heartbeat file)');
}

// ── Daily spend ──
try {
  const ledgerDb = new DatabaseSync(LEDGER_DB_PATH);
  const row = ledgerDb.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_calls WHERE date(called_at) = date('now')`
  ).get();
  console.log(`Budget:   $${(row?.total ?? 0).toFixed(4)} / $${(()=>{try{return JSON.parse(fs.readFileSync(path.join(ROOT,'data','imperium-registry.json'),'utf8')).budget.daily_limit_usd.toFixed(2)}catch{return '2.00'}})()}`);
  ledgerDb.close();
} catch (e) {
  console.log(`Budget:   unable to read ledger (${e.message})`);
}

console.log('─────────────────────────────────────────');

// ── Recent tasks ──
try {
  const busDb = new DatabaseSync(BUS_DB_PATH);
  const tasks = busDb.prepare(
    `SELECT task_id, from_agent, to_agent, status, created_at
     FROM messages
     GROUP BY task_id
     ORDER BY MAX(id) DESC LIMIT 10`
  ).all();

  if (tasks.length === 0) {
    console.log('Tasks:    none');
  } else {
    console.log('Recent tasks:');
    for (const t of tasks) {
      console.log(`  ${t.task_id} | ${t.from_agent} -> ${t.to_agent} | ${t.status} | ${t.created_at}`);
    }
  }

  // Pending messages for Emperor
  const pending = busDb.prepare(
    `SELECT COUNT(*) as n FROM messages WHERE to_agent='emperor' AND status='queued'`
  ).get();
  if (pending.n > 0) {
    console.log(`\nPending for Emperor: ${pending.n} message(s)`);
  }

  busDb.close();
} catch (e) {
  console.log(`Tasks:    unable to read bus (${e.message})`);
}

console.log('─────────────────────────────────────────');
console.log('');
