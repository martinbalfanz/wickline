// Small local proxies for the tests: an HTTP proxy (CONNECT tunnels and plain requests) and a
// SOCKS5 proxy (no password). Each records the host:port of every connection it makes, in `seen`.
import http from 'node:http';
import net from 'node:net';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function tracked(server) {
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); });
}

function pipeTo(client, host, port, ready) {
  const upstream = net.connect(port, host, ready);
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  return upstream;
}

export async function startHttpProxy() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    seen.push(u.host);
    const up = http.request(u, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', (req, client, head) => {
    seen.push(req.url);
    const i = req.url.lastIndexOf(':');
    const host = req.url.slice(0, i).replace(/^\[|\]$/g, '');
    const upstream = pipeTo(client, host, Number(req.url.slice(i + 1)), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  const close = tracked(server);
  const port = await listen(server);
  return { port, url: `http://127.0.0.1:${port}`, seen, close };
}

export async function startSocks5Proxy() {
  const seen = [];
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let stage = 'hello';
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'hello') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        buf = buf.subarray(2 + buf[1]);
        client.write(Buffer.from([5, 0])); // no authentication
        stage = 'request';
      }
      if (stage !== 'request' || buf.length < 5) return;
      const atyp = buf[3];
      let host, end;
      if (atyp === 1) { end = 8; host = [...buf.subarray(4, 8)].join('.'); }
      else if (atyp === 3) { end = 5 + buf[4]; host = buf.subarray(5, end).toString(); }
      else if (atyp === 4) { end = 20; host = buf.subarray(4, 20).toString('hex').match(/.{4}/g).join(':'); }
      else { client.destroy(); return; }
      if (buf.length < end + 2) return;
      const port = buf.readUInt16BE(end);
      const rest = buf.subarray(end + 2);
      stage = 'open';
      client.off('data', onData);
      seen.push(`${host}:${port}`);
      const upstream = pipeTo(client, host, port, () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) upstream.write(rest);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  const close = tracked(server);
  const port = await listen(server);
  return { port, url: `socks5://127.0.0.1:${port}`, seen, close };
}
