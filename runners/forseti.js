'use strict';
// ══════════════════════════════════════════════════════════════════════
// FORSETI — the Imperium's judge, v1.1 (2026-11-01)
// Named for the Norse god of justice who settled every dispute in his hall, Glitnir.
// Two layers, cheapest first:
//   1. The Lawspeaker — plain code, zero tokens. Empty, truncated, won't parse.
//   2. Forseti — a cheap model with FRESH context: it sees only the task and
//      the files. Never the ministry's reasoning. It advises; it can't edit.
// Verdict: PASS or FAIL + at most 3 specific problems.
// ══════════════════════════════════════════════════════════════════════
const fs   = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAX_FILE_CHARS = 40_000;   // per file sent to the Critic
const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.cs', '.java', '.c', '.cpp', '.h', '.css', '.json', '.gd']);

function tryRun(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'pipe', timeout: 15_000 }); return null; }
  catch (e) {
    if (e.code === 'ENOENT') return null;                    // tool not installed — skip
    return String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 200);
  }
}

function braceBalance(text) {
  // Rough: strip strings and comments, then count. Good enough to catch "ends mid-method".
  const s = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');
  let curly = 0, paren = 0;
  for (const ch of s) {
    if (ch === '{') curly++; else if (ch === '}') curly--;
    else if (ch === '(') paren++; else if (ch === ')') paren--;
  }
  return { curly, paren };
}

// Word limit stated in the order ("350-450 words", "under 400 words", "about 500 words"). Upper bound, or null.
function wordLimit(taskText) {
  const t = String(taskText || '');
  let m = t.match(/(\d{2,5})\s*(?:-|–|—|to)\s*(\d{2,5})\s*words/i);
  if (m) return Math.max(+m[1], +m[2]);
  m = t.match(/(\d{2,5})\s*words/i);
  return m ? +m[1] : null;
}

