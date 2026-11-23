// The Strategy Tester panel: results of the strategy scripts on the active chart.

import * as LWC from '../vendor/lightweight-charts.mjs';
import { THEMES, currentThemeName } from './chart-view.js';
import { STRATEGY_DEFAULTS } from './backtest.js';
import { $, esc, store } from './util.js';
import { tradesCsv } from './csv.js';

const money = (v, sign = false) => {
  if (v == null || !Number.isFinite(v)) return v === Infinity ? '∞' : '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${s}`;
};
const pct = (v, sign = true) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${Math.abs(v).toFixed(2)}%`);
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? (v === Infinity ? '∞' : '—') : v.toFixed(d));
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

function fmtTime(t, daily) {
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t * 1000);
  const p = (x) => String(x).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return daily ? date : `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export class StrategyTester {
  constructor({ getView, toast, browseStrategies }) {
    this.getView = getView;
    this.toast = toast;
    this.browseStrategies = browseStrategies;
    this.el = $('#tester');
    this.select = $('#st-select');
    this.content = $('#st-content');
    this.tab = 'overview';
    this.view = null;
    this.entryId = null;
    this.chart = null;
    this.seen = new Set(); // strategies that already opened the panel once

    this.el.querySelector('.st-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-st-tab]');
      if (!b) return;
      this.tab = b.dataset.stTab;
      this.tableSig = null;
      this.render();
    });
    this.select.addEventListener('change', () => { this.entryId = this.select.value; this.render(); });
    $('#st-close').addEventListener('click', () => this.close());
    this.content.addEventListener('click', (e) => this.onClick(e));
    this.content.addEventListener('submit', (e) => { e.preventDefault(); this.applyProps(); });
    this.content.addEventListener('keydown', (e) => e.stopPropagation());

    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => this.setHeight(window.innerHeight - ev.clientY - 28);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.setHeight(store.get('testerHeight', 340), false);
  }

  get isOpen() { return !this.el.hidden; }

  open() {
    this.el.hidden = false;
    document.body.classList.add('tester-open');
    this.render();
    window.dispatchEvent(new Event('resize'));
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove('tester-open');
    window.dispatchEvent(new Event('resize'));
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(200, Math.min(window.innerHeight * 0.8, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('testerHeight', height);
  }

  setView(view) {
    this.view = view;
    if (this.isOpen) this.render();
  }

  /** Called whenever a strategy on any chart finishes a backtest. */
  onResult(view, entry) {
    if (!this.seen.has(entry.inst.id)) {
      this.seen.add(entry.inst.id);
      if (view === this.getView()) { this.view = view; this.entryId = entry.inst.id; if (!this.isOpen) this.open(); }
    }
    if (view !== this.view || !this.isOpen) return;
    if (!this.entryId || !view.live.has(this.entryId)) this.entryId = entry.inst.id;
    if (entry.inst.id === this.entryId) this.render(true);
  }

  current() {
    const strategies = this.view?.strategies() || [];
    if (!strategies.length) return { strategies, entry: null };
    const entry = strategies.find((e) => e.inst.id === this.entryId) || strategies[strategies.length - 1];
    this.entryId = entry.inst.id;
    return { strategies, entry };
  }

  render(live = false) {
    if (!this.isOpen) return;
    const { strategies, entry } = this.current();
    this.select.innerHTML = strategies.map((e) => `<option value="${esc(e.inst.id)}">${esc(e.def.name)}</option>`).join('')
      || '<option>No strategy on this chart</option>';
    this.select.value = entry?.inst.id || '';
    this.select.disabled = !entry;
    this.el.querySelectorAll('[data-st-tab]').forEach((b) => b.classList.toggle('on', b.dataset.stTab === this.tab));
    $('#st-symbol').textContent = this.view ? `${this.view.ticker} · ${this.view.tf.label}` : '';

    if (!entry || !entry.report) {
      this.destroyChart();
      this.content.innerHTML = this.emptyHtml(entry);
      return;
    }
    // Live updates only refresh what's visible, and keep the properties form untouched while editing.
    if (live && this.tab === 'properties') return;
    const r = entry.report;
    if (this.tab === 'overview') { this.renderOverview(entry, r, live); return; }
    this.destroyChart();
    if (this.tab === 'properties') { this.renderProps(entry, r); return; }
    // Tables: on live ticks, redraw only when the trades changed, and keep scroll and selection.
    const last = r.trades[r.trades.length - 1];
    const sig = `${this.tab}|${entry.inst.id}|${r.trades.length}|${r.openTrades.length}|${last?.exitIndex}|${Math.round(r.summary.openPnl)}`;
    if (live && sig === this.tableSig) return;
    this.tableSig = sig;
    const wrap = this.content.querySelector('.st-table-wrap');
    const scroll = live && wrap ? wrap.scrollTop : 0;
    const selected = live ? this.content.querySelector('tr.sel')?.dataset.ei : null;
    if (this.tab === 'performance') this.renderPerformance(r);
    else this.renderTrades(entry, r);
    const next = this.content.querySelector('.st-table-wrap');
    if (next) next.scrollTop = scroll;
    if (selected != null) this.content.querySelector(`tr[data-ei="${selected}"]`)?.classList.add('sel');
  }

  // --- Overview ---------------------------------------------------------------
  renderOverview(entry, r, live) {
    const s = r.summary;
    const kpi = (label, value, sub = '', c = '') => `<div class="st-kpi"><span>${label}</span><b class="${c}">${value}</b><small>${sub}</small></div>`;
    const kpis = `<div class="st-kpis">
      ${kpi('Net profit', money(s.netProfit, true), pct(s.netProfitPct), cls(s.netProfit))}
      ${kpi('Closed trades', s.trades, `${s.wins} won · ${s.losses} lost`)}
      ${kpi('Win rate', pct(s.winRate, false), '')}
      ${kpi('Profit factor', num(s.profitFactor, 3), '')}
      ${kpi('Max drawdown', money(-s.maxDrawdown), pct(-s.maxDrawdownPct), 'down')}
      ${kpi('Avg trade', money(s.avgTrade, true), pct(s.avgTradePct), cls(s.avgTrade))}
      ${kpi('Buy & hold', pct(s.buyHoldPct), 'same period', cls(s.buyHoldPct))}
      ${kpi('Open P&L', money(s.openPnl, true), r.openTrades.length ? `${r.openTrades.length} open` : 'flat', cls(s.openPnl))}
    </div>`;
    if (!live || !this.content.querySelector('.st-kpis')) {
      this.destroyChart();
      this.content.innerHTML = `${kpis}<div class="st-chart-wrap"><div class="st-legend">
        <span><i style="background:#4FA3F7"></i>Equity</span><span><i style="background:#8E8A82"></i>Buy &amp; hold</span><span><i style="background:#EC5246"></i>Drawdown</span>
        <span class="muted">${r.equity.length.toLocaleString()} bars · ${esc(this.describeProps(r.props))}</span></div><div class="st-chart"></div></div>`;
      this.createChart();
    } else {
      this.content.querySelector('.st-kpis').outerHTML = kpis;
    }
    const times = entry.times;
    const mk = (arr) => {
      const out = [];
      for (let i = 0; i < arr.length; i++) if (times[i] != null) out.push({ time: times[i], value: arr[i] });
      return out;
    };
    this.eqSeries.setData(mk(r.equity));
    this.bhSeries.setData(mk(r.buyHold));
    this.ddSeries.setData(mk(r.drawdown));
    if (!live) this.chart.timeScale().fitContent();
  }

  createChart() {
    const t = THEMES[currentThemeName()];
    const host = this.content.querySelector('.st-chart');
    this.chart = LWC.createChart(host, {
      autoSize: true,
      layout: { background: { type: LWC.ColorType.Solid, color: t.bg }, textColor: t.text, fontSize: 11, panes: { separatorColor: t.separator } },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border, timeVisible: !this.view?.tf.daily },
      crosshair: { mode: LWC.CrosshairMode.Normal },
    });
    const fmt = { type: 'price', precision: 2, minMove: 0.01 };
    this.eqSeries = this.chart.addSeries(LWC.AreaSeries, {
      lineColor: '#4FA3F7', topColor: 'rgba(79, 163, 247, 0.25)', bottomColor: 'rgba(79, 163, 247, 0.02)', lineWidth: 2, priceFormat: fmt,
    });
    this.bhSeries = this.chart.addSeries(LWC.LineSeries, {
      color: '#8E8A82', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, priceFormat: fmt,
    });
    this.ddSeries = this.chart.addSeries(LWC.AreaSeries, {
      lineColor: '#EC5246', topColor: 'rgba(236, 82, 70, 0.05)', bottomColor: 'rgba(236, 82, 70, 0.3)', lineWidth: 1,
      priceLineVisible: false, priceFormat: { type: 'custom', formatter: (v) => `${v.toFixed(2)}%`, minMove: 0.01 },
      invertFilledArea: true,
    }, 1);
    this.chart.panes()[1]?.setStretchFactor(0.35);
  }

  destroyChart() {
    if (this.chart) { this.chart.remove(); this.chart = null; }
  }

  applyTheme() { if (this.isOpen && this.tab === 'overview') { this.destroyChart(); this.content.innerHTML = ''; this.render(); } }

  describeProps(p) {
    const size = p.sizeType === 'percent' ? `${p.sizeValue}% of equity` : p.sizeType === 'cash' ? `${money(p.sizeValue)} per trade` : `${p.sizeValue} units`;
    return `capital ${money(p.initialCapital)}, ${size}, commission ${p.commission}%, fills at ${p.fillOn === 'close' ? 'bar close' : 'next open'}`;
  }

  // --- Performance ---------------------------------------------------------------
  renderPerformance(r) {
    const s = r.summary;
    const cols = [s, s.long, s.short];
    const row = (label, f, colorize = false) => `<tr><td>${label}</td>${cols.map((c) => {
      const v = f(c);
      return `<td class="${colorize ? cls(v.raw) : ''}">${v.text}</td>`;
    }).join('')}</tr>`;
    const m = (k, sign) => (c) => ({ raw: c[k], text: money(c[k], sign) });
    const p = (k) => (c) => ({ raw: c[k], text: pct(c[k], false) });
    const n = (k, d = 0) => (c) => ({ raw: c[k], text: num(c[k], d) });
    const once = (label, value, c = '') => `<tr><td>${label}</td><td class="${c}">${value}</td><td></td><td></td></tr>`;
    this.content.innerHTML = `<div class="st-table-wrap"><table class="st-table">
      <thead><tr><th></th><th>All</th><th>Long</th><th>Short</th></tr></thead>
      <tbody>
        ${row('Net profit', (c) => ({ raw: c.netProfit, text: `${money(c.netProfit, true)} <small>${pct(c.netProfitPct)}</small>` }), true)}
        ${row('Gross profit', m('grossProfit'), false)}
        ${row('Gross loss', m('grossLoss'), false)}
        ${row('Profit factor', n('profitFactor', 3))}
        ${row('Commission paid', m('commission'))}
        ${row('Total closed trades', n('trades'))}
        ${row('Winning trades', n('wins'))}
        ${row('Losing trades', n('losses'))}
        ${row('Percent profitable', p('winRate'))}
        ${row('Avg trade', (c) => ({ raw: c.avgTrade, text: `${money(c.avgTrade, true)} <small>${pct(c.avgTradePct)}</small>` }), true)}
        ${row('Avg winning trade', m('avgWin', true), true)}
        ${row('Avg losing trade', m('avgLoss', true), true)}
        ${row('Ratio avg win / avg loss', n('ratioWinLoss', 3))}
        ${row('Largest winning trade', m('largestWin', true), true)}
        ${row('Largest losing trade', m('largestLoss', true), true)}
        ${row('Avg # bars in trades', n('avgBars', 1))}
        ${row('Max consecutive wins', n('maxConsecWins'))}
        ${row('Max consecutive losses', n('maxConsecLosses'))}
        ${once('Max drawdown', `${money(-s.maxDrawdown)} <small>${pct(-s.maxDrawdownPct)}</small>`, 'down')}
        ${once('Buy &amp; hold return', pct(s.buyHoldPct), cls(s.buyHoldPct))}
        ${once('Sharpe ratio (annualized)', num(s.sharpe, 3))}
        ${once('Sortino ratio (annualized)', num(s.sortino, 3))}
        ${once('Time in market', pct(s.exposurePct, false))}
        ${once('Open P&amp;L', money(s.openPnl, true), cls(s.openPnl))}
        ${once('Final equity', money(s.finalEquity))}
      </tbody></table></div>`;
  }

  // --- List of trades ------------------------------------------------------------
  renderTrades(entry, r) {
    const daily = this.view?.tf.daily;
    const t = entry.times;
    const p = (x) => this.view?.formatPrice(x) ?? num(x);
    let cum = 0;
    const rows = r.trades.map((tr, k) => { cum += tr.pnl; return { tr, k: k + 1, cum }; }).reverse();
    const MAX = 1000;
    const open = r.openTrades.map((o) => `<tr class="st-open" data-ei="${o.entryIndex}" data-xi="${t.length - 1}">
        <td>Open</td><td class="${o.side === 'long' ? 'up' : 'down'}">${o.side === 'long' ? 'Long' : 'Short'}</td>
        <td>${esc(o.id)}</td><td>${fmtTime(t[o.entryIndex], daily)}</td><td>${p(o.entryPrice)}</td>
        <td colspan="3" class="muted">still open</td><td>${num(o.qty, 4)}</td>
        <td class="${cls(o.pnl)}">${money(o.pnl, true)} <small>${pct(o.pnlPct)}</small></td><td></td><td></td><td></td></tr>`).join('');
    const body = rows.slice(0, MAX).map(({ tr, k, cum: c }) => `<tr data-ei="${tr.entryIndex}" data-xi="${tr.exitIndex}">
        <td>${k}</td><td class="${tr.side === 'long' ? 'up' : 'down'}">${tr.side === 'long' ? 'Long' : 'Short'}</td>
        <td>${esc(tr.id)}</td><td>${fmtTime(t[tr.entryIndex], daily)}</td><td>${p(tr.entryPrice)}</td>
        <td>${esc(tr.reason)}</td><td>${fmtTime(t[tr.exitIndex], daily)}</td><td>${p(tr.exitPrice)}</td>
        <td>${num(tr.qty, 4)}</td>
        <td class="${cls(tr.pnl)}">${money(tr.pnl, true)} <small>${pct(tr.pnlPct)}</small></td>
        <td class="up">${money(tr.runup)}</td><td class="down">${money(-tr.drawdown)}</td>
        <td class="${cls(c)}">${money(c, true)}</td></tr>`).join('');
    this.content.innerHTML = `<div class="st-trades-head"><span class="muted">${r.trades.length.toLocaleString()} closed trades${r.trades.length > MAX ? ` (newest ${MAX} shown)` : ''} · click a row to see it on the chart</span>
        <button class="tb-btn" data-st="csv">Export CSV</button></div>
      <div class="st-table-wrap"><table class="st-table st-trades">
      <thead><tr><th>#</th><th>Type</th><th>Signal</th><th>Entry time</th><th>Entry</th><th>Exit reason</th><th>Exit time</th><th>Exit</th>
        <th>Qty</th><th>P&amp;L</th><th>Run-up</th><th>Drawdown</th><th>Cum. P&amp;L</th></tr></thead>
      <tbody>${open}${body || '<tr><td colspan="13" class="muted">No closed trades yet.</td></tr>'}</tbody></table></div>`;
  }

  exportCsv() {
    const { entry } = this.current();
    if (!entry?.report) return;
    // Every field quoted; script text that a spreadsheet would run as a formula is kept as text (csv.js).
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([tradesCsv(entry.report.trades, entry.times)], { type: 'text/csv' }));
    a.download = `${entry.def.name.replace(/[^\w-]+/g, '_')}_${this.view.ticker.replace(/[^\w.-]/g, '')}_${this.view.state.tf}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // --- Properties --------------------------------------------------------------
  renderProps(entry, r) {
    const p = r.props;
    const sel = (v, opts) => opts.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('');
    this.content.innerHTML = `<form class="st-props">
      <label><span>Initial capital</span><input name="initialCapital" type="number" min="1" step="any" value="${p.initialCapital}"></label>
      <label><span>Order size</span><span class="st-pair">
        <input name="sizeValue" type="number" min="0" step="any" value="${p.sizeValue}">
        <select name="sizeType">${sel(p.sizeType, [['percent', '% of equity'], ['cash', 'cash per trade'], ['fixed', 'units (qty)']])}</select></span></label>
      <label><span>Commission (% per fill)</span><input name="commission" type="number" min="0" step="any" value="${p.commission}"></label>
      <label><span>Slippage (% per fill)</span><input name="slippage" type="number" min="0" step="any" value="${p.slippage}"></label>
      <label><span>Pyramiding (max entries)</span><input name="pyramiding" type="number" min="1" max="100" step="1" value="${p.pyramiding}"></label>
      <label><span>Fill orders on</span><select name="fillOn">${sel(p.fillOn, [['open', 'next bar open'], ['close', 'bar close']])}</select></label>
      <p class="form-note">These override the values in the script for this chart only. Backtests run over the bars loaded on the chart
        (${r.equity.length.toLocaleString()} now); scroll left on crypto charts to load more history.</p>
      <div class="pop-actions"><button type="button" class="btn-ghost" data-st="reset">Use script defaults</button><button type="submit" class="btn-primary">Apply</button></div>
    </form>`;
  }

  applyProps() {
    const { entry } = this.current();
    const f = this.content.querySelector('.st-props');
    if (!entry || !f) return;
    const v = (k) => f.elements[k].value;
    const numOr = (k, d) => { const x = Number(v(k)); return Number.isFinite(x) ? x : d; };
    const props = {
      initialCapital: Math.max(1, numOr('initialCapital', STRATEGY_DEFAULTS.initialCapital)),
      sizeType: v('sizeType'),
      sizeValue: Math.max(0, numOr('sizeValue', STRATEGY_DEFAULTS.sizeValue)),
      commission: Math.max(0, numOr('commission', 0)),
      slippage: Math.max(0, numOr('slippage', 0)),
      pyramiding: Math.max(1, Math.round(numOr('pyramiding', 1))),
      fillOn: v('fillOn'),
    };
    this.view.setStrategyProps(entry.inst.id, props);
    this.toast('Backtest updated with the new properties');
  }

  /** What the panel says when there's nothing to show yet. Scripts that only draw buy/sell markers
   *  are easy to mistake for strategies, so name them and point to real strategies. */
  emptyHtml(entry) {
    if (entry?.error) return `<div class="st-empty"><b>${esc(entry.def?.name || 'This strategy')} stopped with an error.</b><span>${esc(entry.error)}</span></div>`;
    if (entry) return '<div class="st-empty"><b>Running the backtest…</b></div>';
    const browse = this.browseStrategies ? '<button type="button" class="btn-primary st-browse" data-st="browse">Browse strategies</button>' : '';
    const howTo = `<span>Add one from <b>Indicators → Community → Strategies</b>, or in the <b>Script editor</b> choose <b>New ▾</b> → a strategy template and press <b>Ctrl+Enter</b>.
        Results, trades and the equity curve appear here.</span>`;
    const live = [...(this.view?.live?.values() || [])];
    // A script that failed before its first run has no definition yet, so it may be a strategy that never started.
    const failed = live.filter((e) => e.error && !e.def?.strategy && e.inst.scriptId);
    if (failed.length) {
      const e = failed[0];
      return `<div class="st-empty"><b>${esc(e.def?.name || e.name || 'A script on this chart')} stopped with an error.</b>
        <span>${esc(e.error)}</span><span>Fix it in the <b>Script editor</b>; if it’s a strategy, its results appear here once it runs.</span></div>`;
    }
    const lookalikes = live.filter((e) => e.def?.script && !e.def.strategy).map((e) => e.def.name);
    if (lookalikes.length) {
      const names = lookalikes.slice(0, 3).map((n) => `“${esc(n)}”`).join(', ');
      return `<div class="st-empty">
        <b>No strategy on the active chart.</b>
        <span>${names} ${lookalikes.length > 1 ? 'are indicators' : 'is an indicator'}: it can draw Buy/Sell signals, but it doesn’t place trades, so there’s nothing to backtest.
        A strategy script starts with <code>strategy('Name', …)</code> instead of <code>indicator(…)</code>.</span>
        ${howTo}${browse}</div>`;
    }
    return `<div class="st-empty"><b>No strategy on the active chart.</b>${howTo}${browse}</div>`;
  }

  onClick(e) {
    const act = e.target.closest('[data-st]')?.dataset.st;
    if (act === 'browse') { this.browseStrategies?.(); return; }
    if (act === 'csv') { this.exportCsv(); return; }
    if (act === 'reset') {
      const { entry } = this.current();
      if (entry) { this.view.setStrategyProps(entry.inst.id, undefined); this.toast('Using the script’s own properties'); }
      return;
    }
    const row = e.target.closest('tr[data-ei]');
    if (row && this.view) {
      this.view.focusBars(Number(row.dataset.ei), Number(row.dataset.xi));
      this.content.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel'));
      row.classList.add('sel');
    }
  }
}
