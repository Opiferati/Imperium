'use strict';
// ══════════════════════════════════════════════════════════════════════
// NORSE IMPERIUM WARDEN — Core Engine v2.1 (brought current 2026-11-01)
// Zero tokens when idle. Artifacts not promises. Budget-gated.
// Run: node --no-warnings warden.js
// ══════════════════════════════════════════════════════════════════════

const fs    = require('node:fs');
const path  = require('node:path');
const https = require('node:https');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;

// ── Runners ────────────────────────────────────────────────────────────
let codeWriter = null;
try {
  codeWriter = require('./runners/code-writer.js');
} catch (e) {
  console.warn('[WARDEN] code-writer not loaded:', e.message);
}

let treasury = null;
try {
  treasury = require('./runners/treasury.js');
} catch (e) {
  console.warn('[WARDEN] treasury not loaded:', e.message);
}

let ravens = null;
try {
  ravens = require('./runners/ravens.js');          // Huginn & Muninn — state of the realm for the Chancellor (2026-11-02)
} catch (e) { console.warn('[WARDEN] ravens.js not loaded:', e.message); }

let ecnalanif = null;
try {
  ecnalanif = require('./runners/ecnalanif.js');
} catch (e) {
  console.warn('[WARDEN] ecnalanif not loaded:', e.message);
}
let skald = null;
try {
  skald = require('./runners/skald.js');
} catch (e) {
  console.warn('[WARDEN] skald not loaded:', e.message);
}

let forseti = null;
try {
  forseti = require('./runners/forseti.js');
} catch (e) {
  console.warn('[WARDEN] forseti not loaded:', e.message);
}

// ── .env loader ────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {
    console.warn('[WARDEN] No .env found at', envPath);
  }
}

loadEnv();

// ── Paths ──────────────────────────────────────────────────────────────
const BUS_DB_PATH       = path.join(ROOT, 'data', 'message_bus.db');
const HEARTBEAT_PATH    = path.join(ROOT, 'data', 'warden-heartbeat.json');
const LEDGER_DB_PATH    = path.join(ROOT, 'data', 'imperial-ledger.db');
const REGISTRY_PATH     = path.join(ROOT, 'data', 'imperium-registry.json');
const EDICTS_PATH       = path.join(ROOT, 'library', 'edicts', 'EDICTS.md');
const CODEX_PATH        = path.join(ROOT, 'library', 'persona-codex', 'CODEX.md');
const CHRONICLE_DIR     = path.join(ROOT, 'library', 'chronicles');
const TICK_MS           = 10_000;

// Skald runs per New York day (in memory; a restart resets it)
const skaldRunsByDate = new Map();
const skaldGaveUp = new Set();

// ── Load static config ─────────────────────────────────────────────────
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

// Load Edicts — prepended to every agent's system prompt
let EDICTS = '';
try {
  EDICTS = fs.readFileSync(EDICTS_PATH, 'utf8');
} catch {
  console.warn('[WARDEN] Edicts not found at', EDICTS_PATH);
}

// Load Persona Codex — compact version injected into Chancellor's context
let CODEX_COMPACT = '';
try {
  const full = fs.readFileSync(CODEX_PATH, 'utf8');
  // Extract key lines for a compact injection (~200 tokens)
  CODEX_COMPACT = `
## Emperor Profile
- Name: Chris (opiferus) | System: Mayberidur
- Style: direct, no sycophancy, plan-first | "squirrel brain" — interrupt only for blockers
- Autonomy: high with guardrails | Approval required: money, publishing
- Equipment: Blender 5.0.1, Ender 3v2, Node.js, Python, WSL2/Win11
- Budget: $2.00/day hard limit
- Confidence: High→act | Medium→act+note | Low→ask ONE question | High-risk→escalate
`.trim();
} catch {
  console.warn('[WARDEN] Codex not found at', CODEX_PATH);
}

// ── Open databases ─────────────────────────────────────────────────────
const busDb    = new DatabaseSync(BUS_DB_PATH);
const ledgerDb = new DatabaseSync(LEDGER_DB_PATH);

// ── Prepared statements ────────────────────────────────────────────────
const stmtGetQueued = busDb.prepare(
  `SELECT id, task_id, from_agent, to_agent, content, priority
   FROM messages
   WHERE status='queued'
   ORDER BY priority ASC, created_at ASC
   LIMIT 1`
);

const stmtClaim = busDb.prepare(
  `UPDATE messages
   SET status='in_progress', updated_at=datetime('now')
   WHERE id=? AND status='queued'`
);

const stmtMarkDelivered = busDb.prepare(
  `UPDATE messages SET status='delivered', updated_at=datetime('now') WHERE id=?`
);

const stmtMarkFailed = busDb.prepare(
  `UPDATE messages SET status='failed', updated_at=datetime('now') WHERE id=?`
);

const stmtInsertMessage = busDb.prepare(
  `INSERT INTO messages (task_id, from_agent, to_agent, content, status, priority)
   VALUES (?, ?, ?, ?, 'queued', ?)`
);

const stmtCountDelivered = busDb.prepare(
  `SELECT COUNT(*) as n FROM messages WHERE task_id=? AND from_agent=? AND status NOT IN ('failed','cancelled')`
);

const stmtTaskOrigin = busDb.prepare(
  `SELECT from_agent FROM messages WHERE task_id=? ORDER BY id ASC LIMIT 1`
);

// Migration: Forseti's columns on the Saga ledger (renamed from critic_* on 2026-11-01)
{
  const cols = busDb.prepare(`PRAGMA table_info(tasks)`).all().map(c => c.name);
  for (const c of ['verdict', 'notes', 'fails']) {
    if (cols.includes(`critic_${c}`) && !cols.includes(`forseti_${c}`)) busDb.exec(`ALTER TABLE tasks RENAME COLUMN critic_${c} TO forseti_${c}`);
  }
  const now = busDb.prepare(`PRAGMA table_info(tasks)`).all().map(c => c.name);
  if (!now.includes('forseti_verdict')) busDb.exec(`ALTER TABLE tasks ADD COLUMN forseti_verdict TEXT`);
  if (!now.includes('forseti_notes'))   busDb.exec(`ALTER TABLE tasks ADD COLUMN forseti_notes TEXT`);
  if (!now.includes('forseti_fails'))   busDb.exec(`ALTER TABLE tasks ADD COLUMN forseti_fails INTEGER DEFAULT 0`);
}
const CRITIC_CONF   = registry.forseti || registry.critic || { model: 'haiku', enabled: true, max_revisions: 2 };
const MAX_ATTEMPTS  = 1 + (CRITIC_CONF.max_revisions ?? 2);   // per ministry, per task

// ── Petitions (2026-11-01): a ministry may ask the Emperor to go beyond an order's scope ──
busDb.exec(`CREATE TABLE IF NOT EXISTS petitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), decided_at TEXT, granted_task TEXT)`);
const stmtPetitionAdd = busDb.prepare(`INSERT INTO petitions (task_id, agent, request) VALUES (?, ?, ?)`);
let gate = null;
try { gate = require('./runners/gate.js'); gate.ensureTables(busDb); }
catch (e) { console.warn('[WARDEN] gate.js not loaded:', e.message); }
const stmtGatePetition = busDb.prepare(`INSERT INTO petitions (task_id, agent, request, kind, target) VALUES (?, ?, ?, 'gate', ?)`);
const stmtGatePending  = busDb.prepare(`SELECT id FROM petitions WHERE kind='gate' AND status='pending' AND target=?`);
const PETITION_RE = /\[PETITION:\s*([^\]\n]{3,300})\]/i;

