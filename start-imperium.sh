#!/bin/bash
# ══════════════════════════════════════════════════════════════════════
# NORSE IMPERIUM — Startup (WSL) — v2.1, 2026-11-01
# One click: double-click Imperium.bat on Windows.
# By hand:   bash /mnt/c/Imperium/start-imperium.sh
# Stop:      Ctrl+C, or close the window. Both shut everything down.
# ══════════════════════════════════════════════════════════════════════

IMPERIUM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$IMPERIUM_DIR" || exit 1
mkdir -p logs output

echo ""
echo "  ⚔  NORSE IMPERIUM"
echo "  $IMPERIUM_DIR"

# ── 0. Node on PATH? (nvm users: load it) ───────────────────────────────
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "  [FAIL] Node.js not found inside WSL. Install Node 22.5+ (e.g. via nvm)."
  exit 1
fi

# ── 1. Stop anything left over from last time ─────────────────────────
# (match full paths so we never touch Jarlsburg or anything else)
pkill -f "^node .*$IMPERIUM_DIR/imperium-terminal.js" 2>/dev/null
pkill -f "^node .*$IMPERIUM_DIR/warden.js" 2>/dev/null
command -v fuser >/dev/null 2>&1 && fuser -k 7878/tcp >/dev/null 2>&1
sleep 1

# ── 2. Preflight — electrons in a row ─────────────────────────────────
node --no-warnings "$IMPERIUM_DIR/preflight.js" || exit 1

# ── 3. Terminal (web UI) in the background ────────────────────────────
node --no-warnings "$IMPERIUM_DIR/imperium-terminal.js" >> logs/terminal.log 2>&1 &
PID_TERMINAL=$!
sleep 1
if ! kill -0 "$PID_TERMINAL" 2>/dev/null; then
  echo "  [FAIL] Terminal didn't start — see logs/terminal.log"
  exit 1
fi

shutdown() {
  echo ""
  echo "  ⚔  Standing down the Imperium..."
  kill "$PID_TERMINAL" 2>/dev/null
  [ -n "$PID_WARDEN" ] && kill "$PID_WARDEN" 2>/dev/null
  exit 0
}
trap shutdown INT TERM HUP

echo "  Terminal:  http://localhost:7878"
# Open the browser on the Windows side (quietly skip if not in WSL)
[ -z "$IMPERIUM_NO_BROWSER" ] && command -v cmd.exe >/dev/null 2>&1 && cmd.exe /c start "" "http://localhost:7878" >/dev/null 2>&1

# ── 4. Warden in the foreground ───────────────────────────────────────
echo "  Warden starting — Ctrl+C or close this window to stop everything."
echo ""
node --no-warnings "$IMPERIUM_DIR/warden.js" &
PID_WARDEN=$!
wait "$PID_WARDEN"
shutdown
