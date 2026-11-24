// Tests for lib/proxy.mjs: reading the proxy setting, and the built-in server's requests and
// WebSocket going through local HTTP and SOCKS5 proxies (no internet needed).
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  parseProxyServer, normalizeProxySettings, manualProxyUrl, chromiumProxyConfig, proxyFromPac, envProxy,
  setServerProxy, serverProxy, onServerProxyChange,
} from '../lib/proxy.mjs';
import { startHttpProxy, startSocks5Proxy } from './proxy-servers.mjs';

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

await test('reads host:port as an HTTP proxy', () => {
  assert.deepEqual(parseProxyServer(' 127.0.0.1:7890 '), { url: 'http://127.0.0.1:7890', scheme: 'http', host: '127.0.0.1', port: 7890, auth: false });
  assert.equal(parseProxyServer('proxy.example.com:8080').url, 'http://proxy.example.com:8080');
  assert.equal(parseProxyServer('http://127.0.0.1:80').url, 'http://127.0.0.1:80'); // the scheme's default port is kept
  assert.equal(parseProxyServer('HTTP://Proxy.Example.com:3128/').url, 'http://proxy.example.com:3128');
  assert.equal(parseProxyServer('https://secure.example.com:443').url, 'https://secure.example.com:443');
  assert.equal(parseProxyServer('[::1]:7890').url, 'http://[::1]:7890');
});

await test('reads SOCKS5 in its usual spellings', () => {
  assert.equal(parseProxyServer('socks5://127.0.0.1:1080').url, 'socks5://127.0.0.1:1080');
  assert.equal(parseProxyServer('socks://127.0.0.1:1080').url, 'socks5://127.0.0.1:1080');
  assert.equal(parseProxyServer('SOCKS5H://localhost:7891').url, 'socks5://localhost:7891');
});

await test('says what is wrong with a bad proxy', () => {
  assert.match(parseProxyServer('').error, /host:port/);
  assert.match(parseProxyServer('127.0.0.1').error, /port/);
  assert.match(parseProxyServer('127.0.0.1:0').error, /port/);
  assert.match(parseProxyServer('127.0.0.1:70000').error, /./);
  assert.match(parseProxyServer('ftp://127.0.0.1:21').error, /Unsupported/);
  assert.match(parseProxyServer('socks4://127.0.0.1:1080').error, /Unsupported/);
  assert.match(parseProxyServer('http://127.0.0.1:8080/path').error, /no path/);
  assert.match(parseProxyServer('not a host:12').error, /./);
});

await test('keeps a password in the URL for the server, but the app refuses it', () => {
  const p = parseProxyServer('http://me:secret@proxy.example.com:8080');
  assert.equal(p.url, 'http://me:secret@proxy.example.com:8080');
  assert.equal(p.auth, true);
  assert.match(normalizeProxySettings({ mode: 'manual', server: 'me:secret@proxy.example.com:8080' }).error, /password/);
});

await test('normalizes the saved setting', () => {
  assert.deepEqual(normalizeProxySettings(undefined), { mode: 'system', server: '' });
  assert.deepEqual(normalizeProxySettings({ mode: 'bogus', server: 5 }), { mode: 'system', server: '' });
  assert.deepEqual(normalizeProxySettings({ mode: 'off', server: ' 127.0.0.1:7890 ' }), { mode: 'off', server: '127.0.0.1:7890' });
  assert.deepEqual(normalizeProxySettings({ mode: 'manual', server: '127.0.0.1:7890' }), { mode: 'manual', server: '127.0.0.1:7890' });
  assert.match(normalizeProxySettings({ mode: 'manual', server: '' }).error, /host:port/);
  assert.equal(normalizeProxySettings({ mode: 'off', server: 'garbage' }).error, undefined); // only checked when used
});

await test('gives Electron the matching proxy rules', () => {
  assert.deepEqual(chromiumProxyConfig({ mode: 'off' }), { mode: 'direct' });
  assert.deepEqual(chromiumProxyConfig({ mode: 'system' }), { mode: 'system' });
  const fixed = chromiumProxyConfig({ mode: 'manual', server: 'socks5://127.0.0.1:1080' });
  assert.equal(fixed.mode, 'fixed_servers');
  assert.equal(fixed.proxyRules, 'socks5://127.0.0.1:1080');
  assert.match(fixed.proxyBypassRules, /127\.0\.0\.1/); // the app's own server stays direct
  assert.deepEqual(chromiumProxyConfig({ mode: 'manual', server: 'bad' }), { mode: 'direct' });
  assert.equal(manualProxyUrl({ mode: 'manual', server: '127.0.0.1:7890' }), 'http://127.0.0.1:7890');
  assert.equal(manualProxyUrl({ mode: 'system', server: '127.0.0.1:7890' }), null);
});

