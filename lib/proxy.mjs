// Network proxy, for places where Yahoo, Binance, GitHub and the rest are blocked.
// The desktop app's setting (Data sources → Network proxy) is one of:
//   off     direct connection
//   system  the computer's own proxy settings
//   manual  an HTTP(S) or SOCKS5 proxy, typed as `host:port`, `http://host:port` or `socks5://host:port`
// desktop/proxy.mjs applies it to the app's window (Electron's session) and, with setServerProxy()
// below, to the built-in server's requests and its Yahoo stream (Node's fetch and WebSocket).
// `npm start` takes the proxy from WICKLINE_PROXY (or HTTPS_PROXY / ALL_PROXY) instead.

export const PROXY_MODES = ['off', 'system', 'manual'];
export const DEFAULT_PROXY = Object.freeze({ mode: 'system', server: '' });

const SCHEMES = { http: 'http', https: 'https', socks: 'socks5', socks5: 'socks5', socks5h: 'socks5' };

/**
 * Parses a proxy as typed: `host:port` (an HTTP proxy, like Clash's or v2rayN's), or with a scheme:
 * `http://`, `https://`, `socks5://` (`socks://` and `socks5h://` mean the same). Returns
 * `{ url, scheme, host, port, auth }`, `url` being the normalized form, or `{ error }`.
 */
export function parseProxyServer(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { error: 'Enter the proxy as host:port, e.g. 127.0.0.1:7890.' };
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  const given = m ? m[1].toLowerCase() : 'http';
  const scheme = SCHEMES[given];
  if (!scheme) return { error: `Unsupported proxy type "${given}". Use http://, https:// or socks5://.` };
  let u;
  try {
    u = new URL(`${scheme}://${m ? raw.slice(m[0].length) : raw}`);
  } catch {
    return { error: 'That isn\'t a proxy address. Use host:port, e.g. 127.0.0.1:7890.' };
  }
  if (!u.hostname) return { error: 'The proxy address needs a host.' };
  // A host name, IPv4 or [IPv6] only: `;`, `,` or `=` would add rules of their own to Chromium's proxy setting.
  if (!/^(?:[a-z0-9_.-]+|\[[0-9a-f:.]+\])$/i.test(u.hostname)) return { error: 'That isn\'t a proxy address. Use host:port, e.g. 127.0.0.1:7890.' };
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { error: 'Enter only the proxy\'s host and port, no path.' };
  // `new URL` drops a port that's the scheme's default (80 for http), so read it from the text.
  const portText = /:(\d+)\/?$/.exec(raw)?.[1];
  const port = Number(portText);
  if (!portText || !Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Add the proxy\'s port, e.g. 127.0.0.1:7890.' };
  const auth = Boolean(u.username || u.password);
  const cred = auth ? `${u.username}${u.password ? `:${u.password}` : ''}@` : '';
  return { url: `${scheme}://${cred}${u.hostname}:${port}`, scheme, host: u.hostname, port, auth };
}

/**
 * The saved setting, checked: `{ mode, server }`, plus `error` when a manual proxy can't be used
 * (the app then connects directly). The server text is kept in every mode, for switching back.
 */
export function normalizeProxySettings(input) {
  const mode = PROXY_MODES.includes(input?.mode) ? input.mode : DEFAULT_PROXY.mode;
  const server = typeof input?.server === 'string' ? input.server.trim().slice(0, 300) : '';
  if (mode !== 'manual') return { mode, server };
  const p = parseProxyServer(server);
  if (p.error) return { mode, server, error: p.error };
  // The app's window (Chromium) has no way to send a proxy password without asking for it.
  if (p.auth) return { mode, server, error: 'Proxies that need a password aren\'t supported. Use a local proxy app, or "Use system proxy".' };
  return { mode, server };
}

/** The proxy URL a setting sends the built-in server through, or null for a direct connection. */
export function manualProxyUrl(settings) {
  if (settings?.mode !== 'manual') return null;
  const s = normalizeProxySettings(settings);
  return s.error ? null : parseProxyServer(s.server).url;
}

/** Electron's `session.setProxy()` options for a setting. The app's own local server is never proxied. */
export function chromiumProxyConfig(settings) {
  const s = normalizeProxySettings(settings);
  if (s.mode === 'system') return { mode: 'system' };
  const url = manualProxyUrl(s);
  if (!url) return { mode: 'direct' };
  return { mode: 'fixed_servers', proxyRules: url, proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' };
}

/**
 * The first usable proxy in a PAC-style answer, as Electron's `session.resolveProxy()` gives for the
 * system settings ("PROXY 127.0.0.1:7890; DIRECT"), as a URL; null when that's a direct connection.
 */
export function proxyFromPac(answer) {
  for (const part of String(answer ?? '').split(';')) {
    const [kind, hostPort] = part.trim().split(/\s+/);
    const type = (kind || '').toUpperCase();
    if (type === 'DIRECT') return null;
    const scheme = { PROXY: 'http', HTTP: 'http', HTTPS: 'https', SOCKS5: 'socks5' }[type];
    if (!scheme || !hostPort) continue; // SOCKS (version 4) and QUIC aren't supported here
    const p = parseProxyServer(`${scheme}://${hostPort}`);
    if (!p.error) return p.url;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The built-in server's connections
// ---------------------------------------------------------------------------

let serverProxyUrl = null;
let serverAgent = null;
const listeners = new Set();

/** The proxy the built-in server uses now (a URL), or null for direct. */
export const serverProxy = () => serverProxyUrl;

/** Calls `fn(url)` whenever the server's proxy changes (the Yahoo stream reconnects through it). */
export function onServerProxyChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Sends the server's requests (Node's fetch and WebSocket) through a proxy URL (from
 * parseProxyServer, manualProxyUrl or proxyFromPac), or directly for null. Takes effect for the
 * next request; requests under way finish on the connection they started on. undici is loaded only
 * when a proxy is first set, so the server still runs with no dependencies installed.
 */
export async function setServerProxy(url) {
  url = url || null;
  if (url === serverProxyUrl) return;
  const undici = await import('undici');
  const previous = serverAgent;
  if (!url) serverAgent = new undici.Agent();
  else if (url.startsWith('socks5:')) serverAgent = new undici.Socks5ProxyAgent(url);
  else serverAgent = new undici.ProxyAgent(url);
  undici.setGlobalDispatcher(serverAgent);
  serverProxyUrl = url;
  previous?.close().catch(() => {});
  for (const fn of listeners) {
    try { fn(url); } catch { /* a listener's problem isn't the proxy's */ }
  }
}

/** The proxy `npm start` uses: WICKLINE_PROXY, else the usual HTTPS_PROXY / ALL_PROXY variables. */
export function envProxy(env = process.env) {
  const text = env.WICKLINE_PROXY || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || '';
  if (!text.trim()) return { url: null };
  const p = parseProxyServer(text);
  return p.error ? { url: null, error: p.error, text } : { url: p.url };
}