// ── The Imperial Brief (2026-11-03, Phase 3½): the Empire's source of truth ──
// Read fresh for every Chancellor call, so edits to IMPERIAL_BRIEF.md take effect without a restart.
// If a decree needs a fact the Brief lacks, the Chancellor answers [BLOCKED: ...] and the task is marked blocked.
const BRIEF_PATH = path.join(ROOT, 'IMPERIAL_BRIEF.md');
const BLOCKED_RE = /\[BLOCKED:\s*([^\]\n]{3,300})\]/i;
function briefBlock() {
  let txt;
  try { txt = fs.readFileSync(BRIEF_PATH, 'utf8').trim(); } catch { return ''; }
  return `\n\n## THE IMPERIAL BRIEF (source of truth — read it before planning)\n${txt}\n\n` +
    `### How to use the Brief\n` +
    `- Facts in the Brief outrank your assumptions.\n` +
    `- If a decree needs a fact the Brief marks \`unknown\` (or doesn't contain), and neither the decree nor the Ravens' Report supplies it, ` +
    `do NOT dispatch and do NOT guess. Reply with a line that starts [BLOCKED: <the missing input>], then ONE short question for the Emperor.\n` +
    `- Status questions, small talk and decrees that need no business facts are never blocked.\n` +
    `- Every dispatch for real work states what "done" looks like (section 8) and reminds the ministry of the ask-first list (section 5).`;
}

// ── Saga ledger: one row per task in the bus `tasks` table ─────────────
// pending -> in_progress -> done | failed. Artifacts + cost accumulate here.
const stmtTaskStart = busDb.prepare(
  `INSERT INTO tasks (id, title, status) VALUES (?, ?, 'in_progress')
   ON CONFLICT(id) DO UPDATE SET status = CASE WHEN status IN ('done','failed') THEN status ELSE 'in_progress' END`
);
const stmtTaskCost = busDb.prepare(
  `UPDATE tasks SET cost_usd = COALESCE(cost_usd,0) + ? WHERE id = ?`
);
const stmtTaskArtifact = busDb.prepare(
  `UPDATE tasks SET artifact_path = ?, artifact_bytes = ? WHERE id = ?`
);
const stmtTaskFinish = busDb.prepare(
  `UPDATE tasks SET status = ?, completed_at = datetime('now') WHERE id = ?`
);
const stmtTaskCritic = busDb.prepare(
  `UPDATE tasks SET forseti_verdict = ?, forseti_notes = ?,
     forseti_fails = COALESCE(forseti_fails,0) + ? WHERE id = ?`
);
const stmtTaskGet = busDb.prepare(`SELECT * FROM tasks WHERE id = ?`);
// Phase 3½: every blocked / failed / awaiting-approval task carries a plain-English reason
if (!busDb.prepare(`PRAGMA table_info(tasks)`).all().some(c => c.name === 'status_reason'))
  busDb.exec(`ALTER TABLE tasks ADD COLUMN status_reason TEXT`);
const stmtTaskReason = busDb.prepare(`UPDATE tasks SET status = ?, status_reason = ? WHERE id = ?`);
const stmtTaskReasonOnly = busDb.prepare(`UPDATE tasks SET status_reason = ? WHERE id = ?`);
function taskTitle(raw) {
  let t = raw;
  try {
    const j = JSON.parse(raw);
    if (j.action === 'treasury_scan') return 'Treasury refresh — prices, gauges, Thesis C';
    if (j.action === 'skald_reading') return `Skald reading — ${skald ? skald.etNow().date : ''}`;
    t = j.text || j.content || raw;
  } catch {}
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Ministry agents whose responses route up to the Chancellor (not back to themselves)
const MINISTRY_AGENTS = new Set([
  'ministry-of-intelligence',
  'ministry-of-works',
  'ministry-of-engineering'
]);   // ministry-of-protocol retired 2026-11-01 (never called)

// ── Ledger statements ──────────────────────────────────────────────────
const stmtLogApiCall = ledgerDb.prepare(
  `INSERT INTO api_calls (task_id, agent_id, model, input_tokens, output_tokens, cost_usd)
   VALUES (?, ?, ?, ?, ?, ?)`
);

const stmtDailySpend = ledgerDb.prepare(
  `SELECT COALESCE(SUM(cost_usd), 0) as total
   FROM api_calls
   WHERE date(called_at) = date('now')`
);

const stmtUpsertDaily = ledgerDb.prepare(
  `INSERT INTO daily_totals (date, total_usd, total_calls)
   VALUES (?, ?, 1)
   ON CONFLICT(date) DO UPDATE SET total_usd = total_usd + excluded.total_usd, total_calls = total_calls + 1`
);

// ── Session counters ───────────────────────────────────────────────────
let sessionMessages = 0;
let sessionTokens   = 0;

// ── Helpers ────────────────────────────────────────────────────────────
function resolveModel(shortName) {
  return registry.models[shortName] || shortName;
}

function getAgentConfig(agentId) {
  return registry.agents[agentId] || null;
}

function readSoul(workspaceRelative) {
  const p = path.join(ROOT, workspaceRelative, 'SOUL.md');
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return `You are a Norse Imperium agent. SOUL.md not found at: ${p}`;
  }
}

function isoNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

let currentAgent = null;
function writeHeartbeat(status) {
  try {
    fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify({
      alive: true,
      ts: Date.now(),
      status,
      current_agent: status === 'processing' ? currentAgent : null,
      session_messages: sessionMessages,
      session_tokens: sessionTokens
    }));
  } catch { /* non-fatal */ }
}

// Build conversation thread for a task from the bus
function buildThread(taskId, targetAgentId) {
  const rows = busDb.prepare(
    `SELECT from_agent, to_agent, content
     FROM messages
     WHERE task_id = ? AND (status = 'delivered' OR status = 'in_progress')
     ORDER BY id ASC`
  ).all(taskId);

  const messages = [];
  for (const row of rows) {
    let role;
    if (row.to_agent === targetAgentId) role = 'user';
    else if (row.from_agent === targetAgentId) role = 'assistant';
    else continue;

    let content;
    try {
      const parsed = JSON.parse(row.content);
      content = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
    } catch {
      content = row.content;
    }

    const tagged = `[FROM: ${row.from_agent}]\n${content}`;

    // API requires strict alternation
    if (messages.length > 0 && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content += '\n\n' + tagged;
    } else {
      messages.push({ role, content: tagged });
    }
  }

  if (messages.length === 0 || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '(begin)' });
  }

  return messages;
}

// Token cost per million
// Current lineup checked 2026-11-01. Old entries kept so historic ledger rows still price.
const PRICING = {
  'claude-sonnet-5-5':         { input: 2.0,  output: 10.0 },
  'claude-haiku-5-5':          { input: 0.10, output: 0.50 },  // prompts <=100K tokens
  'claude-opus-5-5':           { input: 4.0,  output: 20.0 },
  'claude-sonnet-4-20250514':  { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 1.0,  output: 5.0  },
  'claude-opus-4-20250514':    { input: 15.0, output: 75.0 },
};