await test('reads the system proxy from a PAC answer', () => {
  assert.equal(proxyFromPac('PROXY 127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(proxyFromPac('PROXY 127.0.0.1:7890; DIRECT'), 'http://127.0.0.1:7890');
  assert.equal(proxyFromPac('HTTPS proxy.example.com:443'), 'https://proxy.example.com:443');
  assert.equal(proxyFromPac('SOCKS5 127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.equal(proxyFromPac('SOCKS 127.0.0.1:1080; PROXY 10.0.0.1:3128'), 'http://10.0.0.1:3128'); // SOCKS4 skipped
  assert.equal(proxyFromPac('DIRECT'), null);
  assert.equal(proxyFromPac('DIRECT; PROXY 127.0.0.1:7890'), null);
  assert.equal(proxyFromPac(''), null);
});

await test('npm start reads WICKLINE_PROXY, then HTTPS_PROXY / ALL_PROXY', () => {
  assert.deepEqual(envProxy({}), { url: null });
  assert.equal(envProxy({ HTTPS_PROXY: 'http://127.0.0.1:7890' }).url, 'http://127.0.0.1:7890');
  assert.equal(envProxy({ all_proxy: 'socks5://127.0.0.1:1080' }).url, 'socks5://127.0.0.1:1080');
  assert.equal(envProxy({ WICKLINE_PROXY: '127.0.0.1:1', HTTPS_PROXY: 'http://other:2' }).url, 'http://127.0.0.1:1');
  assert.match(envProxy({ WICKLINE_PROXY: 'nonsense' }).error, /port/);
});

// --- the server's own connections, through real (local) proxies ----------------------------

// A target with a page and a WebSocket that says "hi".
const target = http.createServer((req, res) => { res.end('hello'); });
const upgraded = new Set();
target.on('upgrade', (req, socket) => {
  upgraded.add(socket);
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.write(Buffer.from([0x81, 2, 0x68, 0x69])); // text frame "hi"
  socket.on('error', () => {});
});
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const where = `127.0.0.1:${target.address().port}`;

const get = async () => (await fetch(`http://${where}/`, { signal: AbortSignal.timeout(5000) })).text();
const wsHello = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://${where}/`);
  const t = setTimeout(() => { ws.close(); reject(new Error('no WebSocket message')); }, 5000);
  ws.onmessage = (e) => { clearTimeout(t); ws.close(); resolve(String(e.data)); };
  ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket failed')); };
});

const httpProxy = await startHttpProxy();
const socksProxy = await startSocks5Proxy();
const changes = [];
onServerProxyChange((url) => changes.push(url));

await test('the server connects directly by default', async () => {
  assert.equal(serverProxy(), null);
  assert.equal(await get(), 'hello');
  assert.deepEqual(httpProxy.seen, []);
});

await test('fetch and WebSocket go through an HTTP proxy', async () => {
  await setServerProxy(httpProxy.url);
  assert.equal(serverProxy(), httpProxy.url);
  assert.equal(await get(), 'hello');
  assert.equal(await wsHello(), 'hi');
  assert.ok(httpProxy.seen.filter((h) => h === where).length >= 2, httpProxy.seen.join());
});

await test('fetch and WebSocket go through a SOCKS5 proxy', async () => {
  const before = httpProxy.seen.length;
  await setServerProxy(socksProxy.url);
  assert.equal(await get(), 'hello');
  assert.equal(await wsHello(), 'hi');
  assert.ok(socksProxy.seen.filter((h) => h === where).length >= 2, socksProxy.seen.join());
  assert.equal(httpProxy.seen.length, before);
});

await test('turning the proxy off goes direct again, and listeners hear each change', async () => {
  const before = socksProxy.seen.length;
  await setServerProxy(null);
  assert.equal(await get(), 'hello');
  assert.equal(socksProxy.seen.length, before);
  assert.deepEqual(changes, [httpProxy.url, socksProxy.url, null]);
});

await httpProxy.close();
await socksProxy.close();
target.closeAllConnections();
for (const s of upgraded) s.destroy();
target.close();

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
