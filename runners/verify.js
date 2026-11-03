'use strict';
// ══════════════════════════════════════════════════════════════════════
// VERIFY RUNNER — Confirms a file exists and returns metadata
// ══════════════════════════════════════════════════════════════════════

const fs   = require('node:fs');
const path = require('node:path');

/**
 * Convert Windows path (C:\...) to WSL path (/mnt/c/...) when running in WSL,
 * or normalize to forward slashes on Windows.
 */
function resolvePath(filePath) {
  if (!filePath) return filePath;

  // Already a Unix absolute path
  if (filePath.startsWith('/')) return filePath;

  // Windows drive-letter path
  const driveMatch = filePath.match(/^([A-Za-z]):[/\\](.*)/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest  = driveMatch[2].replace(/\\/g, '/');
    if (process.platform === 'win32') {
      return `${drive.toUpperCase()}:/${rest}`;
    }
    return `/mnt/${drive}/${rest}`;
  }

  return filePath;
}

/**
 * Check if a file exists and return metadata.
 * @param {string} filePath — Windows or Unix path
 * @returns {{ exists: boolean, bytes?: number, path: string, error?: string }}
 */
function check(filePath) {
  const resolved = resolvePath(filePath);
  try {
    const stat = fs.statSync(resolved);
    return { exists: true, bytes: stat.size, path: resolved };
  } catch (e) {
    return { exists: false, path: resolved, error: e.message };
  }
}

module.exports = { check, resolvePath };
