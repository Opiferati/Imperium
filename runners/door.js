'use strict';
// ======================================================================
// THE DOOR (2026-11-15, Trials baseline finding 1)
//
// imperium-terminal.js listened on 127.0.0.1 only, which kept the network out but
// not the browser. Any web page open in Edge could POST to http://127.0.0.1:7878 and
// issue a decree, approve a petition or rewrite settings: readBody() parses any body
// as JSON whatever its Content-Type, so a plain cross-site "simple" request needed no
// preflight. And every JSON reply carried Access-Control-Allow-Origin: *, so any page
// could also READ the feed, the settings (OctoPrint key included) and the relics.
//
// The door asks three things, all of which the dashboard's own page satisfies
// without knowing it is being asked, and none of which a foreign page can fake:
//   1. Host is ours. Stops DNS rebinding (evil.example re-pointed at 127.0.0.1).
//   2. A request that changes something comes from our own origin. Browsers stamp
//      Origin and Sec-Fetch-Site on every POST; a page cannot forge either.
//   3. A request that changes something carries X-Imperium-Request. A custom header
//      forces a CORS preflight from any other origin, and this server answers no
//      preflight, so the browser never sends the real request at all.
// No secret, nothing to rotate, survives restarts. Local programs (curl, scripts)
// can still get in by sending the header; the door is against web pages, not against
// code already running on the machine, which no header check can stop.
// ======================================================================

const DOOR_HEADER = 'x-imperium-request';

function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

function allowedOrigins(port) {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

const READS = new Set(['GET', 'HEAD']);

// Returns null when the request may pass, or a short reason when it may not.
function checkDoor(req, port) {
  const h = req.headers || {};
  const host = String(h.host || '').toLowerCase();
  if (!allowedHosts(port).has(host)) return 'host not allowed';

  if (READS.has(String(req.method || '').toUpperCase())) return null;

  const origin = h.origin;
  if (origin !== undefined && !allowedOrigins(port).has(String(origin).toLowerCase())) {
    return 'cross-origin request refused';
  }
  const site = h['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return 'cross-site request refused';
  }
  if (h[DOOR_HEADER] !== '1') return 'missing X-Imperium-Request header';
  return null;
}

module.exports = { checkDoor, DOOR_HEADER };
