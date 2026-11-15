// ======================================================================
// THE DOOR (tests written 2026-11-15)
//
// Trials baseline finding 1: the dashboard's buttons answered any web page. These
// tests pin the three checks in runners/door.js, then pin that imperium-terminal.js
// and imperium-ui.html actually use them. Part 1 is behavioural: a real HTTP server
// on a spare port, real requests, real status codes. Parts 2 and 3 are source
// assertions, which are weaker and are named as such (warden-guards.test.js
// precedent): the terminal cannot be started in a test without opening the live bus.
// ======================================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { checkDoor } = require(path.join(ROOT, 'runners', 'door.js'));

// -- 1. Behaviour: a stand-in server that uses the real door -------------
let server, port;
before(async () => {
  server = http.createServer((req, res) => {
    const refused = checkDoor(req, port);
    res.writeHead(refused ? 403 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(refused ? { error: 'refused: ' + refused } : { ok: true }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

function send(method, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/api/send', headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{"content":"x"}' : undefined);
  });
}
const ours = () => `127.0.0.1:${port}`;
const ourOrigin = () => `http://127.0.0.1:${port}`;

test("the dashboard's own button passes (same origin, door header)", async () => {
  assert.strictEqual(await send('POST', { Host: ours(), Origin: ourOrigin(),
    'Sec-Fetch-Site': 'same-origin', 'X-Imperium-Request': '1' }), 200);
});

test('localhost:<port> is ours too (start-imperium.sh opens that address)', async () => {
  assert.strictEqual(await send('POST', { Host: `localhost:${port}`, Origin: `http://localhost:${port}`,
    'Sec-Fetch-Site': 'same-origin', 'X-Imperium-Request': '1' }), 200);
});

test('a foreign page is refused even if it somehow adds the header', async () => {
  assert.strictEqual(await send('POST', { Host: ours(), Origin: 'https://evil.example',
    'Sec-Fetch-Site': 'cross-site', 'X-Imperium-Request': '1' }), 403);
});

test('a plain cross-site form post (no header) is refused', async () => {
  assert.strictEqual(await send('POST', { Host: ours(), Origin: 'https://evil.example',
    'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' }), 403);
});

test('a file:// page (Origin "null") is refused', async () => {
  assert.strictEqual(await send('POST', { Host: ours(), Origin: 'null', 'X-Imperium-Request': '1' }), 403);
});

test('DNS rebinding is refused: a foreign Host header, even on a read', async () => {
  assert.strictEqual(await send('GET', { Host: `evil.example:${port}` }), 403);
  assert.strictEqual(await send('POST', { Host: `evil.example:${port}`, 'X-Imperium-Request': '1' }), 403);
});

test('a same-origin POST without the door header is refused', async () => {
  assert.strictEqual(await send('POST', { Host: ours(), Origin: ourOrigin(), 'Sec-Fetch-Site': 'same-origin' }), 403);
});

test('reads from our own host pass untouched (Watchdog.vbs, launchers, polling)', async () => {
  assert.strictEqual(await send('GET', { Host: ours() }), 200);
});

test('a local script can still act by sending the header (no Origin, no Sec-Fetch-Site)', async () => {
  assert.strictEqual(await send('POST', { Host: ours(), 'X-Imperium-Request': '1' }), 200);
});

// -- 2. Source: the terminal uses the door, first, and stops sharing replies --
const TERMINAL = fs.readFileSync(path.join(ROOT, 'imperium-terminal.js'), 'utf8');
const strip = s => s.replace(/\/\/.*$/gm, '');

test('the terminal checks the door before its first route', () => {
  const body = strip(TERMINAL.slice(TERMINAL.indexOf('async function handleRequest')));
  const door = body.indexOf('checkDoor(req, PORT)');
  const firstRoute = body.indexOf("req.method === 'GET'");
  assert.ok(door !== -1, 'checkDoor is called in handleRequest');
  assert.ok(door < firstRoute, 'the door comes before any route');
});

test('the terminal no longer tells every site it may read its replies', () => {
  assert.ok(!/Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/.test(strip(TERMINAL)),
    'no Access-Control-Allow-Origin: * left in imperium-terminal.js');
});

// -- 3. Source: every POST the page makes carries the door header ---------
test("every POST in imperium-ui.html sends X-Imperium-Request", () => {
  const UI = fs.readFileSync(path.join(ROOT, 'imperium-ui.html'), 'utf8');
  const posts = [...UI.matchAll(/method:\s*'POST'/g)];
  assert.ok(posts.length >= 4, `found ${posts.length} POST calls; expected at least the 4 known`);
  for (const m of posts) {
    const near = UI.slice(m.index, m.index + 160);
    assert.ok(near.includes("'X-Imperium-Request': '1'"),
      `POST near offset ${m.index} lacks the door header`);
  }
});
