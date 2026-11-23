// End-to-end check of the real app in Electron, with live data (needs internet).
// Run: npm run test:e2e
// Opens the app with its built-in server in a hidden window and checks charts for several
// markets, the theme dialog, the Ext button, multi-chart layouts and console errors.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { startServer } from '../server.mjs';

const profile = path.join(os.tmpdir(), 'wickline-e2e-profile');
rmSync(profile, { recursive: true, force: true });
app.setPath('userData', profile);

const CHARTS = [
  ['YAHOO:AAPL', '1D'], ['YAHOO:NVDA', '5m'], ['YAHOO:SPY', '1h'], ['YAHOO:^GSPC', '1W'],
  ['YAHOO:EURUSD=X', '15m'], ['YAHOO:GC=F', '1D'], ['YAHOO:SAP.DE', '1D'],
  ['BINANCE:BTCUSDT', '1m'], ['BINANCEF:ETHUSDT', '4h'], ['COINBASE:BTC-USD', '1D'],
];

let failed = 0;
const results = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  results.push(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  console.log(results.at(-1));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  const win = new BrowserWindow({ width: 1400, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    const lvl = e?.level ?? level, msg = String(e?.message ?? message);
    // Dropped network connections (e.g. a live stream closed on navigation) aren't app errors.
    if ((lvl === 'error' || lvl === 3) && !/Failed to load resource|ERR_CONNECTION|ERR_ABORTED/.test(msg)) errors.push(msg.slice(0, 200));
  });
  const run = (js) => win.webContents.executeJavaScript(js);
  let page = 0;
  const open = async (sym, tf) => {
    // A new query string forces a fresh page (a different #hash alone wouldn't reload it).
    // ?e2e exposes the charts to this test as window.__wickline.
    await win.loadURL(`http://127.0.0.1:${port}/?e2e&page=${++page}#s=${encodeURIComponent(sym)}&tf=${tf}`);
    for (let i = 0; i < 40; i++) {
      await wait(500);
      const done = await run(`(() => { const c = document.querySelector('.cell'); if (!c) return false;
        if (!c.querySelector('.overlay.error').hidden) return true;
        return !!c.querySelector('.lg-ohlc')?.innerText.trim() && /\\d/.test(document.title); })()`);
      if (done) break;
    }
    return run(`(() => { const c = document.querySelector('.cell');
      return { legend: c.querySelector('.lg-ohlc')?.innerText.replace(/\\s+/g, ' ').trim(),
        title: c.querySelector('.lg-title')?.innerText.replace(/\\s+/g, ' ').trim(),
        error: c.querySelector('.overlay.error').hidden ? null : c.querySelector('.overlay.error').innerText.replace(/\\s+/g, ' ').slice(0, 120),
        mode: document.body.dataset.mode, tabTitle: document.title }; })()`);
  };

  try {
    // 1. Charts for every kind of market and several timeframes.
    for (const [sym, tf] of CHARTS) {
      const r = await open(sym, tf);
      // The chart must be the one asked for, not a leftover from the previous page.
      const want = sym.split(':')[1].replace(/=X|=F|-USD|\.DE|\^/g, '').replace(/[^A-Z]/g, '').slice(0, 4);
      const titled = (r.title || '').toUpperCase().replace(/[^A-Z]/g, '').includes(want);
      check(`${sym} ${tf} loads`, !r.error && titled && /^O\S+ H\S+ L\S+ C\S+/.test(r.legend || ''),
        r.error || `${(r.title || '').slice(0, 36)} | ${(r.legend || '').slice(0, 44)}`);
    }
    const first = await open('YAHOO:AAPL', '1D');
    check('desktop data mode uses the built-in server', first.mode === 'server', first.mode);
    check('tab title shows symbol and price', /^AAPL [\d,.]+ [▲▼]/.test(first.tabTitle), first.tabTitle);
    // The Twelve Data key is only for the static website; the desktop app shouldn't ask for one.
    await run(`document.querySelector('#settings-btn').click()`);
    await wait(300);
    const dlg = await run(`({ key: document.querySelector('#set-td-key').offsetParent !== null, text: document.querySelector('#set-mode').innerText })`);
    check('Data sources asks for no API key in the desktop app', !dlg.key && /no API key/.test(dlg.text), dlg.text.split('.')[0]);
    await run(`document.querySelector('#settings-modal .close').click()`);

    // 2. Markets panel lists all US stocks.
    await run(`document.querySelector('.side-tabs [data-tab="markets"], .side-tabs button:nth-child(2)')?.click()`);
    await wait(3000);
    const count = await run(`document.querySelector('#mk-count')?.textContent || ''`);
    check('Markets panel lists thousands of US stocks', Number(count.replace(/\D/g, '')) > 5000, count);

    // 3. Theme dialog: presets and custom colors change the page.
    const accent = () => run(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
    const before = await accent();
    await run(`document.querySelector('#appearance-btn').click(); document.querySelector('[data-preset="ember"]').click()`);
    await wait(500);
    check('choosing a preset changes the colors', (await accent()) !== before && (await accent()).toUpperCase() === '#F2A33A', await accent());
    await run(`(() => { const i = document.querySelector('[data-key="accent"]'); i.value = '#123456';
      i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(500);
    check('a custom accent color applies', (await accent()).toUpperCase() === '#123456', await accent());
    await run(`document.querySelector('#appear-reset').click(); document.querySelector('[data-preset="crimson"]').click(); document.querySelector('.appear-done').click()`);
    await wait(300);
    check('reset returns to the default theme', (await accent()).toUpperCase() === '#E5484D', await accent());

    // 4. Ext button: only for stocks on intraday charts.
    const extHidden = () => run(`document.querySelector('#ext-btn').hidden`);
    await open('YAHOO:AAPL', '5m');
    check('Ext button shows on an intraday stock chart', (await extHidden()) === false);
    await open('YAHOO:AAPL', '1D');
    check('Ext button hides on a daily chart', (await extHidden()) === true);
    await open('BINANCE:BTCUSDT', '5m');
    check('Ext button hides for crypto', (await extHidden()) === true);

    // 5. After the user drags the price axis (which turns auto-scaling off), the next symbol still
    //    opens on its latest bars with its prices in view, not into empty space.
    await open('YAHOO:AAPL', '1h');
    const box = await run(`(() => { const r = window.__wickline.views()[0].chartEl.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    const ax = box.x + box.w - 25;
    mouse('mouseDown', ax, box.y + box.h * 0.3);
    for (let s = 1; s <= 12; s++) { mouse('mouseMove', ax, box.y + box.h * (0.3 + 0.025 * s)); await wait(16); }
    mouse('mouseUp', ax, box.y + box.h * 0.6);
    await wait(500);
    const dragged = await run(`window.__wickline.views()[0].main.priceScale().options().autoScale`);
    check('dragging the price axis turns auto-scaling off (test setup)', dragged === false);
    await run(`window.__wickline.views()[0].setSymbol('BINANCE:BTCUSDT')`);
    for (let i = 0; i < 40; i++) { // until BTC's data is on the chart
      await wait(500);
      if (await run(`(() => { const v = window.__wickline.views()[0]; return !!v.feed && v.q('.overlay.loading').hidden && v.bars.at(-1)?.close > 1000; })()`)) break;
    }
    await wait(800);
    const view = await run(`(() => { const v = window.__wickline.views()[0]; const n = v.bars.length;
      const lr = v.chart.timeScale().getVisibleLogicalRange(); const last = v.bars[n - 1];
      const top = v.main.coordinateToPrice(5), bot = v.main.coordinateToPrice(v.chartEl.clientHeight * 0.5);
      return { n, to: lr.to, last: last.close, top, bot, auto: v.main.priceScale().options().autoScale }; })()`);
    check('a new symbol opens on its latest bars', view.to >= view.n - 1 && view.to <= view.n + 15, `view ends at ${Math.round(view.to)} of ${view.n}`);
    check('a new symbol opens with its prices in view', view.auto && view.last <= view.top && view.last >= Math.min(view.bot, view.top) - Math.abs(view.top) * 0.5,
      `last ${view.last} scale ${Math.round(view.bot)}..${Math.round(view.top)}`);

    // 5b. Repeatedly switch between long-history stocks in the SAME chart cell.
    // The actual newest candle must be visible near the right edge, irrespective of
    // the prior ticker's history length or the previous zoom/scroll position.
    await open('YAHOO:AAPL', '1D');
    for (const symbol of ['YAHOO:NVDA', 'YAHOO:LLY', 'YAHOO:AAPL', 'YAHOO:NVDA']) {
      await run(`window.__wickline.views()[0].setSymbol(${JSON.stringify(symbol)})`);
      for (let i = 0; i < 60; i++) {
        await wait(250);
        const loaded = await run(`(() => {
          const v = window.__wickline.views()[0];
          return v.state.symbol === ${JSON.stringify(symbol)} &&
            v.feed && v.q('.overlay.loading').hidden && v.bars.length > 250;
        })()`);
        if (loaded) break;
      }
      await wait(150); // allow autosize and the next-frame viewport correction
      const position = await run(`(() => {
        const v = window.__wickline.views()[0], ts = v.chart.timeScale();
        const last = v.bars.at(-1);
        return { width: ts.width(), x: last ? ts.timeToCoordinate(last.time) : null,
          n: v.bars.length, range: ts.getVisibleLogicalRange(),
          error: v.q('.overlay.error').hidden ? null : v.q('.overlay.error').innerText };
      })()`);
      const good = position.width > 0 && Number.isFinite(position.x) &&
        position.x >= position.width * 0.6 && position.x < position.width;
      check(`switch to ${symbol} keeps the newest candle visible`, good,
        `last candle x=${Math.round(position.x)} / width=${Math.round(position.width)}, bars=${position.n}; ${position.error || ''}`);
    }

    // 6. Update notice: a newer release on GitHub (faked here) shows a notice that can be dismissed.
    await win.loadURL(`http://127.0.0.1:${port}/?e2e&page=${++page}`);
    await run(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).includes('api.github.com')
      ? Promise.resolve(new Response(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/keptaduona/wickline/releases/tag/v99.0.0', draft: false, prerelease: false }), { status: 200 }))
      : real(u, o); })()`);
    await wait(7000);
    const upd = await run(`({ hidden: document.querySelector('#update').hidden, text: document.querySelector('#update-link').textContent, href: document.querySelector('#update-link').href })`);
    check('update notice shows a newer release', !upd.hidden && /99\.0\.0/.test(upd.text) && /releases\/tag\/v99/.test(upd.href), upd.text);
    await run(`document.querySelector('#update-dismiss').click()`);
    check('dismissing hides the notice', (await run(`document.querySelector('#update').hidden`)) === true);

    // 7. A 4-chart layout renders every chart.
    await run(`document.querySelector('#layout-btn').click(); document.querySelector('[data-layout="4"]').click()`);
    await wait(8000);
    const legends = await run(`[...document.querySelectorAll('.cell .lg-ohlc')].map((e) => e.innerText.trim()).filter(Boolean).length`);
    check('4-chart layout shows 4 charts with data', legends === 4, `${legends} of 4`);

    // 8. Sync across charts (Layout menu): symbol and timeframe, in the layout and in pop-outs.
    const symbols = () => run(`window.__wickline.views().map((v) => v.state.symbol)`);
    const tfs = () => run(`window.__wickline.views().map((v) => v.state.tf)`);
    const active = (js) => run(`(() => { const v = window.__wickline.views().find((x) => x.el.classList.contains('active')); ${js} })()`);
    const toggleSync = async (kind) => {
      await run(`document.querySelector('#layout-btn').click()`);
      await wait(200);
      await run(`document.querySelector('[data-sync="${kind}"]').click(); document.querySelector('#layout-btn').click()`);
      await wait(500);
    };
    check('charts start with their own symbols', new Set(await symbols()).size > 1, (await symbols()).join(', '));
    const pop = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { backgroundThrottling: false } });
    await pop.loadURL(`http://127.0.0.1:${port}/?popout=1&e2e#s=${encodeURIComponent('YAHOO:MSFT')}&tf=1D`);
    await wait(2500);
    const popSymbol = () => pop.webContents.executeJavaScript(`window.__wickline.views()[0].state.symbol`);
    await toggleSync('symbol');
    const activeSym = await active('return v.state.symbol;');
    const all = await symbols();
    check('turning symbol sync on puts every chart on the active symbol', all.every((s) => s === activeSym), all.join(', '));
    await active(`v.setSymbol('YAHOO:NVDA');`);
    await wait(1500);
    const afterChange = await symbols();
    check('a new symbol on the active chart goes to every chart', afterChange.every((s) => s === 'YAHOO:NVDA'), afterChange.join(', '));
    check('...and to pop-out windows', (await popSymbol()) === 'YAHOO:NVDA', await popSymbol());
    await pop.webContents.executeJavaScript(`window.__wickline.views()[0].setSymbol('BINANCE:ETHUSDT')`);
    await wait(1500);
    check('a pop-out window can lead too', (await symbols()).every((s) => s === 'BINANCE:ETHUSDT'), (await symbols()).join(', '));
    await toggleSync('interval');
    await active(`v.setTimeframe('15m');`);
    await wait(1500);
    check('timeframe sync changes every chart', (await tfs()).every((t) => t === '15m'), (await tfs()).join(', '));
    check('the Layout button shows that charts are synced', await run(`!!document.querySelector('#layout-btn .sync-dot')`));
    await toggleSync('symbol');
    await toggleSync('interval');
    await active(`v.setSymbol('YAHOO:AAPL'); v.setTimeframe('1D');`);
    await wait(1500);
    const sOff = await symbols(), tOff = await tfs();
    check('with sync off, only the active chart changes', sOff.filter((s) => s === 'YAHOO:AAPL').length === 1 && tOff.filter((t) => t === '1D').length === 1,
      `${sOff.join(', ')} | ${tOff.join(', ')}`);
    pop.destroy();

    // 9. Screener: scans US stocks, ideas sort and filter, a row opens its chart.
    await run(`document.querySelector('#layout-btn').click(); document.querySelector('[data-layout="1"]').click()`);
    await wait(1500);
    await run(`document.querySelector('#sc-btn').click()`);
    for (let i = 0; i < 60; i++) { await wait(500); if (await run(`!!document.querySelector('.sc-table tbody tr')`)) break; }
    const scInfo = await run(`({ rows: document.querySelectorAll('.sc-table tbody tr').length, insights: document.querySelector('.sc-insights')?.innerText || '' })`);
    check('screener loads stocks with market insights', scInfo.rows > 10 && /up/.test(scInfo.insights) && /down/.test(scInfo.insights), `${scInfo.rows} rows`);
    await run(`document.querySelector('[data-idea="gainers"]').click()`);
    await wait(300);
    const gains = await run(`[...document.querySelectorAll('.sc-table tbody tr')].slice(0, 15).map((r) => parseFloat(r.children[2].textContent.replace('−', '-')))`);
    check('"Top gainers" lists rising stocks, biggest first', gains.length > 0 && gains.every((g, k) => g > 0 && (k === 0 || g <= gains[k - 1])), gains.slice(0, 5).join(', '));
    const scSym = await run(`(() => { const tr = document.querySelector('.sc-table tbody tr[data-row="1"]'); tr.click(); return tr.querySelector('.sc-sym b').textContent; })()`);
    await wait(3000);
    const scChart = await run(`document.querySelector('.cell .lg-title').innerText`);
    check('clicking a screener row opens that stock', scChart.startsWith(scSym + ' '), `${scSym} -> ${scChart.split('\n')[0]}`);
    await run(`document.querySelector('#sc-close').click()`);

    // 10. Symbol search: one box for every source, and each result says where its data comes from.
    const search = async (q) => {
      await run(`(() => { const i = document.querySelector('#search-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
      await wait(2500);
      return run(`[...document.querySelectorAll('#search-results .sr-row')].map((r) => ({ t: r.querySelector('.sr-ticker').textContent, src: r.querySelector('.sr-badge')?.textContent }))`);
    };
    await run(`document.querySelector('#symbol-btn').click()`);
    await wait(300);
    check('search has no category selector', !(await run(`!!document.querySelector('#search-tabs')`)));
    const aapl = await search('AAPL');
    check('search puts the exact ticker first', aapl[0]?.t === 'AAPL' && aapl[0]?.src === 'Yahoo', JSON.stringify(aapl.slice(0, 3)));
    const btc = await search('BTC');
    const sources = new Set(btc.map((r) => r.src));
    check('one search covers stocks and crypto exchanges, each row labeled', btc.every((r) => r.src) && sources.has('Yahoo') && sources.has('Binance'), [...sources].join(', '));
    await run(`document.querySelector('#search-modal .close').click()`);

    // 11. News: ranked live headlines with tickers, news for the chart's symbol, economic calendar, earnings.
    await run(`document.querySelector('#nw-btn').click()`);
    for (let i = 0; i < 60; i++) { await wait(500); if (await run(`!!document.querySelector('.nw-row') && !!document.querySelector('.nw-table')`)) break; }
    const nw = await run(`({ rows: document.querySelectorAll('.nw-row').length, hot: document.querySelectorAll('.nw-row.hot').length,
      chips: document.querySelectorAll('.nw-list .nw-tk').length, days: document.querySelectorAll('.nw-cal .nw-day').length })`);
    check('news shows ranked headlines, the hottest flagged', nw.rows > 20 && nw.hot > 0 && nw.hot <= 10, JSON.stringify(nw));
    check('headlines are tagged with tickers', nw.chips > 5, `${nw.chips} chips`);
    check('the economic calendar is grouped by day', nw.days > 0, `${nw.days} days`);
    const tk = await run(`(() => { const b = [...document.querySelectorAll('.nw-list .nw-tk')].find((x) => x.dataset.full.startsWith('YAHOO:')); b.click(); return b.dataset.full; })()`);
    await wait(3000);
    const tkChart = await run(`document.querySelector('.cell .lg-title').innerText`);
    check('clicking a ticker opens its chart', tkChart.startsWith(`${tk.replace('YAHOO:', '')} `), `${tk} -> ${tkChart.split('\n')[0]}`);
    await run(`document.querySelector('[data-view="symbol"]').click()`);
    for (let i = 0; i < 30; i++) { await wait(500); if (await run(`document.querySelectorAll('.nw-row').length > 0`)) break; }
    const symTab = await run(`document.querySelector('[data-view="symbol"]').textContent`);
    check('the symbol tab shows news about the active chart', symTab === tk.replace('YAHOO:', '') && (await run(`document.querySelectorAll('.nw-row').length`)) > 0, symTab);
    await run(`document.querySelector('[data-view="top"]').click(); document.querySelector('[data-cal="earnings"]').click()`);
    await wait(500);
    check('the earnings calendar lists companies', (await run(`document.querySelectorAll('.nw-er').length`)) > 0);
    // Other countries: every country's releases and earnings outside the US, picked in the calendar.
    await run(`document.querySelector('[data-cal="econ"]').click(); document.querySelector('.nw-pick').click()`);
    await wait(300);
    await run(`document.querySelector('[data-ccset="all"]').click()`);
    await wait(300);
    const cc = await run(`[...new Set([...document.querySelectorAll('.nw-cal tbody .nw-cc')].map((x) => x.textContent))]`);
    check('the economic calendar covers other countries', cc.length >= 5 && cc.includes('US') && cc.includes('UK'), cc.join(' '));
    await run(`document.querySelector('[data-cal="earnings"]').click(); const s = document.querySelector('select[data-f="minCap"]'); s.value = '1000000000'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
    await wait(300);
    const ecc = await run(`[...new Set([...document.querySelectorAll('.nw-cal tbody .nw-cc')].map((x) => x.textContent))]`);
    check('earnings include stock markets outside the US', ecc.some((c) => c !== 'US'), ecc.join(' '));
    await run(`document.querySelector('[data-ccset="us"]').click()`);
    await wait(300);
    const usOnly = await run(`[...new Set([...document.querySelectorAll('.nw-cal tbody .nw-cc')].map((x) => x.textContent))]`);
    check('"US only" narrows the calendar to the US', usOnly.length === 1 && usOnly[0] === 'US', usOnly.join(' '));
    await run(`document.querySelector('[data-ccset="major"]').click(); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await wait(300);
    check('clicking outside closes the country list', !(await run(`!!document.querySelector('.nw-pop')`)));
    await run(`(() => { const s = document.querySelector('select[data-f="region"]'); s.value = 'gb'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (let i = 0; i < 60; i++) { await wait(500); if (await run(`!!document.querySelector('.nw-feed .nw-row')`)) break; }
    const gb = await run(`({ rows: document.querySelectorAll('.nw-feed .nw-row').length, sources: [...new Set([...document.querySelectorAll('.nw-src')].map((x) => x.textContent))].slice(0, 6),
      local: [...document.querySelectorAll('.nw-list .nw-tk')].filter((b) => b.dataset.full.endsWith('.L')).length })`);
    check('news for another region shows its own outlets and companies', gb.rows > 10 && gb.local > 0 && !gb.sources.includes('Benzinga'), JSON.stringify(gb));
    await run(`(() => { const s = document.querySelector('select[data-f="region"]'); s.value = 'us'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await run(`document.querySelector('[data-cal="econ"]').click(); document.querySelector('#nw-close').click()`);

    // 12. Bar replay and paper trading (on a chart with plenty of history).
    await run(`window.__wickline.views()[0].setSymbol('BINANCE:BTCUSDT')`);
    for (let i = 0; i < 20; i++) { await wait(500); if (await run(`(() => { const v = window.__wickline.views()[0]; return v.state.symbol === 'BINANCE:BTCUSDT' && !!v.feed && v.bars.length > 100; })()`)) break; }
    const activeChart = `window.__wickline.views().find((x) => x.el.classList.contains('active')) || window.__wickline.views()[0]`;
    await run(`document.querySelector('#rp-btn').click()`);
    await wait(300);
    check('Replay asks where to start', await run(`!(${activeChart}).q('.rp-banner').hidden`));
    await run(`(${activeChart}).q('[data-rp="random"]').click()`);
    await wait(600);
    const rp = await run(`(() => { const v = ${activeChart}; return v.replay && { n: v.bars.length, all: v.replay.all.length, status: document.querySelector('#status-text').textContent, title: document.title }; })()`);
    check('a replay hides the candles after its start', !!rp && rp.n < rp.all && /^Replay/.test(rp.title), JSON.stringify(rp));
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))`);
    await wait(300);
    check('Shift+→ shows the next candle', (await run(`(${activeChart}).bars.length`)) === rp?.n + 1);
    await run(`document.querySelector('#tr-btn').click()`);
    await wait(400);
    const liveBefore = await run(`localStorage.getItem('wickline.paper')`);
    await run(`(${activeChart}).q('.qt [data-qt="buy"]').click()`);
    await wait(400);
    const practice = await run(`(() => { const v = ${activeChart}; return { pos: Object.keys(v.replayAccount?.positions || {}).length,
      badge: !!document.querySelector('#tr-account .tr-badge'), lines: v.paperLines.size }; })()`);
    check('buying in a replay opens a position in the practice account', practice.pos === 1 && practice.badge && practice.lines >= 1, JSON.stringify(practice));
    check('...and leaves the paper account alone', (await run(`localStorage.getItem('wickline.paper')`)) === liveBefore);
    await run(`(() => { const v = ${activeChart}; v.setReplaySpeed(10); v.playReplay(); })()`);
    await wait(1500);
    const played = await run(`(() => { const v = ${activeChart}; v.pauseReplay(); return v.bars.length; })()`);
    check('Play moves the replay forward', played > rp.n + 3, `${rp.n} -> ${played} candles`);
    await run(`(${activeChart}).q('.replay-bar [data-rp="exit"]').click()`);
    for (let i = 0; i < 20; i++) { await wait(500); if (await run(`!(${activeChart}).replay && !!(${activeChart}).feed`)) break; }
    const exited = await run(`({ replay: !!(${activeChart}).replay, toast: document.querySelector('#toast').innerText, title: document.title })`);
    check('Exit replay goes back to live data, with a summary', !exited.replay && /Replay finished/.test(exited.toast) && !/^Replay/.test(exited.title), JSON.stringify(exited));
    await run(`(${activeChart}).q('.qt [data-qt="buy"]').click()`);
    await wait(500);
    const paper = await run(`(() => { const a = JSON.parse(localStorage.getItem('wickline.paper') || '{}'); return { pos: Object.keys(a.positions || {}).length,
      lines: (${activeChart}).paperLines.size, row: !!document.querySelector('#tr-content [data-tr="close"]') }; })()`);
    check('a live paper trade opens a saved position with a line on the chart', paper.pos === 1 && paper.lines >= 1 && paper.row, JSON.stringify(paper));
    await run(`document.querySelector('#tr-content [data-tr="close"]').click()`);
    await wait(400);
    const closedTrades = await run(`JSON.parse(localStorage.getItem('wickline.paper')).trades.length`);
    check('closing it records the trade', closedTrades === 1, `${closedTrades} trades`);
    await run(`document.querySelector('#tr-close').click()`);
    // 13. Stock heatmap.
    await run(`document.querySelector('#hm-btn').click()`);
    for (let i = 0; i < 60; i++) { await wait(500); if (await run(`document.querySelectorAll('.hm-tile').length > 100`)) break; }
    const hm = await run(`({ tiles: document.querySelectorAll('.hm-tile').length, sectors: document.querySelectorAll('.hm-sector').length,
      colored: [...document.querySelectorAll('.hm-tile')].filter((t) => /rgb\\((?!46, 48, 56)/.test(t.style.background)).length })`);
    check('the heatmap shows the largest stocks by sector, coloured by their move', hm.tiles >= 400 && hm.sectors >= 5 && hm.colored > hm.tiles * 0.9, JSON.stringify(hm));
    await run(`document.querySelector('.hm-sector').click()`);
    await wait(300);
    const zoom = await run(`({ crumb: document.querySelector('.hm-crumb').innerText, tiles: document.querySelectorAll('.hm-tile').length })`);
    check('clicking a sector zooms in on it', /All sectors/.test(zoom.crumb) && zoom.tiles < hm.tiles, JSON.stringify(zoom));
    const hmSym = await run(`(() => { const t = document.querySelector('.hm-tile'); t.click(); return t.dataset.sym; })()`);
    await wait(3000);
    const hmChart = await run(`document.querySelector('.cell.active .lg-title, .cell .lg-title').innerText`);
    check('clicking a tile opens its chart', hmChart.startsWith(`${hmSym} `), `${hmSym} -> ${hmChart.split('\n')[0]}`);
    await run(`document.querySelector('.hm-crumb [data-hm-sector=""]')?.click(); document.querySelector('#hm-close').click()`);

    check('the header fits without scrolling', await run(`(() => { const t = document.querySelector('.topbar'); return t.scrollWidth <= t.clientWidth; })()`));
    // ...at any width from small laptops up (labels hide a group at a time).
    const fits = await run(`(async () => { const t = document.querySelector('.topbar'); const bad = [];
      for (const w of [1280, 1366, 1500, 1600, 1720, 1800, 1950, 2400]) {
        t.style.width = w + 'px'; await new Promise((r) => setTimeout(r, 120));
        if (t.scrollWidth > t.clientWidth) bad.push(w);
      }
      t.style.width = ''; return bad; })()`);
    check('...at every width from 1280 to 2400 px', fits.length === 0, fits.join(', '));

    check('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('test run', false, e.stack);
  }

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  server.close();
  app.exit(failed ? 1 : 0);
});
