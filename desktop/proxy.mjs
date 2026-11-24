// The desktop app's network proxy setting (Data sources → Network proxy), for places where
// Yahoo, Binance, GitHub and the rest are blocked. It is saved in the app's own folder and applies,
// right away, to the window (exchange streams, update check) through Electron's session and to the
// built-in server (Yahoo, news, heatmap, options, community scripts) through lib/proxy.mjs.
// The page reads and changes it through desktop/preload.cjs.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { normalizeProxySettings, chromiumProxyConfig, manualProxyUrl, proxyFromPac, setServerProxy, serverProxy } from '../lib/proxy.mjs';

// What "Use system proxy" is looked up for: the server's requests all go to sites like this one.
const PROBE_URL = 'https://query1.finance.yahoo.com/';
const SYSTEM_RECHECK_MS = 60_000; // the system setting can change while the app runs (a VPN app turned on)
const RESOLVE_TIMEOUT_MS = 3000; // automatic proxy detection can be slow; don't hold up the app for it

const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))]);

/**
 * Loads the saved setting and applies it; registers the page's `proxy:get` / `proxy:set` calls,
 * answered only for the app's own pages. Returns `{ ready }`, settled once the setting is applied.
 */
export function setupProxy({ ses, ipcMain, dir, isAppUrl }) {
  const file = path.join(dir, 'proxy.json');
  let settings = load();
  let timer = null;

  function load() {
    try { return normalizeProxySettings(JSON.parse(readFileSync(file, 'utf8'))); } catch { return normalizeProxySettings(null); }
  }
  function save() {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ mode: settings.mode, server: settings.server }));
    } catch { /* applied for this run anyway */ }
  }

  async function syncServer() {
    let url = manualProxyUrl(settings);
    if (settings.mode === 'system') {
      const answer = await withTimeout(ses.resolveProxy(PROBE_URL).catch(() => ''), RESOLVE_TIMEOUT_MS);
      if (answer === undefined) return; // still detecting: keep what the server has, check again later
      url = proxyFromPac(answer);
    }
    await setServerProxy(url);
  }

  async function apply() {
    clearInterval(timer);
    timer = null;
    await ses.setProxy(chromiumProxyConfig(settings));
    await syncServer().catch((e) => console.error('Proxy:', e));
    if (settings.mode === 'system') {
      timer = setInterval(() => syncServer().catch(() => {}), SYSTEM_RECHECK_MS);
      timer.unref?.();
    }
  }

  const state = () => ({ mode: settings.mode, server: settings.server, active: serverProxy() || 'direct' });
  const fromApp = (e) => isAppUrl(e.senderFrame?.url || '');

  ipcMain.handle('proxy:get', (e) => (fromApp(e) ? state() : null));
  ipcMain.handle('proxy:set', async (e, input) => {
    if (!fromApp(e)) return { ok: false, error: 'Not allowed' };
    const next = normalizeProxySettings(input);
    if (next.error) return { ok: false, error: next.error };
    settings = next;
    save();
    await apply();
    // Open connections (exchange streams too) were made the old way: start them again.
    await ses.closeAllConnections?.();
    return { ok: true, ...state() };
  });

  return { ready: apply() };
}
