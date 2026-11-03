'use strict';
// ══════════════════════════════════════════════════════════════════════
// CODE-WRITER RUNNER v2.1 (2026-11-01)
// Extracts "// FILE: <path>" blocks from agent replies and writes them.
// v2.1 fixes:
//   - FILE:/READ: only count at the START of a line. Paths mentioned inside
//     dispatch JSON no longer create junk files (the `",` and `/n` debris).
//   - Paths stop at quotes/backticks, and a literal "\n" ends a path.
//   - Fenced content honours nested ``` blocks (depth-counted), so docs
//     with nested ``` examples are no longer cut off after section one.
//   - Sandbox: writes are only allowed inside the Imperium folder.
// ══════════════════════════════════════════════════════════════════════
const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let gate = null;
try { gate = require('./gate.js'); } catch (e) { console.warn('[CODE-WRITER] gate.js not loaded — falling back to the folder sandbox:', e.message); }

function normalisePath(rawPath) {
  let trimmed = rawPath.trim().split('\\n')[0];          // literal \n ends a path
  trimmed = trimmed.replace(/[",;)\]}]+$/, '');            // trailing JSON debris
  if (trimmed.startsWith('/')) return path.resolve(trimmed);
  const winMatch = trimmed.match(/^([A-Za-z]):[\\\/](.*)/);
  if (winMatch) {
    const driveLetter = winMatch[1].toLowerCase();
    const rest        = winMatch[2].replace(/\\/g, '/');
    if (process.platform === 'win32') return path.resolve(`${driveLetter.toUpperCase()}:/${rest}`);
    return path.resolve(`/mnt/${driveLetter}/${rest}`);
  }
  return path.resolve(ROOT, trimmed.replace(/\\/g, '/'));
}

function insideRoot(p) {
  const rel = path.relative(ROOT, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Declaration must start its own line:  // FILE: x   # FILE: x   <!-- FILE: x -->
const FILE_DECL_RE = /^[ \t]*(?:\/\/|<!--|#)[ \t]*FILE:[ \t]*([^\s"'`<>|*?]+)/gim;
const READ_DECL_RE = /^[ \t]*(?:\/\/|<!--|#)[ \t]*READ:[ \t]*([^\s"'`<>|*?]+)/gim;

function extractBody(segment) {
  const lines = segment.replace(/^[ \t]*-->[ \t]*/, '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^[ \t]*```/.test(lines[i])) {
    // fenced: track nesting — ```lang opens, bare ``` closes
    let depth = 1, end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[ \t]*```[ \t]*$/.test(lines[j])) { depth--; if (depth === 0) { end = j; break; } }
      else if (/^[ \t]*```[\w+#.-]+/.test(lines[j])) depth++;
    }
    const body = end === -1 ? lines.slice(i + 1) : lines.slice(i + 1, end);
    return body.join('\n').replace(/\s+$/, '');
  }
  // unfenced (e.g. a whole markdown doc): take the segment, drop a stray
  // closing fence at the end and any runner footer that was appended
  let body = lines.slice(i).join('\n');
  body = body.replace(/\n---\n\[(?:VERIFIED|FAILED)\][\s\S]*$/, '');
  body = body.replace(/\n[ \t]*```[ \t]*\n\s*\[(?:VERIFIED|FAILED)\][\s\S]*$/, '');
  body = body.replace(/\n[ \t]*```[ \t]*\s*$/, '');
  return body.trim();
}

function extractFileBlocks(responseText) {
  const decls = [];
  let m;
  FILE_DECL_RE.lastIndex = 0;
  while ((m = FILE_DECL_RE.exec(responseText)) !== null) {
    decls.push({ raw: m[1].replace(/-->$/, ''), start: m.index, end: m.index + m[0].length });
  }
  const results = [];
  decls.forEach((d, k) => {
    const lineEnd  = responseText.indexOf('\n', d.end);
    const segStart = lineEnd === -1 ? responseText.length : lineEnd + 1;
    const segEnd   = k + 1 < decls.length ? decls[k + 1].start : responseText.length;
    const content  = extractBody(responseText.slice(segStart, segEnd));
    if (content.length > 0) {
      results.push({ declaredPath: d.raw, resolvedPath: normalisePath(d.raw), content });
    }
  });
  return results;
}

function extractReadRequests(responseText) {
  const out = [];
  let m;
  READ_DECL_RE.lastIndex = 0;
  while ((m = READ_DECL_RE.exec(responseText)) !== null) out.push(m[1].replace(/-->$/, ''));
  return out;
}

function extractAndWrite(responseText, taskId, db = null) {   // db: the bus, for Ask-First approvals
  const blocks  = extractFileBlocks(responseText);
  const results = [];
  for (const block of blocks) {
    let approvalId = null;
    try {
      if (!insideRoot(block.resolvedPath)) {
        throw new Error(`Outside the Imperium folder — refused: ${block.resolvedPath}`);
      }
      // ── The Ask-First Gate (2026-11-03) ──
      if (gate) {
        const g = gate.classifyWrite(block.resolvedPath);
        if (g.verdict === 'never') throw new Error(`NEVER — ${g.reason}`);
        if (g.verdict === 'ask') {
          const ap = db ? gate.findApproval(db, block.resolvedPath) : null;
          if (!ap) {
            console.warn(`[CODE-WRITER] ⛔ ${block.declaredPath} — ASK-FIRST: ${g.reason}`);
            results.push({ path: block.declaredPath, resolvedPath: block.resolvedPath, rel: g.rel, bytes: 0,
                           success: false, gated: true, error: `ASK-FIRST — ${g.reason}` });
            continue;
          }
          approvalId = ap.id;
        }
      }
      fs.mkdirSync(path.dirname(block.resolvedPath), { recursive: true });
      if (fs.existsSync(block.resolvedPath) && fs.statSync(block.resolvedPath).isDirectory()) {
        throw new Error(`Path is a directory, not a file: ${block.resolvedPath}`);
      }
      fs.writeFileSync(block.resolvedPath, block.content + '\n', 'utf8');
      // Verify from disk, not from memory
      const bytes = fs.statSync(block.resolvedPath).size;
      if (bytes === 0) throw new Error('File is empty after write');
      if (approvalId && db) { gate.useApproval(db, approvalId); console.log(`[CODE-WRITER] approval #${approvalId} used`); }
      console.log(`[CODE-WRITER] ✓ ${block.declaredPath} (${bytes} bytes)`);
      results.push({ path: block.declaredPath, resolvedPath: block.resolvedPath, bytes, success: true });
    } catch (err) {
      console.error(`[CODE-WRITER] ✗ ${block.declaredPath} — ${err.message}`);
      results.push({ path: block.declaredPath, resolvedPath: block.resolvedPath, bytes: 0, success: false, error: err.message });
    }
  }
  return results;
}

function readFile(rawPath) {
  const resolvedPath = normalisePath(rawPath);
  try {
    if (!insideRoot(resolvedPath)) throw new Error('Outside the Imperium folder — refused');
    if (gate) { const g = gate.classifyRead(resolvedPath); if (g.verdict === 'never') throw new Error(`NEVER — ${g.reason}`); }
    const content = fs.readFileSync(resolvedPath, 'utf8');
    return { path: rawPath, resolvedPath, content, success: true };
  } catch (err) {
    return { path: rawPath, resolvedPath, content: null, success: false, error: err.message };
  }
}

module.exports = { extractAndWrite, readFile, normalisePath, extractFileBlocks, extractReadRequests, ROOT };
