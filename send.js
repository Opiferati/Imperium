'use strict';
// ── send.js — Insert a decree into the Norse Imperium bus
// Usage:
//   node send.js "your message"                          → new task to Chancellor
//   node send.js "your message" --to ministry-of-works   → direct to ministry
//   node send.js "your message" --task TASK-xxx           → reply in existing thread
//   node send.js --status TASK-xxx                        → show thread for a task
//   node send.js --clear                                  → cancel leftover queued work

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BUS_DB_PATH = path.join(__dirname, 'data', 'message_bus.db');
const db = new DatabaseSync(BUS_DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

const args = process.argv.slice(2);

// ── --status ───────────────────────────────────────────────────────────
if (args[0] === '--status') {
  const taskId = args[1];
  if (!taskId) { console.error('Usage: node send.js --status TASK-xxx'); process.exit(1); }
  const rows = db.prepare(
    `SELECT id, from_agent, to_agent, status, created_at FROM messages WHERE task_id=? ORDER BY id ASC`
  ).all(taskId);
  if (rows.length === 0) { console.log('No messages found for', taskId); process.exit(0); }
  console.log(`\nThread: ${taskId}\n`);
  for (const r of rows) {
    const arrow = `${r.from_agent} -> ${r.to_agent}`;
    console.log(`  #${r.id} [${r.status.padEnd(11)}] ${arrow.padEnd(35)} ${r.created_at}`);
  }
  console.log('');
  process.exit(0);
}

// ── --clear ────────────────────────────────────────────────────────────
if (args[0] === '--clear') {
  const r = db.prepare(
    `UPDATE messages SET status='cancelled', updated_at=datetime('now')
     WHERE status IN ('queued','in_progress') AND to_agent <> 'emperor'`
  ).run();
  try {
    db.prepare(`UPDATE tasks SET status='failed', completed_at=datetime('now')
                WHERE status IN ('pending','in_progress')`).run();
  } catch {}
  console.log(`Cancelled ${r.changes} leftover message(s).`);
  process.exit(0);
}

// ── send ───────────────────────────────────────────────────────────────
const text = args[0];
if (!text) {
  console.log('Usage:');
  console.log('  node send.js "message"');
  console.log('  node send.js "message" --to <agent>');
  console.log('  node send.js "message" --task TASK-xxx');
  console.log('  node send.js --status TASK-xxx');
  process.exit(0);
}

let toAgent = 'imperial-chancellor';
let taskId  = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--to'   && args[i+1]) { toAgent = args[++i]; }
  if (args[i] === '--task' && args[i+1]) { taskId  = args[++i]; }
}

if (!taskId) {
  taskId = 'TASK-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 15) + '-' +
           Math.random().toString(36).slice(2, 6).toUpperCase();
}

const content = JSON.stringify({ action: 'decree', text, sent_at: new Date().toISOString() });

db.prepare(
  `INSERT INTO messages (task_id, from_agent, to_agent, content, status, priority)
   VALUES (?, 'emperor', ?, ?, 'queued', 1)`
).run(taskId, toAgent, content);

console.log('');
console.log('=== Decree Queued ===');
console.log(`  To:      ${toAgent}`);
console.log(`  Task:    ${taskId}`);
console.log(`  Message: ${text}`);
console.log('');
