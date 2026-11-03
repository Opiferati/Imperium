'use strict';
// ══════════════════════════════════════════════════════════════════════
// NORSE IMPERIUM TERMINAL — Web UI + API server on port 7878
// Run: node imperium-terminal.js
// ══════════════════════════════════════════════════════════════════════

const http  = require('node:http');
const https = require('node:https');
const fs    = require('node:fs');
const path  = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT           = __dirname;
const BUS_DB_PATH    = path.join(ROOT, 'data', 'message_bus.db');
const LEDGER_DB_PATH = path.join(ROOT, 'data', 'imperial-ledger.db');
const HEARTBEAT_PATH = path.join(ROOT, 'data', 'warden-heartbeat.json');
const SETTINGS_PATH  = path.join(ROOT, 'data', 'settings.json');
const OUTPUT_DIR     = path.join(ROOT, 'output');
const LIBRARY_DIR    = path.join(ROOT, 'library');
const UI_PATH        = path.join(ROOT, 'imperium-ui.html');
const PORT           = 7878;

// ── Content parser ─────────────────────────────────────────────────────
function parseContent(raw) {
  let text = raw;
  try {
    const p = JSON.parse(raw);
    if (typeof p === 'string') text = p;
    else if (p && typeof p === 'object') {
      const extracted = p.response ?? p.message ?? p.text ?? p.result ?? raw;
      text = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
    }
  } catch { /* not JSON */ }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text || '(no content)';
}

// ── Helpers ─────────────────────────────────────────────────────────────
function json(res, data, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      if (body.length > 65_536) { req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

// Recursively list files up to maxDepth levels
// Resolve a vault-relative path; refuse anything that escapes output/ (incl. via symlinks)
function safeOutputPath(rel) {
  if (!rel || rel.includes('\0')) return null;
  try {
    const root = fs.realpathSync(OUTPUT_DIR);
    const full = fs.realpathSync(path.resolve(OUTPUT_DIR, rel));
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    return fs.statSync(full).isFile() ? full : null;
  } catch { return null; }
}

function listFiles(dir, maxDepth, currentDepth) {
  const results = [];
  if (currentDepth > maxDepth) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      if (e.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            name: e.name,
            path: fullPath,
            rel: path.relative(OUTPUT_DIR, fullPath).split(path.sep).join('/'),
            size_bytes: stat.size,
            modified_at: stat.mtime.toISOString()
          });
        } catch { /* skip unreadable */ }
      } else if (e.isDirectory() && currentDepth < maxDepth) {
        results.push(...listFiles(fullPath, maxDepth, currentDepth + 1));
      }
    }
  } catch { /* dir missing */ }
  return results;
}

