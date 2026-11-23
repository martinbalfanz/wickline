// Tests for server.mjs that need no internet: health check, static files, safety checks.
import assert from 'node:assert/strict';
import { startServer } from '../server.mjs';

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${port}`;
const get = (path) => fetch(base + path);

await test('health check identifies the app', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.app, 'wickline');
  assert.match(j.version, /^\d+\.\d+\.\d+/); // used by the desktop app's update notice
  assert.ok(j.features.includes('yahoo'));
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

await test('serves the app', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /html/);
  assert.match(await r.text(), /<title>Wickline<\/title>/);
});

await test('serves scripts as JavaScript', async () => {
  const r = await get('/js/app.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
});

await test('refuses paths outside the app folder', async () => {
  for (const p of ['/..%2fpackage.json', '/%2e%2e/server.mjs', '/..%5c..%5cpackage.json']) {
    const r = await get(p);
    assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
    assert.doesNotMatch(await r.text(), /"name":\s*"wickline"|startServer/);
  }
});

await test('unknown files are 404', async () => {
  assert.equal((await get('/nope.js')).status, 404);
});

await test('a badly encoded path is a 400, and the server keeps running', async () => {
  for (const p of ['/%E0', '/%', '/js/%E0%A4%A.js']) {
    const r = await get(p);
    assert.equal(r.status, 400, p);
    assert.equal((await r.json()).error, 'Bad path');
  }
  // A Host header that isn't a host name can't stop it either.
  const { request } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { host: 'not a host' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
  assert.equal((await get('/api/health')).status, 200);
});

await test('chart API wants a symbol', async () => {
  const r = await get('/api/yahoo/chart?tf=1D');
  assert.equal(r.status, 400);
});

await test('options API checks its input, and says when a symbol has no options', async () => {
  for (const [q, error] of [['', 'bad symbol'], ['symbol=YAHOO%3A%3Cb%3E', 'bad symbol'], ['symbol=YAHOO%3ASPY&expiry=soon', 'bad expiry'],
    ['symbol=OANDA%3AEURUSD', 'unknown source']]) {
    const r = await get(`/api/options?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal((await r.json()).error, error, q);
  }
  // A coin without options is answered without asking anyone.
  const r = await get('/api/options?symbol=BINANCE%3ADOGEUSDT');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const j = await r.json();
  assert.equal(j.symbol, 'BINANCE:DOGEUSDT');
  assert.match(j.none, /Bitcoin and Ether only/);
});

await test('the script worker may not use the network', async () => {
  const r = await get('/js/script-worker.js');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' 'unsafe-eval'/);
  assert.doesNotMatch(csp, /connect-src/); // falls back to default-src 'none'
  assert.equal((await get('/js/app.js')).headers.get('content-security-policy'), null);
});

await test('community library: index, scripts as plain text, nothing else', async () => {
  process.env.WICKLINE_COMMUNITY = 'local';
  const r = await get('/api/community/index.json');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.scripts.length > 10, `${j.scripts.length} scripts`);
  const s = await get(`/api/community/${j.scripts[0].file}`);
  assert.equal(s.status, 200);
  assert.match(s.headers.get('content-type'), /text\/plain/);
  assert.equal(s.headers.get('x-content-type-options'), 'nosniff');
  for (const p of ['/api/community/README.md', '/api/community/..%2f..%2fpackage.json', '/api/community/scripts/nope.js']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