// Prose words, not counting a trailing Sources/References section or bare URLs
function proseWords(md) {
  const cut = md.search(/^#{1,4}\s*(sources|references|bibliography|citations)\b/im);
  const body = cut >= 0 ? md.slice(0, cut) : md;
  return body.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ')
             .replace(/[#*_>|`-]+/g, ' ').split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
}

// ── Layer 1: the Lawspeaker ───────────────────────────────────────────────
function lawCheck(files, { truncated = false, requireSources = false, wordLimitFrom = '' } = {}) {
  const problems = [];
  const limit = wordLimit(wordLimitFrom);
  if (truncated) problems.push('Reply hit the token limit — output is cut off.');
  for (const f of files) {
    const name = path.basename(f.resolvedPath);
    const ext  = path.extname(name).toLowerCase();
    let text;
    try { text = fs.readFileSync(f.resolvedPath, 'utf8'); }
    catch (e) { problems.push(`${name}: can't read back from disk (${e.message}).`); continue; }

    if (text.trim().length < 40) { problems.push(`${name}: nearly empty (${text.length} bytes).`); continue; }
    if (/\/\/\s*CONTINUED:|\.\.\.\s*\(rest of|\[truncated\]|TODO: (?:finish|complete)/i.test(text)) {
      problems.push(`${name}: contains a placeholder or continuation marker — not finished.`);
    }
    if (ext === '.md' && ((text.match(/^[ \t]*```/gm) || []).length % 2 === 1)) {
      problems.push(`${name}: a code block is never closed — document likely cut off.`);
    }
    if (ext === '.json') {
      try { JSON.parse(text); } catch (e) { problems.push(`${name}: invalid JSON (${e.message.slice(0, 80)}).`); }
    } else if (['.js', '.cjs', '.mjs'].includes(ext)) {
      const err = tryRun(process.execPath, ['--check', f.resolvedPath]);
      if (err) problems.push(`${name}: syntax error — ${err}`);
    } else if (ext === '.py') {
      const err = tryRun('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', f.resolvedPath]);  // parse only, no __pycache__
      if (err) problems.push(`${name}: syntax error — ${err}`);
    } else if (ext === '.sh') {
      const err = tryRun('bash', ['-n', f.resolvedPath]);
      if (err) problems.push(`${name}: syntax error — ${err}`);
    }
    if (limit && ext === '.md') {
      const n = proseWords(text);
      if (n > Math.ceil(limit * 1.10)) {
        problems.push(`${name}: ${n} words (sources not counted); the order allows ${limit}. Cut about ${n - limit} words — ` +
                      `or deliver ${limit} and add a PETITION line if the material truly needs more.`);
      }
    }
    if (requireSources && ext === '.md' && !/https?:\/\/\S+/.test(text)) {
      problems.push(`${name}: research with web search on, but the document cites no source links.`);
    }
    if (CODE_EXT.has(ext) && ext !== '.json') {
      const b = braceBalance(text);
      if (b.curly > 0 || b.paren > 0) problems.push(`${name}: ${b.curly} unclosed { and ${b.paren} unclosed ( — file ends mid-code.`);
    }
  }
  return problems.slice(0, 3);
}

// ── Layer 2: Forseti's judgment ─────────────────────────────────────────
const FORSETI_SYSTEM = `You are Forseti, judge of the Norse Imperium. You review finished work with fresh eyes.
You are given ONLY the task as it was assigned and the files that were produced. Judge whether the files actually do what the task asked.

Check, in order:
1. Does it deliver every item the task explicitly asked for? Name any that are missing.
2. Is it complete — no stubs, placeholders, sections promised but absent, or code that stops early?
3. Is anything plainly wrong (a bug that would stop it working, a factual error, wrong language or format)?
4. For research: are claims backed by the sources listed, or does it state things the sources don't support?

Do NOT fail work for style, taste, or things the task didn't ask for. If it does the job, PASS it.
Reply with ONLY this JSON, nothing else:
{"verdict":"PASS" or "FAIL","problems":["short specific problem", "..."]}
At most 3 problems, each under 25 words. PASS may have an empty list. Keep the whole reply short.
Do not fail work for length — word counts are checked separately in code.`;

// Backtest audit (2026-11-01) — the eight ways a backtest lies. Added to Forseti's review whenever
// the task or the code is about backtesting / trading strategies.
const BACKTEST_AUDIT = `## BACKTEST AUDIT — this work involves a backtest or trading strategy
Check each item. Any item that is ABSENT or done wrong is a problem; quote the offending line.
1. Look-ahead: is the signal shifted one bar (acted on at the NEXT bar) before it becomes a position?
2. Survivorship: was the asset list chosen with hindsight (only survivors/winners), or does it include delisted names?
3. Repainting: does any indicator use future data (centered moving averages, zigzag, unshifted resample)?
4. Costs: are fees AND slippage charged on turnover?
5. Fills: does it assume execution at a price that was never actually available (e.g., the signal bar's close)?
6. Parameter fitting: were parameters chosen by looking at the whole dataset instead of a training part only?
7. Regimes: does the test period contain both a bull and a bear market?
8. Alignment: are all series on the same timezone and bar-close convention?
A backtest with an annualized Sharpe above 2 on daily data is presumed leaky until shown otherwise.`;
const BACKTEST_RE = /backtest|sharpe|drawdown|walk[- ]?forward|trading strateg|entry.{0,20}exit|\.shift\(|equity curve|position siz/i;

function needsBacktestAudit(taskText, files) {
  if (BACKTEST_RE.test(taskText || '')) return true;
  for (const f of files) {
    try {
      const t = fs.readFileSync(f.resolvedPath, 'utf8').slice(0, 40_000);
      if (BACKTEST_RE.test(t)) return true;
      if (/\b(position|signal)s?\b/i.test(t) && /\breturns?\b|\bpnl\b|\bequity\b/i.test(t)) return true;   // positions × returns = a backtest, shifted or not
    } catch {}
  }
  return false;
}

function buildCriticPrompt(taskText, files) {
  const audit = needsBacktestAudit(taskText, files) ? `\n\n${BACKTEST_AUDIT}` : '';
  const parts = [`## TASK AS ASSIGNED\n${taskText}${audit}\n\n## FILES PRODUCED`];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f.resolvedPath, 'utf8'); } catch {}
    const cut = text.length > MAX_FILE_CHARS;
    parts.push(`### ${f.path} (${text.length} chars${cut ? ', showing first ' + MAX_FILE_CHARS : ''})\n\`\`\`\n${cut ? text.slice(0, MAX_FILE_CHARS) : text}\n\`\`\``);
  }
  return parts.join('\n\n');
}

function parseVerdict(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const verdict = String(j.verdict).toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
      const problems = Array.isArray(j.problems) ? j.problems.map(String).slice(0, 3) : [];
      return { verdict, problems };
    } catch {}
  }
  // Unreadable verdict: don't block the work on our own malfunction, but say so.
  return { verdict: 'UNSURE', problems: ['Forseti\'s reply was unreadable — no verdict.'] };
}

/**
 * review({ taskText, files, truncated, callModel, canSpend })
 * callModel(systemPrompt, messages) -> Promise<{ text, inputTok, outputTok }>
 * canSpend() -> boolean  (budget gate)
 */
async function review({ taskText, files, truncated = false, requireSources = false, wordLimitFrom = '', callModel, canSpend }) {
  const law = lawCheck(files, { truncated, requireSources, wordLimitFrom });
  if (law.length > 0) return { verdict: 'FAIL', problems: law, layer: 'lawspeaker', inputTok: 0, outputTok: 0 };
  if (!callModel) return { verdict: 'PASS', problems: [], layer: 'lawspeaker', inputTok: 0, outputTok: 0 };
  if (canSpend && !canSpend()) {
    return { verdict: 'UNSURE', problems: ['Budget limit reached — Forseti skipped. The Lawspeaker\'s checks passed.'], layer: 'lawspeaker', inputTok: 0, outputTok: 0 };
  }
  const r = await callModel(FORSETI_SYSTEM, [{ role: 'user', content: buildCriticPrompt(taskText, files) }]);
  return { ...parseVerdict(r.text), layer: 'forseti', inputTok: r.inputTok, outputTok: r.outputTok };
}

module.exports = { BACKTEST_AUDIT, needsBacktestAudit, wordLimit, proseWords, review, lawCheck, parseVerdict, buildCriticPrompt, FORSETI_SYSTEM };