// ── Request handler ──────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const urlParts = req.url.split('?');
  const url = urlParts[0];
  const params = new URLSearchParams(urlParts[1] || '');

  // ── GET / — serve UI HTML file ──
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = fs.readFileSync(UI_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="background:#0c0b08;color:#c8962a;font-family:Georgia;padding:40px"><h1>Norse Imperium</h1><p>imperium-ui.html not found. Build the UI file first.</p></body></html>');
    }
    return;
  }

  // ── GET /app-icon.ico — the Imperium icon, so the app window and taskbar show it (2026-11-01) ──
  if (req.method === 'GET' && url === '/app-icon.ico') {
    try {
      const ico = fs.readFileSync(path.join(ROOT, 'Imperium.ico'));
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'max-age=86400' });
      res.end(ico);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  // ── GET /mascot/<file>.png — mascot frames from library/Images (2026-11-01) ──
  if (req.method === 'GET' && url.startsWith('/mascot/')) {
    const name = path.basename(decodeURIComponent(url.slice(8)));
    if (!/^[\w.-]+\.png$/.test(name)) { res.writeHead(404); res.end(); return; }
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'library', 'Images', name));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  // ── GET /api/status ──
  if (req.method === 'GET' && url === '/api/status') {
    let wardenAlive = false;
    let sessionTokens = 0;
    let wardenStatus = 'offline', currentAgent = null;
    try {
      const hb = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
      const age = Date.now() - hb.ts;
      wardenAlive = age < 30_000;
      sessionTokens = hb.session_tokens || 0;
      if (wardenAlive) { wardenStatus = hb.status || 'idle'; currentAgent = hb.current_agent || null; }
    } catch { /* not started */ }

    let dailySpend = 0;
    const ledgerDb = new DatabaseSync(LEDGER_DB_PATH);
    try {
      const row = ledgerDb.prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_calls WHERE date(called_at) = date('now')`
      ).get();
      dailySpend = row?.total ?? 0;
    } finally { try { ledgerDb.close(); } catch {} }

    json(res, { warden_alive: wardenAlive, warden_status: wardenStatus, current_agent: currentAgent, daily_spend: dailySpend, budget: (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname,'data','imperium-registry.json'),'utf8')).budget.daily_limit_usd; } catch { return 2.00; } })(), session_tokens: sessionTokens });
    return;
  }

  // ── GET /api/ravens — Huginn & Muninn, the state of the realm (plain code, $0) (2026-11-02) ──
  if (req.method === 'GET' && url === '/api/ravens') {
    try {
      const ravens = require('./runners/ravens.js');
      const report = ravens.gather(ROOT);
      json(res, { ...report, text: ravens.toPrompt(report) });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── POST /api/send ──
  if (req.method === 'POST' && url === '/api/send') {
    try {
      const { content } = await readBody(req);
      if (!content?.trim()) { json(res, { error: 'empty message' }, 400); return; }
      const taskId = 'TASK-' +
        new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 15) + '-' +
        Math.random().toString(36).slice(2, 6).toUpperCase();
      const db = new DatabaseSync(BUS_DB_PATH);
      try {
        db.prepare(
          `INSERT INTO messages (task_id, from_agent, to_agent, content, status, priority)
           VALUES (?, 'emperor', 'imperial-chancellor', ?, 'queued', 1)`
        ).run(taskId, JSON.stringify({ action: 'decree', text: content.trim(), sent_at: new Date().toISOString() }));
        json(res, { task_id: taskId });
      } finally { try { db.close(); } catch {} }
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── POST /api/treasury/scan — ask the Warden to run the Finalance v2 scan ──
  if (req.method === 'POST' && url === '/api/treasury/scan') {
    const taskId = 'TASK-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 15) + '-TRSY';
    const db = new DatabaseSync(BUS_DB_PATH);
    try {
      const busy = db.prepare(
        `SELECT COUNT(*) n FROM messages WHERE to_agent='ministry-of-treasury' AND status IN ('queued','in_progress')`).get().n;
      if (busy) { json(res, { error: 'A Treasury scan is already queued.' }, 409); return; }
      db.prepare(`INSERT INTO messages (task_id, from_agent, to_agent, content, status, priority)
                  VALUES (?, 'emperor', 'ministry-of-treasury', ?, 'queued', 1)`)
        .run(taskId, JSON.stringify({ action: 'treasury_scan', sent_at: new Date().toISOString() }));
      json(res, { task_id: taskId });
    } catch (e) { json(res, { error: e.message }, 500); }
    finally { try { db.close(); } catch {} }
    return;
  }

  // ── Petitions (Edict VIII): GET pending, POST /api/petitions/<id>/approve|deny ──
  if (req.method === 'GET' && url === '/api/petitions') {
    const db = new DatabaseSync(BUS_DB_PATH);
    try {
      let rows = [];
      try {
        rows = db.prepare(`SELECT p.id, p.task_id, p.agent, p.request, p.created_at, t.title
                           FROM petitions p LEFT JOIN tasks t ON t.id = p.task_id
                           WHERE p.status = 'pending' ORDER BY p.id`).all();
      } catch { /* table appears once the Warden has started */ }
      json(res, rows);
    } catch (e) { json(res, { error: e.message }, 500); }
    finally { try { db.close(); } catch {} }
    return;
  }
  const pm = url.match(/^\/api\/petitions\/(\d+)\/(approve|deny)$/);
  if (req.method === 'POST' && pm) {
    const db = new DatabaseSync(BUS_DB_PATH);
    try {
      const p = db.prepare(`SELECT * FROM petitions WHERE id = ?`).get(+pm[1]);
      if (!p || p.status !== 'pending') { json(res, { error: 'That petition is not pending.' }, 409); return; }
      if (pm[2] === 'deny') {
        db.prepare(`UPDATE petitions SET status='denied', decided_at=datetime('now') WHERE id=?`).run(p.id);
        json(res, { ok: true, status: 'denied' }); return;
      }
      if (p.kind === 'gate') {   // Ask-First Gate (2026-11-03): one approval = one write of that file, 24 h
        db.exec(`CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, petition_id INTEGER, task_id TEXT,
                 target TEXT NOT NULL, granted_at TEXT DEFAULT (datetime('now')), used_at TEXT)`);
        db.prepare(`INSERT INTO approvals (petition_id, task_id, target) VALUES (?, ?, ?)`).run(p.id, p.task_id, p.target);
        const gTask = 'TASK-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 15) + '-GATE';
        const gText = `ASK-FIRST #${p.id} APPROVED by the Emperor: ${p.agent} may write ${p.target} once (within 24 hours). ` +
          `Original task: ${p.task_id}. Dispatch ${p.agent} to write that file again, with the same content it produced before.`;
        db.prepare(`INSERT INTO messages (task_id, from_agent, to_agent, content, status, priority)
                    VALUES (?, 'emperor', 'imperial-chancellor', ?, 'queued', 1)`)
          .run(gTask, JSON.stringify({ action: 'decree', text: gText, sent_at: new Date().toISOString() }));
        db.prepare(`UPDATE petitions SET status='approved', decided_at=datetime('now'), granted_task=? WHERE id=?`).run(gTask, p.id);
        json(res, { ok: true, status: 'approved', task_id: gTask }); return;
      }
      const t = db.prepare(`SELECT title, artifact_path FROM tasks WHERE id = ?`).get(p.task_id) || {};
      const first = db.prepare(`SELECT content FROM messages WHERE task_id=? AND from_agent='emperor' ORDER BY id LIMIT 1`).get(p.task_id);
      let order = t.title || '';
      try { const j = JSON.parse(first.content); order = j.text || order; } catch { if (first) order = first.content; }
      const art = String(t.artifact_path || '').split(';')[0].trim();
      const companion = art ? art.replace(/(\.[A-Za-z0-9]+)$/, '-extended$1') : '(name it <original>-extended)';
      const taskId = 'TASK-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 15) + '-PETX';
      const text = `PETITION #${p.id} GRANTED by the Emperor. ${p.agent} asked: "${p.request}". ` +
        `Original order: ${order}\n\nDispatch ${p.agent} to write the extended version within the approved length, ` +
        `as a companion file at ${companion}. The earlier in-scope file stays as it is.`;
      db.prepare(`INSERT INTO messages (task_id, from_agent, to_agent, content, status, priority)
                  VALUES (?, 'emperor', 'imperial-chancellor', ?, 'queued', 1)`)
        .run(taskId, JSON.stringify({ action: 'decree', text, sent_at: new Date().toISOString() }));
      db.prepare(`UPDATE petitions SET status='approved', decided_at=datetime('now'), granted_task=? WHERE id=?`).run(taskId, p.id);
      json(res, { ok: true, status: 'approved', task_id: taskId });
    } catch (e) { json(res, { error: e.message }, 500); }
    finally { try { db.close(); } catch {} }
    return;
  }

  // ── POST /api/skald/scan — ask the Warden for a Skald reading now ──
  if (req.method === 'POST' && url === '/api/skald/scan') {
    const taskId = 'TASK-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 15) + '-SKLD';
    const db = new DatabaseSync(BUS_DB_PATH);
    try {
      const busy = db.prepare(
        `SELECT COUNT(*) n FROM messages WHERE to_agent='ministry-of-skald' AND status IN ('queued','in_progress')`).get().n;
      if (busy) { json(res, { error: 'A Skald reading is already queued.' }, 409); return; }
      db.prepare(`INSERT INTO messages (task_id, from_agent, to_agent, content, status, priority)
                  VALUES (?, 'emperor', 'ministry-of-skald', ?, 'queued', 2)`)
        .run(taskId, JSON.stringify({ action: 'skald_reading', auto: false, sent_at: new Date().toISOString() }));
      json(res, { task_id: taskId });
    } catch (e) { json(res, { error: e.message }, 500); }
    finally { try { db.close(); } catch {} }
    return;
  }

  // ── GET /api/messages?after=<id> — Emperor-addressed messages ──
  if (req.method === 'GET' && url === '/api/messages') {
    const afterId = parseInt(params.get('after') || '0', 10);
    const db = new DatabaseSync(BUS_DB_PATH);
    try {
      const rows = db.prepare(
        `SELECT id, from_agent, content, created_at FROM messages
         WHERE to_agent='emperor' AND id > ?
         ORDER BY id ASC LIMIT 50`
      ).all(afterId);
      json(res, rows.map(r => ({
        id: r.id, from: r.from_agent, time: r.created_at,
        text: parseContent(r.content)
      })));
    } finally { try { db.close(); } catch {} }
    return;
  }

  // ── GET /api/feed?after=<id> — full conversation feed (all agents) ──
  if (req.method === 'GET' && url === '/api/feed') {
    const afterId = parseInt(params.get('after') || '0', 10);
    const db = new DatabaseSync(BUS_DB_PATH);
    try {
      const rows = db.prepare(
        `SELECT id, task_id, from_agent, to_agent, content, status, created_at
         FROM messages WHERE id > ?
         ORDER BY id ASC LIMIT 50`
      ).all(afterId);
      json(res, rows.map(r => ({
        id: r.id, task_id: r.task_id,
        from_agent: r.from_agent, to_agent: r.to_agent,
        content: parseContent(r.content),
        status: r.status, created_at: r.created_at
      })));
    } finally { try { db.close(); } catch {} }
    return;
  }

  // ── GET /api/tasks — last 20 tasks from tasks table + message fallback ──
  if (req.method === 'GET' && url === '/api/tasks') {
    const db = new DatabaseSync(BUS_DB_PATH);
    try {
      // Try tasks table first
      let rows = [];
      try {
        rows = db.prepare(
          `SELECT *
           FROM tasks ORDER BY created_at DESC LIMIT 20`
        ).all();
      } catch { /* table may not exist */ }

      // Fallback: derive from messages
      if (rows.length === 0) {
        rows = db.prepare(
          `SELECT task_id as id, MIN(created_at) as created_at, MAX(created_at) as last_activity,
                  GROUP_CONCAT(DISTINCT to_agent) as agents, COUNT(*) as msg_count,
                  MAX(CASE WHEN content LIKE '%[VERIFIED]%' THEN 'verified'
                           WHEN content LIKE '%[FAILED]%' THEN 'failed'
                           ELSE NULL END) as result_status
           FROM messages GROUP BY task_id
           ORDER BY MAX(id) DESC LIMIT 20`
        ).all();
      }
      json(res, rows);
    } catch { json(res, []); }
    finally { try { db.close(); } catch {} }
    return;
  }

  // ── GET /api/ministries — agent stats from ledger ──
  if (req.method === 'GET' && url === '/api/ministries') {
    const ledgerDb = new DatabaseSync(LEDGER_DB_PATH);
    try {
      const rows = ledgerDb.prepare(
        `SELECT agent_id, COUNT(*) as total_calls,
                COALESCE(SUM(cost_usd), 0) as total_cost,
                MAX(called_at) as last_active
         FROM api_calls GROUP BY agent_id`
      ).all();

      // Check heartbeat to see what's currently active
      let activeAgent = null;
      try {
        const hb = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
        if (Date.now() - hb.ts < 30_000 && hb.status === 'processing') {
          activeAgent = hb.current_agent || null;
        }
      } catch {}

      const result = rows.map(r => ({
        agent_id: r.agent_id,
        total_calls: r.total_calls,
        total_cost: r.total_cost,
        last_active: r.last_active,
        is_active: r.agent_id === activeAgent
      }));
      json(res, result);
    } catch { json(res, []); }
    finally { try { ledgerDb.close(); } catch {} }
    return;
  }

  // ── GET /api/output-files — list files in output/ ──
  if (req.method === 'GET' && url === '/api/output-files') {
    const files = listFiles(OUTPUT_DIR, 5, 0);
    files.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
    json(res, files.slice(0, params.get('all') ? 1000 : 20));
    return;
  }

  // ── GET /api/output-file?path=<rel> — read one relic (sandboxed to output/) ──
  if (req.method === 'GET' && (url === '/api/output-file' || url === '/api/output-raw')) {
    const full = safeOutputPath(params.get('path'));
    if (!full) { json(res, { error: 'Not found in the vault.' }, 404); return; }
    const st = fs.statSync(full);
    const ext = path.extname(full).toLowerCase();
    const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
    if (url === '/api/output-raw') {
      if (!IMG[ext]) { json(res, { error: 'Only images are served raw.' }, 415); return; }
      res.writeHead(200, { 'Content-Type': IMG[ext], 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff',
                           'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store' });
      fs.createReadStream(full).pipe(res);
      return;
    }
    const meta = { name: path.basename(full), rel: path.relative(OUTPUT_DIR, full).split(path.sep).join('/'),
                   size_bytes: st.size, modified_at: st.mtime.toISOString(), ext };
    if (IMG[ext]) { json(res, { ...meta, kind: 'image' }); return; }
    const MAX = 2 * 1024 * 1024;
    const buf = Buffer.alloc(Math.min(st.size, MAX));
    const fd = fs.openSync(full, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    if (buf.subarray(0, 8192).includes(0)) { json(res, { ...meta, kind: 'binary' }); return; }
    json(res, { ...meta, kind: 'text', text: buf.toString('utf8'), truncated: st.size > MAX });
    return;
  }

  // ── GET /api/ollama-stats ──
  if (req.method === 'GET' && url === '/api/ollama-stats') {
    const ledgerDb = new DatabaseSync(LEDGER_DB_PATH);
    try {
      // Check if ollama_calls table exists
      const tbl = ledgerDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='ollama_calls'`
      ).get();
      if (!tbl) {
        json(res, { available: false });
      } else {
        const rows = ledgerDb.prepare(
          `SELECT model, COUNT(*) as calls, AVG(duration_ms) as avg_ms, SUM(fell_back) as fallbacks
           FROM ollama_calls GROUP BY model`
        ).all();
        json(res, { available: true, models: rows });
      }
    } catch { json(res, { available: false }); }
    finally { try { ledgerDb.close(); } catch {} }
    return;
  }

  // ── GET /api/settings ──
  if (req.method === 'GET' && url === '/api/settings') {
    json(res, readSettings());
    return;
  }

  // ── POST /api/settings ──
  if (req.method === 'POST' && url === '/api/settings') {
    try {
      const body = await readBody(req);
      const existing = readSettings();
      const merged = { ...existing, ...body };
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
      json(res, { success: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /api/library?file=<name> — read library files ──
  if (req.method === 'GET' && url === '/api/library') {
    const file = params.get('file') || '';
    // Allowlist of readable files to prevent path traversal
    const allowed = {
      'edicts': path.join(LIBRARY_DIR, 'edicts', 'EDICTS.md'),
      'codex': path.join(LIBRARY_DIR, 'persona-codex', 'CODEX.md'),
      'chronicles': path.join(LIBRARY_DIR, 'chronicles', 'campaign-log.md'),
    };
    const filePath = allowed[file];
    if (!filePath) { json(res, { error: 'Unknown file. Valid: edicts, codex, chronicles' }, 400); return; }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      json(res, { file, content });
    } catch {
      json(res, { file, content: '(file not found or empty)' });
    }
    return;
  }

  // ── GET /api/test-octoprint — proxy test to avoid CORS ──
  if (req.method === 'GET' && url === '/api/test-octoprint') {
    const settings = readSettings();
    if (!settings.octoprint_url || !settings.octoprint_key) {
      json(res, { connected: false, reason: 'OctoPrint not configured' });
      return;
    }
    try {
      const u = new URL('/api/version', settings.octoprint_url);
      const proto = u.protocol === 'https:' ? https : http;
      const proxyReq = proto.get(u.href, { headers: { 'X-Api-Key': settings.octoprint_key }, timeout: 5000 }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', c => data += c);
        proxyRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            json(res, { connected: true, version: parsed.server || parsed.text || 'unknown' });
          } catch { json(res, { connected: false, reason: 'Invalid response from OctoPrint' }); }
        });
      });
      proxyReq.on('error', (e) => json(res, { connected: false, reason: e.message }));
      proxyReq.on('timeout', () => { proxyReq.destroy(); json(res, { connected: false, reason: 'Timeout' }); });
    } catch(e) { json(res, { connected: false, reason: e.message }); }
    return;
  }

  // ── GET /api/octoprint-status — proxy printer status ──
  if (req.method === 'GET' && url === '/api/octoprint-status') {
    const settings = readSettings();
    if (!settings.octoprint_url || !settings.octoprint_key) {
      json(res, { connected: false, reason: 'OctoPrint not configured' });
      return;
    }
    try {
      const u = new URL('/api/printer', settings.octoprint_url);
      const proto = u.protocol === 'https:' ? https : http;
      const proxyReq = proto.get(u.href, { headers: { 'X-Api-Key': settings.octoprint_key }, timeout: 5000 }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', c => data += c);
        proxyRes.on('end', () => {
          try { json(res, { connected: true, printer: JSON.parse(data) }); }
          catch { json(res, { connected: false, reason: 'Invalid response' }); }
        });
      });
      proxyReq.on('error', (e) => json(res, { connected: false, reason: e.message }));
      proxyReq.on('timeout', () => { proxyReq.destroy(); json(res, { connected: false, reason: 'Timeout' }); });
    } catch(e) { json(res, { connected: false, reason: e.message }); }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// ── Boot ─────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('[TERMINAL] unhandled error:', err.message);
    try { res.writeHead(500); res.end('Internal error'); } catch {}
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('=== NORSE IMPERIUM TERMINAL ===');
  console.log('─────────────────────────────────────────');
  console.log(`    http://localhost:${PORT}`);
  console.log('─────────────────────────────────────────');
  console.log('');
});
