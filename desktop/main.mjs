// Wickline desktop app (Electron).
// Runs the built-in server on this computer — so stocks, ETFs, forex and futures work without
// any key, using the user's own internet connection — and shows the app in its own window.

import { app, BrowserWindow, ipcMain, Menu, session, shell } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { setupProxy } from './proxy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(HERE, '..', 'build', 'icon.png');
const isMac = process.platform === 'darwin';
// A fixed port keeps the page's address the same between launches, so saved charts,
// drawings, scripts and settings (stored by the page) are still there next time.
const PREFERRED_PORT = 41573;
const BG = '#0F0F11';

// Automated check used by developers: starts hidden, records what loaded, saves a screenshot, quits.
const SMOKE = process.env.WICKLINE_SMOKE_TEST === '1';
if (SMOKE) {
  // A fresh profile every run, so the check sees exactly what a new user sees.
  const profile = path.join(os.tmpdir(), 'wickline-smoke-profile');
  rmSync(profile, { recursive: true, force: true });
  app.setPath('userData', profile);
}

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('io.github.wickline.desktop'); // desktop notifications on Windows

let origin = null;
let mainWindow = null;

async function startLocalServer() {
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 20; p++) {
    try {
      const { port } = await startServer({ port: p, host: '127.0.0.1' });
      return `http://127.0.0.1:${port}`;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  const { port } = await startServer({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${port}`;
}

// --- window size and position are remembered ------------------------------------
const statePath = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')); } catch { return {}; }
}
function saveState(win) {
  if (win.isDestroyed()) return;
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch { /* not important */ }
}

// The preload gives the page one thing from the app itself: the network proxy setting.
const webPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(HERE, 'preload.cjs') };

function createMainWindow() {
  const s = loadState();
  const win = new BrowserWindow({
    width: s.width || 1440, height: s.height || 900, x: s.x, y: s.y,
    minWidth: 820, minHeight: 560,
    title: 'Wickline', icon: ICON, backgroundColor: BG, show: false,
    webPreferences,
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!SMOKE) win.show(); });
  for (const ev of ['resize', 'move', 'close']) win.on(ev, () => saveState(win));
  win.loadURL(SMOKE ? `${origin}/#s=YAHOO:AAPL&tf=1D` : `${origin}/`);
  if (SMOKE) runSmokeTest(win);
  return win;
}

/** True for a URL on the app's own local server (compared as origins: `http://127.0.0.1:41573@evil.example/` is not). */
function isAppUrl(url) {
  if (!origin) return false;
  try { return new URL(url).origin === origin; } catch { return false; }
}

// Permissions the page may use, and only on the app's own pages: alert notifications and copying
// a script to the clipboard (Publish). Everything else (camera, microphone, location, …) is refused.
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);
function allowPermission(permission, url) {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(url);
}

// Every window: pop-out charts open as app windows; any other link opens in the system browser.
app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 720, backgroundColor: BG, icon: ICON, webPreferences } };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (origin && !isAppUrl(url)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  // Windows/Linux have no menu bar (Alt+letter menus would steal the drawing shortcuts),
  // so the usual keys for reload, zoom, full screen and developer tools are handled here.
  if (!isMac) {
    contents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const ctrl = input.control || input.meta;
      const key = input.key.toLowerCase();
      const win = BrowserWindow.fromWebContents(contents);
      if (key === 'f5' || (ctrl && key === 'r')) { contents.reload(); e.preventDefault(); }
      else if (key === 'f12' || (ctrl && input.shift && key === 'i')) { contents.toggleDevTools(); e.preventDefault(); }
      else if (key === 'f11' && win) { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
      else if (ctrl && (key === '=' || key === '+')) { contents.setZoomLevel(contents.getZoomLevel() + 0.5); e.preventDefault(); }
      else if (ctrl && key === '-') { contents.setZoomLevel(contents.getZoomLevel() - 0.5); e.preventDefault(); }
      else if (ctrl && key === '0') { contents.setZoomLevel(0); e.preventDefault(); }
    });
  }
});

function buildMenu() {
  if (!isMac) return null;
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

function runSmokeTest(win) {
  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    const lvl = event?.level ?? level;
    const msg = event?.message ?? message;
    if (lvl === 'error' || lvl === 3) errors.push(String(msg).slice(0, 200));
  });
  // Start from a known theme (WICKLINE_SMOKE_THEME=light|dark), then reload and check the page.
  const theme = process.env.WICKLINE_SMOKE_THEME === 'light' ? 'light' : 'dark';
  win.webContents.once('did-finish-load', async () => {
    await win.webContents.executeJavaScript(`localStorage.setItem('wickline.theme', '"${theme}"')`);
    win.webContents.once('did-finish-load', () => collect());
    win.webContents.reload();
  });
  const collect = async () => {
    await new Promise((r) => setTimeout(r, 9000));
    const info = await win.webContents.executeJavaScript(`({
      title: document.title,
      mode: document.body.dataset.mode,
      chart: document.querySelector('.cell .lg-title')?.innerText.replace(/\\n/g, ' '),
      ohlc: document.querySelector('.cell .lg-ohlc')?.innerText.replace(/\\s+/g, ' '),
      chartError: [...document.querySelectorAll('.cell .overlay.error')].filter((e) => !e.hidden).map((e) => e.innerText)[0] || null,
      markets: document.querySelector('#mk-count')?.textContent,
    })`);
    const shot = process.env.WICKLINE_SMOKE_SHOT;
    if (shot) writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
    console.log(`SMOKE ${JSON.stringify({ origin, ...info, errors })}`);
    app.quit();
  };
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => { if (!isMac || SMOKE) app.quit(); });
app.on('activate', () => { if (origin && !BrowserWindow.getAllWindows().length) mainWindow = createMainWindow(); });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());
  try {
    origin = await startLocalServer();
  } catch (e) {
    console.error('Could not start the local server:', e);
    app.quit();
    return;
  }
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowPermission(permission, details?.requestingUrl || contents?.getURL() || ''));
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => (
    allowPermission(permission, requestingOrigin || details?.requestingUrl || contents?.getURL() || '')
  ));
  ses.setDevicePermissionHandler?.(() => false); // no USB, serial or HID devices
  // Network proxy (Data sources), for places where the data sources are blocked: set before anything connects.
  await setupProxy({ ses, ipcMain, dir: app.getPath('userData'), isAppUrl }).ready;
  mainWindow = createMainWindow();
});
