'use strict';

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const HTML_PATH      = '/mnt/c/Imperium/imperium-oracle.html';
const LEDGER_PATH    = '/mnt/c/Imperium/data/imperial-ledger.db';
const BUS_PATH       = '/mnt/c/Imperium/data/message_bus.db';
const HEARTBEAT_PATH = '/mnt/c/Imperium/data/warden-heartbeat.json';
const PORT           = 7979;
const DAILY_LIMIT    = 2.00;

function getStatus() {
  const result = { daily_spend: 0, daily_limit: DAILY_LIMIT, queued: 0, warden_alive: false };

  try {
    const ledger = new DatabaseSync(LEDGER_PATH);
    const row = ledger.prepare(
      "SELECT COALESCE(SUM(total_usd),0) as total FROM daily_totals WHERE date = date('now')"
    ).get();
    result.daily_spend = row ? row.total : 0;
    ledger.close();
  } catch (e) {
    console.error('[STATUS] ledger error:', e.message);
  }

  try {
    const bus = new DatabaseSync(BUS_PATH);
    const row = bus.prepare(
      "SELECT COUNT(*) as n FROM messages WHERE status='queued'"
    ).get();
    result.queued = row ? row.n : 0;
    bus.close();
  } catch (e) {
    console.error('[STATUS] bus error:', e.message);
  }

  try {
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
    result.warden_alive = hb.alive === true && (Date.now() - hb.ts) < 30000;
  } catch (e) {
    result.warden_alive = false;
  }

  return result;
}

function insertDecree(text) {
  const bus = new DatabaseSync(BUS_PATH);
  const taskId = 'TASK-' + Date.now() + '-UI';
  bus.prepare(
    "INSERT INTO messages (task_id, from_agent, to_agent, content, status, priority) VALUES (?,?,?,?,'queued',2)"
  ).run(taskId, 'emperor', 'imperial-chancellor', JSON.stringify({ action: 'decree', text, sent_at: new Date().toISOString() }));
  bus.close();
  return taskId;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const pathname = req.url.split('?')[0];

  if (req.method === 'GET' && pathname === '/') {
    try {
      const html = fs.readFileSync(HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('Could not read HTML: ' + e.message);
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/status') {
    const status = getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  if (req.method === 'POST' && pathname === '/decree') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || !text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'text required' }));
          return;
        }
        const taskId = insertDecree(text.trim());
        console.log('[DECREE] queued:', taskId, '|', text.slice(0, 80));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, task_id: taskId }));
      } catch (e) {
        console.error('[DECREE] error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[SERVER] Port ${PORT} already in use — kill existing process first`);
  } else {
    console.error('[SERVER] error:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`=== Norse Imperium Oracle Server ===`);
  console.log(`Port:      ${PORT}`);
  console.log(`HTML:      ${HTML_PATH}`);
  console.log(`Ledger:    ${LEDGER_PATH}`);
  console.log(`Bus:       ${BUS_PATH}`);
  console.log(`Heartbeat: ${HEARTBEAT_PATH}`);
  console.log(`Ready.`);
});