function estimateCost(model, inputTok, outputTok) {
  let p = PRICING[model];
  if (!p) {
    // Unknown model: price it as the most expensive tier so the budget gate errs safe
    console.warn(`[WARDEN] No price for ${model} — charging at Opus rate`);
    p = PRICING['claude-opus-5-5'];
  }
  if (model === 'claude-haiku-5-5' && inputTok > 100_000) p = { input: 0.50, output: 2.50 };
  return ((inputTok * p.input) + (outputTok * p.output)) / 1_000_000;
}

// Parse dispatch blocks from Chancellor responses
function parseDispatches(text) {
  const items = [];
  const regex = /```dispatch\s*([\s\S]*?)```/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (item.to) items.push(item);
        else console.warn('[WARDEN] Dispatch missing "to" — skipped');
      }
    } catch (e) {
      console.warn('[WARDEN] Malformed dispatch block:', e.message.slice(0, 100));
    }
  }
  return items;
}

// Append chronicle entry after a task completes
function appendChronicle(taskId, fromAgent, content, cost) {
  try {
    const dt = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const firstLine = (text.match(/^[^.!?\n]+[.!?]?/) ?? [text])[0].trim().slice(0, 80);
    const result = text.slice(0, 200).replace(/\n+/g, ' ').trim();

    const entry = `\n---\n[${dt}] TASK: ${firstLine}\nID: ${taskId}\nMINISTRY: ${fromAgent} | STATUS: complete\nRESULT: ${result}\nCOST: $${cost.toFixed(5)}\n---\n`;

    if (!fs.existsSync(CHRONICLE_DIR)) fs.mkdirSync(CHRONICLE_DIR, { recursive: true });
    fs.appendFileSync(path.join(CHRONICLE_DIR, 'campaign-log.md'), entry);
    console.log(`[WARDEN] chronicle <- ${taskId}`);
  } catch (e) {
    console.warn(`[WARDEN] chronicle write failed: ${e.message}`);
  }
}

// Format content for display
function formatContent(rawContent) {
  let msg = rawContent;
  try {
    const parsed = JSON.parse(rawContent);
    if (typeof parsed === 'string') msg = parsed;
    else if (parsed && typeof parsed === 'object') {
      msg = parsed.response || parsed.message || parsed.text || JSON.stringify(parsed, null, 2);
    }
  } catch { /* raw text */ }
  return msg;
}

// ── Anthropic API call ─────────────────────────────────────────────────
function callAnthropic(model, systemPrompt, messages, maxTokens = 8192, tools = null) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === 'your-api-key-here') {
      return reject(new Error('ANTHROPIC_API_KEY not set — fill in .env'));
    }

    const payload = { model, max_tokens: maxTokens, system: systemPrompt, messages };
    if (tools && tools.length) payload.tools = tools;
    const body = JSON.stringify(payload);

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Bad API response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── The Skald ──────────────────────────────────────────────────────────
async function runSkald(msg, sconf) {
  const finish = (ok, text) => {
    stmtMarkDelivered.run(msg.id);
    stmtInsertMessage.run(msg.task_id, 'ministry-of-skald', 'emperor', text, msg.priority);
    console.log(`[WARDEN] skald: ${ok ? 'reading recorded' : 'FAILED'}`);
  };
  if (!skald || sconf.enabled === false) {
    stmtMarkFailed.run(msg.id);
    stmtInsertMessage.run(msg.task_id, 'warden', 'emperor', '[FAILED] The Skald is not enabled in the registry.', msg.priority);
    stmtTaskFinish.run('failed', msg.task_id);
    return;
  }
  const dateEt = skald.etNow().date;
  stmtTaskStart.run(msg.task_id, `Skald reading — ${dateEt}`);
  currentAgent = 'ministry-of-skald';
  writeHeartbeat('processing');
  // Thesis C Amendment 1 (2026-11-03): refresh prices + gauges first, so the reading records today's
  // gauges, not whatever the last Treasury press left on disk (11-02 logged Friday's stock gauge).
  if (treasury && sconf.refresh_gauges_first !== false) {
    console.log('[WARDEN] skald: refreshing gauges first (Treasury)…');
    const tr = await treasury.runScan(registry.treasury || {});
    console.log(`[WARDEN] skald: gauge refresh ${tr.status}${tr.status === 'ok' ? ` (prices as of ${tr.as_of})` : ` — ${tr.message}`}`);
  }
  const model = resolveModel(sconf.model || 'haiku');
  // Search cap (2026-11-02): ONE budget for the whole reading. max_uses is per API call, so every
  // pause_turn resume and the retry used to get a fresh 6 — that's how 11-01 ran 10 searches.
  const searchCap = sconf.max_searches ?? 6;
  const toolsFor = left => left > 0 ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: left }] : null;
  const tries = 1 + (sconf.retries ?? 1);
  let messages = [{ role: 'user', content: skald.userPrompt(dateEt) }];
  let totalCost = 0, totalSearches = 0, last = null, priorContent = [];
  try {
    for (let attempt = 1; attempt <= tries; attempt++) {
      let result = await callAnthropic(model, `${EDICTS}\n\n${skald.SYSTEM}`, messages, 4096, toolsFor(searchCap - totalSearches));
      if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
      const content = [...(result.content || [])];
      let inTok = result.usage?.input_tokens ?? 0, outTok = result.usage?.output_tokens ?? 0;
      let searches = result.usage?.server_tool_use?.web_search_requests ?? 0;
      for (let hop = 0; result.stop_reason === 'pause_turn' && hop < 3; hop++) {
        const left = searchCap - totalSearches - searches;
        if (left <= 0) { console.warn(`[WARDEN] skald: search cap (${searchCap}) reached mid-turn — judging what was found`); break; }
        result = await callAnthropic(model, `${EDICTS}\n\n${skald.SYSTEM}`, [...messages, { role: 'assistant', content }], 4096, toolsFor(left));
        if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
        content.push(...(result.content || []));
        inTok += result.usage?.input_tokens ?? 0; outTok += result.usage?.output_tokens ?? 0;
        searches += result.usage?.server_tool_use?.web_search_requests ?? 0;
      }
      const cost = estimateCost(model, inTok, outTok) + searches * 0.01;
      stmtLogApiCall.run(msg.task_id, 'ministry-of-skald', model, inTok, outTok, cost);
      stmtUpsertDaily.run(new Date().toISOString().split('T')[0], cost);
      stmtTaskCost.run(cost, msg.task_id);
      sessionTokens += inTok + outTok;
      totalCost += cost; totalSearches += searches;

      last = skald.lawspeaker(content, totalSearches, priorContent);
      console.log(`[WARDEN] skald: attempt ${attempt} | ${searches} searches (${totalSearches}/${searchCap}) | $${cost.toFixed(4)} | lawspeaker ${last.ok ? 'PASS' : 'FAIL'}`);
      if (last.ok) {
        const meta = { model, searches: totalSearches, cost: totalCost };
        const g = skald.record(ROOT, sconf, dateEt, last.reading, meta, content);
        const rel = `output/skald/skald-${dateEt}.md`;
        fs.mkdirSync(path.join(ROOT, 'output', 'skald'), { recursive: true });
        fs.writeFileSync(path.join(ROOT, rel), skald.report(dateEt, last.reading, g, meta));
        stmtTaskArtifact.run(`C:\\Imperium\\${rel.replace(/\//g, '\\')}`, fs.statSync(path.join(ROOT, rel)).size, msg.task_id);
        stmtTaskFinish.run('done', msg.task_id);
        const r = last.reading;
        finish(true, `[VERIFIED] Skald reading ${dateEt} — crypto ${r.crypto_mood} (${skald.label(r.crypto_mood)}), ` +
          `stocks ${r.stock_mood} (${skald.label(r.stock_mood)}). Price gauges: crypto ${g.crypto_fg ?? '—'}, stocks ${g.stock_gauge ?? '—'}${g.stale ? ` (⚠ STALE: ${g.stale})` : ''}. ` +
          `Top driver: ${(r.crypto_drivers[0] || {}).event || '—'}. Report: ${rel}`);
        return;
      }
      // One retry: hand the Lawspeaker's ruling back so the Skald can fix it.
      // Links from this attempt's searches still count next time; searches left come from the same cap.
      priorContent = [...priorContent, ...content];
      const left = searchCap - totalSearches;
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      messages = [...messages, { role: 'assistant', content: text || '(no text)' },
        { role: 'user', content: 'The Lawspeaker rejected that reading:\n- ' + last.problems.join('\n- ') +
          (left > 0 ? `\nYou may run up to ${left} more search(es) if needed.` : '\nThe search budget is spent: fix the reading using only links your earlier searches returned.') +
          '\nReply with ONE corrected JSON object. Only cite URLs your searches returned.' }];
    }
    stmtTaskFinish.run('failed', msg.task_id);
    stmtTaskReasonOnly.run(`Lawspeaker rejected: ${last.problems.slice(0, 3).join(' ')}`.slice(0, 300), msg.task_id);
    finish(false, `[FAILED] Skald reading ${dateEt} rejected by the Lawspeaker: ${last.problems.slice(0, 3).join(' ')} ($${totalCost.toFixed(4)} spent). Nothing was logged.`);
  } catch (e) {
    stmtTaskFinish.run('failed', msg.task_id);
    stmtTaskReasonOnly.run(String(e.message).slice(0, 300), msg.task_id);
    finish(false, `[FAILED] Skald reading ${dateEt}: ${e.message}`);
  }
}

// ── The Warden's paperwork (2026-11-01) ───────────────────────────────
// A ministry reply arriving at the Chancellor is handled in code when the path is mechanical:
//   PASS/UNSURE + files written  -> final report to the Emperor
//   FAIL, revisions left         -> revision order = original order + Forseti's problems (no new demands)
//   FAIL, limit reached          -> FAILED report
// Anything else (several ministries on the task, no files, file-read requests pending) goes to the Chancellor.
const MINISTRY_LABEL = { 'ministry-of-intelligence': 'Intelligence', 'ministry-of-engineering': 'Engineering', 'ministry-of-works': 'Works' };
function wardenRelay(msg) {
  const text = String(msg.content || '');
  const verdict = (text.match(/\[FORSETI: (PASS|FAIL|UNSURE)\]/) || [])[1];
  const verified = [...text.matchAll(/^\[VERIFIED\] (.+?) — (\d+) bytes written$/gm)].map(m => ({ path: m[1], bytes: +m[2] }));
  const failedFiles = [...text.matchAll(/^\[FAILED\] (.+)$/gm)].map(m => m[1]);
  if (!verdict || verified.length === 0 || failedFiles.length) return false;
  const orders = busDb.prepare(`SELECT to_agent, content FROM messages WHERE task_id=? AND from_agent='imperial-chancellor'
                                AND to_agent != 'emperor' ORDER BY id`).all(msg.task_id);
  if (!orders.length || new Set(orders.map(o => o.to_agent)).size !== 1 || orders[0].to_agent !== msg.from_agent) return false;
  const pendingReads = busDb.prepare(`SELECT COUNT(*) n FROM messages WHERE task_id=? AND from_agent='warden' AND status='queued'`).get(msg.task_id).n;
  if (pendingReads) return false;

  const after = text.slice(text.indexOf(`[FORSETI: ${verdict}]`));
  const problems = [...after.matchAll(/^- (.+)$/gm)].map(m => m[1]).filter(p => !/^\S+ — https?:/.test(p)).slice(0, 3);
  const petition = (text.match(/\[PETITION #\d+ filed with the Emperor: [^\]]+\]/) || [])[0];
  const sourcesBlock = (text.match(/\[SOURCES cited via web search\]\n((?:- .+\n?)+)/) || [])[1];
  const task = stmtTaskGet.get(msg.task_id) || {};
  const who = MINISTRY_LABEL[msg.from_agent] || msg.from_agent;
  const original = (() => { try { const j = JSON.parse(orders[0].content); return typeof j === 'string' ? j : (j.text || orders[0].content); } catch { return orders[0].content; } })()
    .replace(/^REVISION \d+ of \d+\.\s*/, '');
  const replies = stmtCountDelivered.get(msg.task_id, msg.from_agent).n;
  stmtMarkDelivered.run(msg.id);

  if (verdict === 'FAIL' && replies < MAX_ATTEMPTS) {
    const k = replies, n = MAX_ATTEMPTS - 1;
    const order = `REVISION ${k} of ${n}. ${original}\n\nFix ONLY these (no other changes are wanted):\n` +
      problems.map((p, i) => `${i + 1}. ${p}`).join('\n') + `\nWrite to the same file path as before.`;
    stmtInsertMessage.run(msg.task_id, 'imperial-chancellor', msg.from_agent, order, msg.priority);
    console.log(`[WARDEN] paperwork: revision ${k}/${n} -> ${msg.from_agent} (no Chancellor call)`);
    return true;
  }

  const ok = verdict !== 'FAIL';
  let report = `Task: ${task.title || msg.task_id}\nMinistry: ${who}\n` +
    verified.map(v => `Result: ${ok ? '[VERIFIED]' : '[FAILED]'} ${v.path} — ${v.bytes} bytes`).join('\n') + '\n' +
    `Forseti: ${verdict}${verdict === 'UNSURE' ? ' — not judged' : ''}` + (problems.length ? '\n' + problems.map(p => `- ${p}`).join('\n') : '') +
    (verdict === 'FAIL' ? `\nRevision limit reached (${MAX_ATTEMPTS - 1} revisions used). Not a usable deliverable.` : '') +
    (replies > 1 ? `\nDrafts: ${replies}` : '') +
    (petition ? `\n${petition} — approve or deny it in the Petitions bar.` : '') +
    (sourcesBlock ? `\nSources:\n${sourcesBlock.trim()}` : '');
  try {
    const rows = ledgerDb.prepare(`SELECT agent_id, COUNT(*) n, SUM(cost_usd) c FROM api_calls WHERE task_id = ? GROUP BY agent_id`).all(msg.task_id);
    const by = { chancellor: 0, ministries: 0, forseti: 0 }; let calls = 0;
    for (const r of rows) { calls += r.n; if (r.agent_id === 'imperial-chancellor') by.chancellor += r.c; else if (r.agent_id === 'forseti') by.forseti += r.c; else by.ministries += r.c; }
    report += `\n\n---\n[LEDGER] This task cost $${(by.chancellor + by.ministries + by.forseti).toFixed(4)} across ${calls} calls ` +
      `(Chancellor $${by.chancellor.toFixed(4)} · ministries $${by.ministries.toFixed(4)} · Forseti $${by.forseti.toFixed(4)}). Report written by the Warden at no cost.`;
  } catch {}
  stmtInsertMessage.run(msg.task_id, 'imperial-chancellor', 'emperor', report, msg.priority);
  console.log(`[WARDEN] paperwork: ${ok ? 'final report' : 'FAILED report'} -> emperor (no Chancellor call)`);
  return true;
}

// ── Main tick ──────────────────────────────────────────────────────────
// One message at a time: a slow job (a model call, a Treasury fetch) must not
// let the next tick start a second job alongside it.
let ticking = false;
async function tick() {
  if (ticking) { writeHeartbeat('processing'); return; }
  ticking = true;
  try { await tickInner(); } finally { ticking = false; }
}

// Status line: written only when it changes (timestamp ignored), so the log
// isn't flooded with identical idle lines. Liveness lives in warden-heartbeat.json.
let lastStatus = '';
function statusLine(text) {
  if (text === lastStatus) return;
  lastStatus = text;
  if (process.stdout.isTTY) process.stdout.write(`\r[WARDEN] ${isoNow()} | ${text}   `);
  else process.stdout.write(`[WARDEN] ${isoNow()} | ${text}\n`);
}

async function tickInner() {
  writeHeartbeat('idle');

  // Budget gate
  const dailySpend = stmtDailySpend.get().total;
  const limit      = registry.budget.daily_limit_usd;
  const warnAt     = limit * (registry.budget.warn_at_pct / 100);

  if (dailySpend >= limit) {
    statusLine(`BUDGET LIMIT $${dailySpend.toFixed(4)}/$${limit} — paused`);
    return;
  }

  // Folded into the idle line so WARN and idle don't alternate and defeat the de-dupe
  const warnTag = dailySpend >= warnAt ? ` | WARN ${Math.round((dailySpend/limit)*100)}% of budget` : '';

  // The Skald: once per New York day after the close, queue a mood reading
  const sconf = registry.skald || {};
  // A FAILED reading logs nothing, so isDue() stays true: without a cap the Warden re-queued it every tick
  // (11-02: failed at 23:00, re-queued at 23:00:58). Now at most skald.max_runs_per_day (default 2) per NY day.
  if (skald && sconf.enabled && skald.isDue(ROOT, sconf)) {
    const busy = busDb.prepare(
      `SELECT COUNT(*) n FROM messages WHERE to_agent='ministry-of-skald' AND status IN ('queued','in_progress')`).get().n;
    const today = skald.etNow().date, maxRuns = sconf.max_runs_per_day ?? 2;
    const runs = skaldRunsByDate.get(today) || 0;
    if (!busy && runs >= maxRuns) {
      if (!skaldGaveUp.has(today)) { skaldGaveUp.add(today); console.warn(`[WARDEN] skald: ${runs} run(s) today without a recorded reading — giving up until tomorrow`); }
    } else if (!busy) {
      skaldRunsByDate.set(today, runs + 1);
      const tid = 'TASK-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 15) + '-SKLD';
      stmtInsertMessage.run(tid, 'emperor', 'ministry-of-skald',
        JSON.stringify({ action: 'skald_reading', auto: true, sent_at: new Date().toISOString() }), 2);
      console.log(`\n[WARDEN] skald: today's reading is due — queued ${tid}`);
    }
  }

  // Claim one queued message
  const msg = stmtGetQueued.get();

  if (!msg) {
    statusLine(`idle | session: ${sessionMessages} msgs / ${sessionTokens} tokens | daily: $${dailySpend.toFixed(4)} / $${limit}${warnTag}`);
    return;
  }

  writeHeartbeat('processing');

  const claim = stmtClaim.run(msg.id);
  if (claim.changes === 0) return;

  const now = isoNow();
  console.log(`\n[WARDEN] ${now} | dispatching -> ${msg.to_agent} | task: ${msg.task_id}`);
  if (msg.from_agent === 'emperor') stmtTaskStart.run(msg.task_id, taskTitle(msg.content));
  currentAgent = msg.to_agent;

  // Treasury: Finalance v2 scan — plain code, no model, no tokens
  if (msg.to_agent === 'ministry-of-treasury') {
    const tconf = registry.treasury || {};
    if (!treasury || tconf.enabled === false) {
      stmtMarkFailed.run(msg.id);
      stmtInsertMessage.run(msg.task_id, 'warden', 'emperor', '[FAILED] Treasury is not enabled in the registry.', msg.priority);
      stmtTaskFinish.run('failed', msg.task_id);
      return;
    }
    stmtTaskStart.run(msg.task_id, 'Treasury refresh — prices, gauges, Thesis C');
    currentAgent = 'ministry-of-treasury';
    writeHeartbeat('processing');
    console.log('[WARDEN] treasury: refreshing prices, gauges, Thesis C…');
    const res = await treasury.runScan(tconf);
    const day = (res.as_of || new Date().toISOString().slice(0, 10));
    const rel = `output/treasury/treasury-${day}.md`;
    try {
      fs.mkdirSync(path.join(ROOT, 'output', 'treasury'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, rel), treasury.report(res));
      const bytes = fs.statSync(path.join(ROOT, rel)).size;
      stmtTaskArtifact.run(`C:\\Imperium\\${rel.replace(/\//g, '\\')}`, bytes, msg.task_id);
    } catch (e) { console.warn('[WARDEN] treasury report write failed:', e.message); }
    stmtMarkDelivered.run(msg.id);
    stmtInsertMessage.run(msg.task_id, 'ministry-of-treasury', 'emperor', treasury.summaryLine(res), msg.priority);
    console.log(`[WARDEN] treasury: ${res.status}`);
    return;
  }

  // The Skald: news-mood reading (measurement only — Edict VI)
  if (msg.to_agent === 'ministry-of-skald') {
    await runSkald(msg, registry.skald || {});
    // Ecnalanif (2026-11-03): the mirror station scans right after the evening reading. $0, plain code.
    const econf = registry.ecnalanif || {};
    if (ecnalanif && econf.enabled) {
      const er = await ecnalanif.runScan(econf);
      console.log(`[WARDEN] ecnalanif: ${er.status}${er.message ? ' — ' + er.message : ''}`);
      if (er.status !== 'missing') stmtInsertMessage.run(msg.task_id, 'ecnalanif', 'emperor', ecnalanif.summaryLine(er), msg.priority);
    }
    return;
  }

  // Special: messages addressed to the Emperor are for display, not AI processing
  if (msg.to_agent === 'emperor') {
    const formatted = formatContent(msg.content);
    console.log('');
    console.log('--- MESSAGE FOR EMPEROR ---');
    console.log(formatted.slice(0, 500));
    console.log('---------------------------');
    const trow   = stmtTaskGet.get(msg.task_id);
    const failed = (trow && trow.forseti_verdict === 'FAIL') ||
                   (/\[FAILED\]/.test(formatted) && !/\[VERIFIED\]/.test(formatted));
    if (!(trow && ['blocked', 'awaiting_approval'].includes(trow.status) && !failed))   // keep the reason-bearing status
      stmtTaskFinish.run(failed ? 'failed' : 'done', msg.task_id);
    appendChronicle(msg.task_id, msg.from_agent, formatted, 0);
    stmtMarkDelivered.run(msg.id);
    return;
  }

  // The Warden's paperwork: one ministry's finished work needs no Sonnet call to report or revise
  if (msg.to_agent === 'imperial-chancellor' && MINISTRY_AGENTS.has(msg.from_agent) && wardenRelay(msg)) return;

  // Look up agent
  const agentConf = getAgentConfig(msg.to_agent);
  if (!agentConf) {
    console.error(`[WARDEN] Unknown agent "${msg.to_agent}" — marking failed`);
    stmtMarkFailed.run(msg.id);
    return;
  }

  // Build system prompt: Edicts + SOUL + Codex (Chancellor only)
  const model      = resolveModel(agentConf.model);
  const soul       = readSoul(agentConf.workspace);
  const codexBlock = msg.to_agent === 'imperial-chancellor' ? `\n\n${CODEX_COMPACT}` : '';
  // The Ravens' Report: live facts for the Chancellor, built fresh each call by plain code ($0)
  let ravensBlock = '';
  if (msg.to_agent === 'imperial-chancellor' && ravens) {
    try { ravensBlock = `\n\n${ravens.toPrompt(ravens.gather(ROOT))}`; }
    catch (e) { ravensBlock = `\n\n## THE RAVENS' REPORT\nThe ravens could not fly this time (${e.message}). Say you have no live data rather than guessing.`; }
  }
  const briefStr   = msg.to_agent === 'imperial-chancellor' ? briefBlock() : '';
  const systemProm = `${EDICTS}\n\n${soul}${codexBlock}${briefStr}${ravensBlock}`;

  // Build conversation thread
  const thread = buildThread(msg.task_id, msg.to_agent);
  console.log(`[WARDEN]    thread: ${thread.length} turn(s)`);

  try {
    // Web search (server-side tool) for ministries that have it switched on
    const ws = agentConf.web_search;
    const tools = ws ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: ws.max_uses ?? 5 }] : null;

    // A search-heavy turn can come back as pause_turn — resume it, a few times at most
    const maxTok = agentConf.max_tokens ?? 8192;
    let result = await callAnthropic(model, systemProm, thread, maxTok, tools);
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    const allContent = [...(result.content || [])];
    const usageSum   = { input_tokens: result.usage?.input_tokens ?? 0, output_tokens: result.usage?.output_tokens ?? 0,
                         searches: result.usage?.server_tool_use?.web_search_requests ?? 0 };
    for (let hop = 0; result.stop_reason === 'pause_turn' && hop < 3; hop++) {
      result = await callAnthropic(model, systemProm,
        [...thread, { role: 'assistant', content: allContent }], maxTok, tools);
      if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
      allContent.push(...(result.content || []));
      usageSum.input_tokens  += result.usage?.input_tokens ?? 0;
      usageSum.output_tokens += result.usage?.output_tokens ?? 0;
      usageSum.searches      += result.usage?.server_tool_use?.web_search_requests ?? 0;
    }
    // Cut off at the token ceiling? Ask once for a condensed, complete version (Edict VIII)
    // instead of sending a half-finished file to Forseti. The search results stay in hand.
    if (result.stop_reason === 'max_tokens' && MINISTRY_AGENTS.has(msg.to_agent)) {
      console.warn(`[WARDEN] ${msg.to_agent} hit max_tokens — asking once for a condensed version`);
      const answered = new Set(allContent.filter(b => b.type === 'web_search_tool_result').map(b => b.tool_use_id));
      const priorBlocks = allContent.filter(b => b.type !== 'server_tool_use' || answered.has(b.id));
      const condense = `[FROM: warden]\nYour reply was cut off at the length limit before it finished, so it cannot be used. ` +
        `Reply again with the COMPLETE deliverable, condensed to fit: keep the order's length limit, keep every required section ` +
        `and the full source list, and cut detail first. Use the search results you already have. If the material genuinely needs ` +
        `more room than the order allows, still deliver the condensed version, then add one line at the very end of your reply, ` +
        `outside any file: [PETITION: up to N words — one-line reason]`;
      try {
        const c = await callAnthropic(model, systemProm,
          [...thread, { role: 'assistant', content: priorBlocks }, { role: 'user', content: condense }], maxTok, tools);
        if (c.error) throw new Error(c.error.message || JSON.stringify(c.error));
        usageSum.input_tokens  += c.usage?.input_tokens ?? 0;
        usageSum.output_tokens += c.usage?.output_tokens ?? 0;
        usageSum.searches      += c.usage?.server_tool_use?.web_search_requests ?? 0;
        allContent.length = 0; allContent.push(...(c.content || []));
        result = c;
        console.log(`[WARDEN]    condensed reply: ${result.stop_reason}`);
      } catch (ce) {
        console.warn(`[WARDEN] condense attempt failed: ${ce.message} — keeping the cut-off reply`);
      }
    }
    result = { ...result, content: allContent, usage: usageSum };
    const webSearches = usageSum.searches;

    // Text blocks are joined directly — with web search, sentences get split at citations
    let responseText   = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
                         || JSON.stringify(result);
    // Sources actually cited, for the record (Chancellor + Forseti see these)
    const cited = new Map();
    for (const b of result.content || []) {
      for (const c of b.citations || []) if (c.url && !cited.has(c.url)) cited.set(c.url, c.title || c.url);
    }
    if (result.stop_reason === 'max_tokens') {
      responseText += '\n\n[WARDEN] Reply hit the token limit and was cut off.';
      console.warn(`[WARDEN] ${msg.to_agent} hit max_tokens — output truncated`);
    }
    const inputTok     = result.usage?.input_tokens  ?? 0;
    const outputTok    = result.usage?.output_tokens ?? 0;
    const costUsd      = estimateCost(model, inputTok, outputTok) + webSearches * 0.01;  // $10 per 1,000 searches
    if (webSearches > 0) console.log(`[WARDEN]    web search: ${webSearches} search(es), ${cited.size} source(s) cited`);

    // Only the runner may mint [VERIFIED]/[FAILED]. An agent writing the tag
    // itself is self-report (Edict I) — defang it before the runner adds real ones.
    // (The Chancellor only relays the Warden's tags, so this applies to ministries.)
    const selfTags = MINISTRY_AGENTS.has(msg.to_agent)
      ? (responseText.match(/\[(?:VERIFIED|FAILED)\]/g) || []).length : 0;
    if (selfTags > 0) {
      responseText = responseText.replace(/\[(VERIFIED|FAILED)\]/g, '[agent-claimed $1]');
      console.warn(`[WARDEN] ${msg.to_agent} wrote ${selfTags} [VERIFIED]/[FAILED] tag(s) itself — marked as agent-claimed`);
    }

    // ── Petition: the ministry asks the Emperor for room beyond the order (Edict VIII) ──
    if (MINISTRY_AGENTS.has(msg.to_agent)) {
      const pm = responseText.match(PETITION_RE);
      if (pm) {
        responseText = responseText.replace(new RegExp(PETITION_RE.source, 'gi'), '').trimEnd();
        const request = pm[1].trim();
        const pid = stmtPetitionAdd.run(msg.task_id, msg.to_agent, request).lastInsertRowid;
        const title = (stmtTaskGet.get(msg.task_id) || {}).title || msg.task_id;
        stmtInsertMessage.run(`${msg.task_id}-PET${pid}`, msg.to_agent, 'emperor',
          `[PETITION #${pid}] ${msg.to_agent} asks to go beyond the order on "${String(title).slice(0, 90)}": ${request}. ` +
          `The in-scope version is delivered either way. Approve or deny it in the Petitions bar.`, msg.priority);
        responseText += `\n\n---\n[PETITION #${pid} filed with the Emperor: ${request}] The in-scope version above is the deliverable. ` +
          `A petition is not a failure — do not re-dispatch over it; the Emperor decides.`;
        console.log(`[WARDEN] petition #${pid} from ${msg.to_agent}: ${request}`);
      }
    }

    // Run code-writer — extract FILE: blocks and write to disk
    let verifiedFiles = [];
    if (codeWriter) {
      try {
        const fileResults = codeWriter.extractAndWrite(responseText, msg.task_id, busDb);
        if (fileResults.length > 0) {
          const verified = fileResults.filter(r => r.success);
          verifiedFiles = verified;
          const gated    = fileResults.filter(r => r.gated);
          const failed   = fileResults.filter(r => !r.success && !r.gated);

          // ── Ask-First Gate: file a petition per refused file; the task waits for the Emperor ──
          if (gated.length > 0) {
            for (const g of gated) {
              const pending = stmtGatePending.get(g.rel);
              const pid = pending ? pending.id : stmtGatePetition.run(msg.task_id, msg.to_agent,
                `Write ${g.rel} (outside output/, changes the Empire's own files)`, g.rel).lastInsertRowid;
              if (!pending) stmtInsertMessage.run(`${msg.task_id}-GATE${pid}`, 'warden', 'emperor',
                `[ASK-FIRST #${pid}] ${msg.to_agent} wants to write ${g.rel}, which is outside output/. Nothing was written. ` +
                `Approve or deny it in the Petitions bar. One approval allows one write of that file, for 24 hours.`, msg.priority);
              console.log(`[WARDEN] gate: ${g.rel} needs approval (petition #${pid})`);
            }
            stmtTaskReason.run('awaiting_approval', `Ask-first: ${gated.map(g => g.rel).join(', ')}`.slice(0, 300), msg.task_id);
            responseText += '\n\n---\n' + gated.map(g => `[AWAITING APPROVAL] ${g.path} — not written; the Emperor decides`).join('\n') +
              `\nThis is not a failure — do not re-dispatch over it.`;
          }

          if (verified.length > 0) {
            responseText += '\n\n---\n' + verified.map(r =>
              `[VERIFIED] ${r.path} — ${r.bytes} bytes written`
            ).join('\n');
          }
          if (failed.length > 0) {
            responseText += '\n\n---\n' + failed.map(r =>
              `[FAILED] ${r.path} — ${r.error}`
            ).join('\n');
          }

          console.log(`[WARDEN] runner: ${verified.length} VERIFIED, ${failed.length} FAILED`);
          if (verified.length > 0) {
            stmtTaskArtifact.run(verified.map(v => v.path).join('; '),
              verified.reduce((a, v) => a + v.bytes, 0), msg.task_id);
          }
          for (const v of verified) {
            console.log(`[WARDEN] runner: VERIFIED ${v.path} — ${v.bytes} bytes`);
          }
          for (const f of failed) {
            console.log(`[WARDEN] runner: FAILED ${f.path} — ${f.error}`);
          }
        }
      } catch (cwe) {
        console.warn(`[WARDEN] code-writer error: ${cwe.message}`);
      }
    }
// Inject file reads back into conversation
    if (codeWriter) {
      const readRequests = codeWriter.extractReadRequests(responseText);
      if (readRequests.length > 0) {
        const injections = [];
        for (const rawPath of readRequests) {
          const result = codeWriter.readFile(rawPath);
          if (result.success) {
            injections.push(`[FILE: ${rawPath}]\n\`\`\`\n${result.content}\n\`\`\``);
            console.log(`[WARDEN] file-read injected: ${rawPath}`);
          } else {
            injections.push(`[FILE: ${rawPath}] ERROR: ${result.error}`);
            console.warn(`[WARDEN] file-read failed: ${rawPath} — ${result.error}`);
          }
        }
        if (injections.length > 0) {
          stmtInsertMessage.run(
            msg.task_id, 'warden', msg.to_agent,
            `[WARDEN FILE BRIDGE]\n\n${injections.join('\n\n')}`,
            msg.priority
          );
          console.log(`[WARDEN] file-bridge: injected ${injections.length} file(s) for ${msg.to_agent}`);
        }
      }
    }
    if (cited.size > 0) {
      responseText += '\n\n---\n[SOURCES cited via web search]\n' +
        [...cited].slice(0, 15).map(([u, t]) => `- ${t} — ${u}`).join('\n');
    }

    // ── Forseti: fresh-eyes judgment of ministry files (Lawspeaker first) ──
    if (forseti && CRITIC_CONF.enabled !== false && MINISTRY_AGENTS.has(msg.to_agent) && verifiedFiles.length > 0) {
      const criticModel = resolveModel(CRITIC_CONF.model || 'haiku');
      try {
        const v = await forseti.review({
          taskText:  formatContent(msg.content),
          wordLimitFrom: formatContent(msg.content),
          files:     verifiedFiles,
          truncated: result.stop_reason === 'max_tokens',
          requireSources: webSearches > 0,
          canSpend:  () => stmtDailySpend.get().total < limit,
          callModel: async (sys, msgs) => {
            const r = await callAnthropic(criticModel, sys, msgs, 2048);
            if (r.error) throw new Error(r.error.message || JSON.stringify(r.error));
            const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
            return { text, inputTok: r.usage?.input_tokens ?? 0, outputTok: r.usage?.output_tokens ?? 0 };
          }
        });
        if (v.layer === 'forseti') {
          const cCost = estimateCost(criticModel, v.inputTok, v.outputTok);
          stmtLogApiCall.run(msg.task_id, 'forseti', criticModel, v.inputTok, v.outputTok, cCost);
          stmtUpsertDaily.run(new Date().toISOString().split('T')[0], cCost);
          stmtTaskCost.run(cCost, msg.task_id);
          sessionTokens += v.inputTok + v.outputTok;
        }
        const isFail = v.verdict === 'FAIL';
        stmtTaskCritic.run(v.verdict, v.problems.join(' | '), isFail ? 1 : 0, msg.task_id);
        const fails = stmtTaskGet.get(msg.task_id)?.forseti_fails ?? 0;
        const who   = v.layer === 'lawspeaker' ? 'the Lawspeaker' : 'Forseti';
        let note = `\n\n---\n[FORSETI: ${v.verdict}] (${who})`;
        if (v.problems.length) note += '\n' + v.problems.map(p => `- ${p}`).join('\n');
        if (isFail) {
          note += fails >= MAX_ATTEMPTS
            ? `\nRevision limit reached (${fails} failed reviews). Report this task to the Emperor as FAILED with these problems. Do not re-dispatch.`
            : `\nRevision ${fails} of ${MAX_ATTEMPTS - 1} available. You may re-dispatch to ${msg.to_agent} with these problems listed, or report to the Emperor.`;
        }
        responseText += note;
        console.log(`[WARDEN] forseti (${who}): ${v.verdict}${v.problems.length ? ' — ' + v.problems.join(' | ').slice(0, 160) : ''}`);
      } catch (ce) {
        responseText += `\n\n---\n[FORSETI: UNSURE] Forseti could not sit in judgment: ${ce.message}`;
        stmtTaskCritic.run('UNSURE', ce.message.slice(0, 200), 0, msg.task_id);
        console.warn(`[WARDEN] forseti error: ${ce.message}`);
      }
    }

    // Parse dispatch commands FIRST (only from Chancellor)
    // If dispatches exist, this is an internal routing message — do NOT send to Emperor
    const dispatches = msg.to_agent === 'imperial-chancellor' ? parseDispatches(responseText) : [];
    let dispatchedCount = 0;
    for (const d of dispatches) {
      // Allow retries/continuations/revisions, but cap them per ministry per task
      const already = stmtCountDelivered.get(msg.task_id, d.to);
      if (already.n >= MAX_ATTEMPTS) {
        console.log(`[WARDEN] dispatch refused — ${d.to} already had ${already.n} attempts on ${msg.task_id}`);
        stmtInsertMessage.run(msg.task_id, 'warden', 'emperor',
          `[FAILED] ${d.to} hit the ${MAX_ATTEMPTS}-attempt limit on this task. Stopped to protect the budget.`, msg.priority);
        stmtTaskFinish.run('failed', msg.task_id);
        stmtTaskReasonOnly.run(`${d.to} hit the ${MAX_ATTEMPTS}-attempt limit`, msg.task_id);
        continue;
      }
      const content = typeof d.content === 'string' ? d.content : JSON.stringify(d.content ?? '');
      stmtInsertMessage.run(msg.task_id, msg.to_agent, d.to, content, d.priority ?? msg.priority);
      console.log(`[WARDEN] dispatch -> ${d.to}`);
      dispatchedCount++;
    }

    // Phase 3½: the Chancellor said it's blocked on a missing fact -> the ledger says so, with the reason
    if (msg.to_agent === 'imperial-chancellor' && dispatchedCount === 0) {
      const bm = responseText.match(BLOCKED_RE);
      if (bm) {
        stmtTaskReason.run('blocked', bm[1].trim(), msg.task_id);
        console.log(`[WARDEN] task ${msg.task_id} BLOCKED: ${bm[1].trim()}`);
      }
    }

    // Route the response back — but suppress if it contained dispatches
    // Dispatch blocks are internal routing instructions, not Emperor-facing output
    if (dispatchedCount === 0) {
      let responseTarget = msg.from_agent;
      if (msg.to_agent === 'imperial-chancellor' && MINISTRY_AGENTS.has(msg.from_agent)) {
        const origin = stmtTaskOrigin.get(msg.task_id);
        responseTarget = origin?.from_agent ?? 'emperor';
        console.log(`[WARDEN]    aggregation: routing Chancellor response -> ${responseTarget}`);
      }
      // The Warden, not the Chancellor, reports what a task cost — from the Imperial Ledger
      if (msg.to_agent === 'imperial-chancellor' && responseTarget === 'emperor') {
        try {
          const rows = ledgerDb.prepare(`SELECT agent_id, COUNT(*) n, SUM(cost_usd) c FROM api_calls WHERE task_id = ? GROUP BY agent_id`).all(msg.task_id);
          const by = { chancellor: costUsd, ministries: 0, forseti: 0 }; let calls = 1;
          for (const r of rows) {
            calls += r.n;
            if (r.agent_id === 'imperial-chancellor') by.chancellor += r.c;
            else if (r.agent_id === 'forseti') by.forseti += r.c;
            else by.ministries += r.c;
          }
          const total = by.chancellor + by.ministries + by.forseti;
          responseText += `\n\n---\n[LEDGER] This task cost $${total.toFixed(4)} across ${calls} calls ` +
            `(Chancellor $${by.chancellor.toFixed(4)} · ministries $${by.ministries.toFixed(4)} · Forseti $${by.forseti.toFixed(4)}).`;
        } catch (le) { console.warn('[WARDEN] ledger summary failed:', le.message); }
      }
      stmtInsertMessage.run(msg.task_id, msg.to_agent, responseTarget, responseText, msg.priority);
    } else {
      console.log(`[WARDEN]    ${dispatchedCount} dispatch(es) sent — raw response suppressed from Emperor feed`);
    }

    // Mark original delivered
    stmtMarkDelivered.run(msg.id);

    // Log to Imperial Ledger
    stmtLogApiCall.run(msg.task_id, msg.to_agent, model, inputTok, outputTok, costUsd);
    const today = new Date().toISOString().split('T')[0];
    stmtUpsertDaily.run(today, costUsd);
    stmtTaskCost.run(costUsd, msg.task_id);

    // Update session counters
    sessionMessages++;
    sessionTokens += inputTok + outputTok;

    console.log(`[WARDEN] response received | ${inputTok + outputTok} tokens | $${costUsd.toFixed(5)}`);

    const postSpend = stmtDailySpend.get().total;
    console.log(`[WARDEN]    daily spend: $${postSpend.toFixed(4)} / $${limit}`);

  } catch (e) {
    console.error(`[WARDEN] API error for ${msg.to_agent}: ${e.message}`);
    stmtMarkFailed.run(msg.id);
    stmtTaskFinish.run('failed', msg.task_id);
    stmtTaskReasonOnly.run(`${msg.to_agent} could not run: ${e.message}`.slice(0, 300), msg.task_id);
    // Edict IV: report failures to the Emperor, don't swallow them
    stmtInsertMessage.run(msg.task_id, 'warden', 'emperor',
      `[FAILED] ${msg.to_agent} could not run: ${e.message}`, msg.priority);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────
console.log('');
console.log('=== NORSE IMPERIUM WARDEN v2.1 ===');
console.log('─────────────────────────────────────────');
console.log(`Bus:      ${BUS_DB_PATH}`);
console.log(`Ledger:   ${LEDGER_DB_PATH}`);
console.log(`Agents:   ${Object.keys(registry.agents).join(', ')}`);
console.log(`Budget:   $${registry.budget.daily_limit_usd}/day (warn at ${registry.budget.warn_at_pct}%)`);
console.log(`Tick:     every ${TICK_MS / 1000}s`);
console.log('─────────────────────────────────────────');
console.log('Watching... (idle = zero tokens)\n');

tick();
setInterval(tick, TICK_MS);
