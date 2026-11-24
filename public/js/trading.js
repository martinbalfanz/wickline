// The Paper trading panel: an order ticket, open positions, working orders, trade history and the
// account, for the simulated account in paper.js. Live paper trades fill against live prices
// (the charts' feeds plus a price stream for every symbol with a position or order). While a
// chart replays history, trading on it uses a separate practice account that fills on the
// replayed candles and is thrown away when the replay ends.

import { PaperAccount, PAPER_DEFAULTS, ORDER_TYPES } from './paper.js';
import { QuoteStream, displayTicker } from './datafeed.js';
import { $, esc, store, fixed } from './util.js';
import { t, locale } from './i18n.js';

const COLORS = { long: '#4FA3F7', short: '#EC5246', sl: '#EC5246', tp: '#2EBD85', order: '#B07CFF' };
const REFRESH_MS = 250;

const money = (v, sign = false) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${s}`;
};
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : v > 0 ? '+' : ''}${fixed(Math.abs(v), 2)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
/** 0.5, 12, 1.23456789: up to 8 decimals, no trailing zeros. */
export const fmtQty = (q) => (Number.isFinite(q) ? Math.abs(q).toLocaleString(locale, { maximumFractionDigits: 8, useGrouping: false }) : '—');
/** A price with sensible decimals for its size. */
export const fmtPrice = (p) => {
  if (p == null || !Number.isFinite(p)) return '—';
  const d = p >= 1000 ? 2 : p >= 1 ? 2 : p >= 0.01 ? 4 : 8;
  return p.toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtTime = (s) => (s == null ? '—' : new Date(s * 1000).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
/** Why a trade closed (paper.js's fill reasons, kept in English there), as History shows it. */
const REASON = {
  Market: t('trade.reason.market'), Limit: t('trade.reason.limit'), Stop: t('trade.reason.stop'), Close: t('trade.reason.close'),
  'Stop loss': t('trade.reason.sl'), 'Take profit': t('trade.reason.tp'),
};
/** Why a stop or an order filled, in its toast: "Sold 1 AAPL at 190.00 (stop loss)." */
const WHY = { 'Stop loss': t('trade.why.sl'), 'Take profit': t('trade.why.tp'), Limit: t('trade.why.limit'), Stop: t('trade.why.stop') };
/** A text's key by side and order type: sideType('trade.line.', 'buy', 'stop') → 'trade.line.buyStop'. */
const sideType = (base, side, type) => `${base}${side === 'buy' ? 'buy' : 'sell'}${type === 'stop' ? 'Stop' : type === 'market' ? 'Market' : 'Limit'}`;

/** Chart lines for one symbol of an account: the position, its stop loss and take profit, and orders. */
export function paperLines(acct, symbol) {
  const lines = [];
  const p = acct.positions[symbol];
  if (p) {
    const long = p.qty > 0;
    const at = (price) => (price - p.avg) * p.qty;
    lines.push({ id: `pos:${symbol}`, price: p.avg, color: long ? COLORS.long : COLORS.short, style: 'solid', drag: false,
      title: t(long ? 'trade.line.long' : 'trade.line.short', { qty: fmtQty(p.qty), pnl: money(acct.unrealized(symbol), true) }) });
    if (p.sl != null) lines.push({ id: `sl:${symbol}`, price: p.sl, color: COLORS.sl, style: 'dashed', drag: true, title: t('trade.line.sl', { pnl: money(at(p.sl), true) }) });
    if (p.tp != null) lines.push({ id: `tp:${symbol}`, price: p.tp, color: COLORS.tp, style: 'dashed', drag: true, title: t('trade.line.tp', { pnl: money(at(p.tp), true) }) });
  }
  for (const o of acct.orders) {
    if (o.symbol !== symbol) continue;
    lines.push({ id: `ord:${o.id}`, price: o.price, color: COLORS.order, style: 'dashed', drag: true,
      title: t(sideType('trade.line.', o.side, o.type), { qty: fmtQty(o.qty) }) });
  }
  return lines;
}

export class TradingPanel {
  /** evaluate: false in pop-out windows (only the main window fills live paper orders). */
  constructor({ getView, getViews, toast, onPick, evaluate = true }) {
    this.getView = getView;
    this.getViews = getViews;
    this.toast = toast;
    this.onPick = onPick;
    this.evaluate = evaluate;
    this.el = $('#trading');
    this.content = $('#tr-content');
    this.ticketEl = $('#tr-ticket');
    this.live = new PaperAccount({}, store.get('paper', null));
    const saved = store.get('paperTicket', {});
    this.ticket = { side: 'buy', type: 'market', qty: 1, price: '', sl: '', tp: '', useSl: false, useTp: false, ...saved };
    this.qtys = store.get('paperQty', {}); // symbol -> the last quantity traded (1 BTC and 1 share are very different)
    this.tab = 'positions';
    this.resetArmed = 0;
    this.lastRefresh = 0;
    this.refreshTimer = null;
    this.saveTimer = null;
    this.stream = evaluate ? new QuoteStream((full, q) => this.onQuote(full, q.price), { useCredits: true }) : null;
    this.streamed = new Set();

    this.el.querySelector('.st-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tr-tab]');
      if (!b) return;
      this.tab = b.dataset.trTab;
      this.render();
    });
    $('#tr-close').addEventListener('click', () => this.close());
    this.content.addEventListener('click', (e) => this.onTableClick(e));
    this.content.addEventListener('submit', (e) => { e.preventDefault(); this.saveSettings(); });
    this.ticketEl.addEventListener('submit', (e) => { e.preventDefault(); this.placeFromTicket(); });
    this.ticketEl.addEventListener('click', (e) => this.onTicketClick(e));
    this.ticketEl.addEventListener('input', (e) => this.onTicketInput(e));
    this.ticketEl.addEventListener('change', (e) => this.onTicketInput(e));
    for (const el of [this.ticketEl, this.content]) el.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => this.setHeight(window.innerHeight - ev.clientY - 28);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.dispatchEvent(new Event('resize')); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.setHeight(store.get('tradingHeight', 300), false);
    // Pop-out windows follow the main window's account.
    window.addEventListener('storage', (e) => {
      if (e.key !== 'wickline.paper') return;
      clearTimeout(this.saveTimer);
      this.live = new PaperAccount({}, store.get('paper', null));
      this.syncStream();
      this.refresh(true);
    });
    window.addEventListener('beforeunload', () => this.save(true));
    this.syncStream();
  }

  get isOpen() { return !this.el.hidden; }

  open() {
    this.el.hidden = false;
    document.body.classList.add('trading-open');
    window.dispatchEvent(new Event('resize'));
    this.renderTicket();
    this.refresh(true);
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove('trading-open');
    window.dispatchEvent(new Event('resize'));
    this.refresh(true);
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(220, Math.min(window.innerHeight * 0.8, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('tradingHeight', height);
  }

  /** The account trades on this chart go to: its replay's practice account, or the paper account. */
  accountFor(view) { return view?.replay && view.replayAccount ? view.replayAccount : this.live; }
  get view() { return this.getView(); }
  get account() { return this.accountFor(this.view); }

  /** The chart's current price (the replayed candle's close while replaying). */
  priceOf(view) { return view?.feed ? view.lastBar?.close : undefined; }
  /** A price rounded to the decimals a chart of this symbol shows (77021.297 → 77021.30). */
  roundPrice(symbol, price) {
    const v = [this.view, ...this.getViews()].find((x) => x?.state.symbol === symbol && x.bars.length);
    const prec = v ? v.meta.precision ?? 2 : 2;
    // At least 4 significant digits, so a stop 1% away from $0.13 doesn't round onto the entry.
    const d = Math.min(10, Math.max(prec, 3 - Math.floor(Math.log10(Math.abs(price) || 1))));
    return Number(price.toFixed(d));
  }

  /**
   * The quantity to trade on a chart: the last one used for its symbol, else about 10% of equity
   * (0.1 BTC, 29 AAPL), so a first order is a sensible size.
   */
  qtyFor(view) {
    const sym = view?.state.symbol;
    if (this.qtys[sym] > 0) return this.qtys[sym];
    const px = this.priceOf(view);
    if (!(px > 0)) return 1;
    const q = (Math.max(0, this.accountFor(view).equity) * 0.1) / px;
    return q >= 1 ? Math.floor(q) : Number(q.toPrecision(1)) || 1;
  }

  /** "Now" for an order: the replay's clock while replaying, else the real time. */
  timeOf(view) { return view?.replay ? view.utcAt(view.lastBar.time) : Math.floor(Date.now() / 1000); }

  // --- prices ------------------------------------------------------------------

  onQuote(full, price) {
    if (!this.live.hasWork(full) && !this.live.last[full]) return;
    this.handleFills(this.live, this.live.tick(full, price, Math.floor(Date.now() / 1000)));
  }

  /** A chart redrew with new data: its latest price moves the paper account (not while replaying). */
  onChartUpdate(view) {
    if (!this.evaluate || view.replay || !view.feed || !view.lastBar) return;
    const sym = view.state.symbol;
    if (this.streamed.has(sym)) { if (view === this.view) this.refresh(); return; }
    const fills = this.live.tick(sym, view.lastBar.close, Math.floor(Date.now() / 1000));
    if (fills.length) this.handleFills(this.live, fills);
    else if (this.live.positions[sym] || view === this.view) this.refresh();
  }

  /** Replay events from a chart: start a practice account, fill orders on each candle, sum up at the end. */
  onReplay(view, event, payload) {
    const sym = view.state.symbol;
    if (event === 'start') {
      const { balance, commission, slippage, leverage } = this.live.settings;
      view.replayAccount = new PaperAccount({ balance, commission, slippage, leverage });
      view.replayAccount.last[sym] = view.lastBar?.close;
      view.replayAccount.clock = view.replay.clock;
      this.toast(t('trade.toast.replayStart', { balance: money(balance) }));
    } else if (event === 'bar' && view.replayAccount) {
      const acct = view.replayAccount;
      const start = view.utcAt(payload.time);
      const end = start + view.tf.sec;
      const fills = start < (acct.clock ?? 0) - 1 ? acct.tick(sym, payload.close, end) : acct.bar(sym, payload, start);
      acct.clock = Math.max(acct.clock ?? 0, end);
      this.handleFills(acct, fills);
    } else if (event === 'resume' && view.replayAccount) {
      view.replayAccount.last[sym] = view.lastBar?.close;
    } else if (event === 'stop') {
      const acct = view.replayAccount;
      view.replayAccount = null;
      if (payload) this.toast(payload);
      else if (acct && (acct.trades.length || Object.keys(acct.positions).length)) {
        const s = acct.stats();
        const open = Object.keys(acct.positions).length;
        const result = acct.equity - acct.settings.balance;
        const vars = { n: s.trades, win: s.winRate?.toFixed(0), open, result: money(result, true) };
        this.toast(t(!open ? 'trade.toast.replayDone' : s.trades ? 'trade.toast.replayDoneOpen' : 'trade.toast.replayDoneOnlyOpen', vars));
      }
    } else if (event === 'end') {
      this.toast(t('trade.toast.replayEnd'));
    } else if (event === 'notice') {
      this.toast(payload);
    }
    this.refresh(true);
  }

  /** A chart changed symbol or timeframe, or became the active one. */
  onViewChange() { this.refresh(true); }

  /**
   * A new symbol (or into / out of a replay) on the active chart: the ticket takes that symbol's
   * quantity and fresh prices, once the chart has a price.
   */
  syncTicket() {
    const view = this.view;
    if (!view || !this.ticketEl.elements?.qty) return;
    const key = `${view.state.symbol}|${!!view.replay}`;
    if (key === this.ticketKey) return;
    if (!this.ticketPrefill(true)) return; // retry when the chart has a price
    this.ticketKey = key;
    this.ticket.qty = this.qtyFor(view);
    this.ticketEl.elements.qty.value = this.ticket.qty;
  }

  // --- orders ------------------------------------------------------------------

  /** The quantity to trade a symbol in (the active chart's by default). */
  setQty(q, sym = this.view?.state.symbol) {
    if (!(q > 0)) return;
    if (sym) { this.qtys[sym] = q; store.set('paperQty', this.qtys); }
    if (sym && sym !== this.view?.state.symbol) { this.refresh(true); return; }
    this.ticket.qty = q;
    this.saveTicket();
    const input = this.ticketEl.querySelector('[name="qty"]');
    if (input && document.activeElement !== input) input.value = q;
    this.refresh(true);
  }

  /** Buy / sell at the market from the chart's quick-trade buttons. */
  quickTrade(view, side, qty) {
    if (qty > 0) this.setQty(qty, view.state.symbol);
    this.place(view, { side, type: 'market', qty: qty > 0 ? qty : this.qtyFor(view) });
  }

  placeFromTicket() {
    const t = this.ticket;
    this.place(this.view, {
      side: t.side, type: t.type, qty: Number(t.qty), price: t.type === 'market' ? null : t.price,
      sl: t.useSl ? t.sl : null, tp: t.useTp ? t.tp : null,
    });
  }

  place(view, o) {
    if (!view) return;
    if (view.replayPick) { this.toast(t('trade.toast.pickStart')); return; }
    if (!view.lastBar || !view.feed) { this.toast(t('trade.toast.waitChart')); return; }
    const acct = this.accountFor(view);
    const res = acct.placeOrder({ ...o, symbol: view.state.symbol }, { price: this.priceOf(view), time: this.timeOf(view) });
    if (!res.ok) { this.toast(res.error); return; }
    if (!res.fills.length) {
      this.toast(t(sideType('trade.toast.placed.', o.side, o.type), { qty: fmtQty(o.qty), symbol: displayTicker(view.state.symbol), price: fmtPrice(res.order.price) }));
      this.changed(acct);
    } else this.handleFills(acct, res.fills, true);
  }

  /** A paper line was dragged on a chart: move the stop, target or order. */
  onDrag(view, id, price) {
    const acct = this.accountFor(view);
    const [kind, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    let res;
    if (kind === 'sl' || kind === 'tp') res = acct.setBracket(key, { [kind]: price });
    else if (kind === 'ord') res = acct.modifyOrder(key, { price }, { price: this.priceOf(view), time: this.timeOf(view) });
    if (res && !res.ok) this.toast(res.error);
    if (res?.fills?.length) this.handleFills(acct, res.fills, true);
    else this.changed(acct);
  }

  handleFills(acct, fills, quiet = false) {
    for (const f of fills) {
      // paper.js rejects a triggered order for one reason only: not enough buying power.
      if (f.rejected) { this.toast(t('trade.toast.rejected', { qty: fmtQty(f.order.qty), symbol: displayTicker(f.symbol) })); continue; }
      const why = WHY[f.reason]; // none for a market order or a close
      const vars = { qty: fmtQty(f.qty), symbol: displayTicker(f.symbol), price: fmtPrice(f.price), why };
      if (f.side === 'buy') this.toast(why ? t('trade.toast.boughtWhy', vars) : t('trade.toast.bought', vars));
      else this.toast(why ? t('trade.toast.soldWhy', vars) : t('trade.toast.sold', vars));
    }
    if (fills.length) this.changed(acct);
    else this.refresh();
  }

  /** Something in an account changed: save it, update the stream, panel and charts. */
  changed(acct) {
    if (acct === this.live) { this.save(); this.syncStream(); }
    this.refresh(true);
  }

  save(now = false) {
    if (!this.evaluate) return;
    clearTimeout(this.saveTimer);
    if (now) { store.set('paper', this.live.toJSON()); return; }
    this.saveTimer = setTimeout(() => store.set('paper', this.live.toJSON()), 300);
  }

  saveTicket() {
    const { side, type, qty, useSl, useTp } = this.ticket;
    store.set('paperTicket', { side, type, qty, useSl, useTp });
  }

  /** Live prices for every symbol with a paper position or order. */
  syncStream() {
    if (!this.stream) return;
    this.streamed = new Set([...Object.keys(this.live.positions), ...this.live.orders.map((o) => o.symbol)]);
    this.stream.setSymbols([...this.streamed]);
  }

  // --- drawing -----------------------------------------------------------------

  /** Redraws the panel and the charts' paper lines (at most every REFRESH_MS unless forced). */
  refresh(force = false) {
    if (!force) {
      if (this.refreshTimer) return;
      const wait = Math.max(0, REFRESH_MS - (performance.now() - this.lastRefresh));
      if (wait > 0) { this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refresh(true); }, wait); return; }
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.lastRefresh = performance.now();
    const active = this.view;
    for (const v of this.getViews()) {
      const acct = this.accountFor(v);
      const sym = v.state.symbol;
      const lines = paperLines(acct, sym);
      if (!this.evaluate && acct === this.live) for (const l of lines) l.drag = false;
      v.setPaperLines(lines);
      v.setPaperFills(acct.fills.filter((f) => f.symbol === sym).slice(-300));
      v.setQuickTrade((this.isOpen && v === active) || !!v.replay, this.qtyFor(v));
    }
    if (this.isOpen) { this.syncTicket(); this.render(); this.updateTicket(); }
  }

  render() {
    const acct = this.account;
    const view = this.view;
    const replay = !!view?.replay;
    const n = { positions: Object.keys(acct.positions).length, orders: acct.orders.length, history: acct.trades.length };
    this.el.querySelectorAll('[data-tr-tab]').forEach((b) => {
      b.classList.toggle('on', b.dataset.trTab === this.tab);
      const c = n[b.dataset.trTab];
      const badge = b.querySelector('span');
      if (badge) badge.textContent = c || '';
    });
    $('#tr-account').innerHTML = `${replay ? `<span class="tr-badge" title="${esc(t('trade.badge.replayTip'))}">${esc(t('trade.badge.replay'))}</span>` : ''}
      <span>${esc(t('trade.equity'))} <b>${money(acct.equity)}</b></span>
      <span>${esc(t('trade.openPnl'))} <b class="${cls(acct.openPnl)}">${money(acct.openPnl, true)}</b></span>
      <span>${esc(t('trade.realized'))} <b class="${cls(acct.realized)}">${money(acct.realized, true)}</b></span>`;
    const html = this.tab === 'orders' ? this.ordersHtml(acct)
      : this.tab === 'history' ? this.historyHtml(acct)
        : this.tab === 'account' ? this.accountHtml(acct, replay)
          : this.positionsHtml(acct);
    // Don't redraw the settings form under the reader's cursor.
    if (this.tab === 'account' && this.content.querySelector('form') && this.content.contains(document.activeElement)) return;
    if (html !== this.lastHtml) { this.content.innerHTML = html; this.lastHtml = html; }
  }

  positionsHtml(acct) {
    const rows = Object.entries(acct.positions).map(([sym, p]) => {
      const last = acct.last[sym];
      const u = acct.unrealized(sym);
      const long = p.qty > 0;
      const bracket = (k, v) => (v != null
        ? `${fmtPrice(v)} <button class="tr-x" data-tr="clear-${k}" data-sym="${esc(sym)}" title="${esc(t('common.remove'))}">×</button>`
        : `<button class="tr-add" data-tr="add-${k}" data-sym="${esc(sym)}" title="${esc(k === 'sl' ? t('trade.addSlTip') : t('trade.addTpTip'))}">${esc(k === 'sl' ? t('trade.addSl') : t('trade.addTp'))}</button>`);
      return `<tr>
        <td><button class="tr-sym" data-tr="open" data-sym="${esc(sym)}">${esc(displayTicker(sym))}</button></td>
        <td class="${long ? 'up' : 'down'}">${esc(long ? t('common.long') : t('common.short'))}</td>
        <td class="num">${fmtQty(p.qty)}</td>
        <td class="num">${fmtPrice(p.avg)}</td>
        <td class="num">${fmtPrice(last)}</td>
        <td class="num ${cls(u)}">${money(u, true)}</td>
        <td class="num ${cls(u)}">${pct(((last - p.avg) / p.avg) * 100 * Math.sign(p.qty))}</td>
        <td class="num">${bracket('sl', p.sl)}</td>
        <td class="num">${bracket('tp', p.tp)}</td>
        <td class="act"><button class="tb-btn" data-tr="close" data-sym="${esc(sym)}">${esc(t('trade.closePos'))}</button></td>
      </tr>`;
    }).join('');
    if (!rows) return `<div class="st-empty"><b>${esc(t('trade.empty.positions'))}</b><span>${t('trade.empty.positionsHelp')}</span></div>`;
    return `<table class="tr-table"><thead><tr><th>${esc(t('common.symbol'))}</th><th>${esc(t('trade.col.side'))}</th><th class="num">${esc(t('trade.col.qty'))}</th><th class="num">${esc(t('trade.col.avg'))}</th><th class="num">${esc(t('common.last'))}</th>
      <th class="num">${esc(t('trade.col.pnl'))}</th><th class="num">%</th><th class="num">${esc(t('trade.sl'))}</th><th class="num">${esc(t('trade.tp'))}</th><th class="act">
      <button class="tb-btn" data-tr="close-all">${esc(t('trade.closeAll'))}</button></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  ordersHtml(acct) {
    const rows = acct.orders.map((o) => `<tr>
      <td><button class="tr-sym" data-tr="open" data-sym="${esc(o.symbol)}">${esc(displayTicker(o.symbol))}</button></td>
      <td class="${o.side === 'buy' ? 'up' : 'down'}">${esc(o.side === 'buy' ? t('common.buy') : t('common.sell'))}</td>
      <td>${esc(ORDER_TYPES[o.type])}</td>
      <td class="num">${fmtQty(o.qty)}</td>
      <td class="num">${fmtPrice(o.price)}</td>
      <td class="num">${fmtPrice(o.sl)}</td>
      <td class="num">${fmtPrice(o.tp)}</td>
      <td class="num">${fmtPrice(acct.last[o.symbol])}</td>
      <td class="act"><button class="tb-btn" data-tr="cancel" data-id="${esc(o.id)}">${esc(t('trade.cancelOrder'))}</button></td>
    </tr>`).join('');
    if (!rows) return `<div class="st-empty"><b>${esc(t('trade.empty.orders'))}</b><span>${esc(t('trade.empty.ordersHelp'))}</span></div>`;
    return `<table class="tr-table"><thead><tr><th>${esc(t('common.symbol'))}</th><th>${esc(t('trade.col.side'))}</th><th>${esc(t('trade.col.type'))}</th><th class="num">${esc(t('trade.col.qty'))}</th><th class="num">${esc(t('common.price'))}</th>
      <th class="num">${esc(t('trade.sl'))}</th><th class="num">${esc(t('trade.tp'))}</th><th class="num">${esc(t('common.last'))}</th><th class="act">
      <button class="tb-btn" data-tr="cancel-all">${esc(t('trade.cancelAll'))}</button></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  historyHtml(acct) {
    const rows = [...acct.trades].reverse().slice(0, 300).map((x) => `<tr>
      <td>${fmtTime(x.exitTime)}</td>
      <td><button class="tr-sym" data-tr="open" data-sym="${esc(x.symbol)}">${esc(displayTicker(x.symbol))}</button></td>
      <td class="${x.side === 'long' ? 'up' : 'down'}">${esc(x.side === 'long' ? t('common.long') : t('common.short'))}</td>
      <td class="num">${fmtQty(x.qty)}</td>
      <td class="num">${fmtPrice(x.entry)}</td>
      <td class="num">${fmtPrice(x.exit)}</td>
      <td class="num ${cls(x.pnl)}">${money(x.pnl, true)}</td>
      <td class="num ${cls(x.pnl)}">${pct(x.pnlPct)}</td>
      <td>${esc(REASON[x.reason] || x.reason)}</td>
    </tr>`).join('');
    if (!rows) return `<div class="st-empty"><b>${esc(t('trade.empty.history'))}</b><span>${esc(t('trade.empty.historyHelp'))}</span></div>`;
    return `<table class="tr-table"><thead><tr><th>${esc(t('trade.col.closed'))}</th><th>${esc(t('common.symbol'))}</th><th>${esc(t('trade.col.side'))}</th><th class="num">${esc(t('trade.col.qty'))}</th><th class="num">${esc(t('trade.col.entry'))}</th>
      <th class="num">${esc(t('trade.col.exit'))}</th><th class="num">${esc(t('trade.col.pnl'))}</th><th class="num">%</th><th>${esc(t('trade.col.exitReason'))}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  accountHtml(acct, replay) {
    const s = acct.stats();
    const st = acct.settings;
    const cell = (label, value, c = '') => `<div class="tr-stat"><span>${esc(label)}</span><b class="${c}">${value}</b></div>`;
    const ret = ((acct.equity - st.balance) / st.balance) * 100;
    const stats = `<div class="tr-stats">
      ${cell(t('trade.startBalance'), money(st.balance))}
      ${cell(t('trade.equity'), money(acct.equity))}
      ${cell(t('trade.return'), pct(ret), cls(ret))}
      ${cell(t('trade.cash'), money(acct.cash))}
      ${cell(t('trade.openPnl'), money(acct.openPnl, true), cls(acct.openPnl))}
      ${cell(t('trade.closedTrades'), s.trades)}
      ${cell(t('trade.winRate'), s.winRate == null ? '—' : `${fixed(s.winRate, 1)}%`)}
      ${cell(t('trade.profitFactor'), s.profitFactor == null ? '—' : s.profitFactor === Infinity ? '∞' : fixed(s.profitFactor, 2))}
      ${cell(t('trade.avgWinLoss'), `${money(s.avgWin)} / ${money(s.avgLoss)}`)}
    </div>`;
    if (replay) return `${stats}<p class="muted tr-note">${esc(t('trade.replayNote'))}</p>`;
    const armed = Date.now() - this.resetArmed < 3000;
    return `${stats}<form class="tr-settings">
      <label><span>${esc(t('trade.startBalance'))}</span><input name="balance" type="number" min="1" step="any" value="${st.balance}"></label>
      <label><span>${esc(t('trade.commission'))}</span><input name="commission" type="number" min="0" max="5" step="any" value="${st.commission}" title="${esc(t('trade.commissionTip'))}"></label>
      <label><span>${esc(t('trade.slippage'))}</span><input name="slippage" type="number" min="0" max="5" step="any" value="${st.slippage}" title="${esc(t('trade.slippageTip'))}"></label>
      <label><span>${esc(t('trade.leverage'))}</span><input name="leverage" type="number" min="1" max="100" step="any" value="${st.leverage}" title="${esc(t('trade.leverageTip'))}"></label>
      <button class="tb-btn" type="submit">${esc(t('trade.saveSettings'))}</button>
      <button class="tb-btn tr-reset${armed ? ' armed' : ''}" type="button" data-tr="reset">${esc(armed ? t('trade.resetConfirm') : t('trade.reset'))}</button>
    </form>
    <p class="muted tr-note">${esc(t('trade.currencyNote'))}</p>`;
  }

  saveSettings() {
    const f = this.content.querySelector('.tr-settings');
    if (!f) return;
    const v = (k, min, max) => { const x = Number(f.elements[k].value); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : PAPER_DEFAULTS[k]; };
    const next = { balance: v('balance', 1, 1e12), commission: v('commission', 0, 5), slippage: v('slippage', 0, 5), leverage: v('leverage', 1, 100) };
    const balanceChanged = next.balance !== this.live.settings.balance;
    if (balanceChanged) {
      // A new starting balance moves the cash by the same amount (P&L so far is kept).
      this.live.cash += next.balance - this.live.settings.balance;
    }
    Object.assign(this.live.settings, next);
    this.toast(t('trade.toast.settingsSaved'));
    document.activeElement?.blur();
    this.changed(this.live);
  }

  onTableClick(e) {
    const b = e.target.closest('[data-tr]');
    if (!b) return;
    const view = this.view;
    const acct = this.account;
    const sym = b.dataset.sym;
    const act = b.dataset.tr;
    const at = (s) => ({ price: view?.state.symbol === s ? this.priceOf(view) : undefined, time: this.timeOf(view) });
    if (act === 'open') { this.onPick(sym); return; }
    if (view?.replayPick && acct !== this.live) { this.toast(t('trade.toast.pickStart')); return; }
    if (act === 'close') { const r = acct.closePosition(sym, at(sym)); if (!r.ok) this.toast(r.error); else this.handleFills(acct, r.fills); return; }
    if (act === 'close-all') { this.handleFills(acct, acct.closeAll({ time: this.timeOf(view) })); return; }
    if (act === 'cancel') { acct.cancelOrder(b.dataset.id); this.changed(acct); return; }
    if (act === 'cancel-all') { acct.cancelAll(); this.changed(acct); return; }
    if (act === 'clear-sl' || act === 'clear-tp') { acct.setBracket(sym, { [act.slice(6)]: null }); this.changed(acct); return; }
    if (act === 'add-sl' || act === 'add-tp') {
      const p = acct.positions[sym];
      const last = acct.last[sym] ?? p.avg;
      const away = (act === 'add-sl') === (p.qty > 0) ? 0.99 : 1.01; // 1% on the losing or winning side
      const r = acct.setBracket(sym, { [act.slice(4)]: this.roundPrice(sym, last * away) });
      if (!r.ok) this.toast(r.error);
      this.changed(acct);
      return;
    }
    if (act === 'reset') {
      if (Date.now() - this.resetArmed < 3000) {
        this.resetArmed = 0;
        this.live.reset();
        this.toast(t('trade.toast.reset', { balance: money(this.live.settings.balance) }));
        this.changed(this.live);
      } else {
        this.resetArmed = Date.now();
        this.render();
        setTimeout(() => this.render(), 3100);
      }
    }
  }

  // --- the order ticket --------------------------------------------------------

  renderTicket() {
    const tk = this.ticket;
    this.ticketEl.innerHTML = `
      <div class="tr-side" role="group" aria-label="${esc(t('trade.ticket.sideAria'))}">
        <button type="button" data-side="buy" class="${tk.side === 'buy' ? 'on' : ''}" aria-pressed="${tk.side === 'buy'}">${esc(t('common.buy'))}</button>
        <button type="button" data-side="sell" class="${tk.side === 'sell' ? 'on' : ''}" aria-pressed="${tk.side === 'sell'}">${esc(t('common.sell'))}</button>
      </div>
      <div class="tr-sym-line"><b class="tr-tk"></b><span class="tr-px muted"></span></div>
      <label><span>${esc(t('trade.col.type'))}</span><select name="type" class="select">${Object.entries(ORDER_TYPES).map(([k, l]) => `<option value="${k}"${tk.type === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="tr-price-row"><span>${esc(t('common.price'))}</span><input name="price" type="number" step="any" min="0" placeholder="${esc(t('common.price'))}"></label>
      <label><span>${esc(t('trade.qty'))}</span><input name="qty" type="number" step="any" min="0" value="${tk.qty}"></label>
      <div class="tr-sizes"><span class="muted tr-value"></span>${[10, 25, 50, 100].map((p) => `<button type="button" data-size="${p}" title="${esc(t('trade.ticket.ofEquity', { p }))}">${p}%</button>`).join('')}</div>
      <label class="tr-br"><input type="checkbox" name="useSl"${tk.useSl ? ' checked' : ''}><span>${esc(t('trade.sl'))}</span><input name="sl" type="number" step="any" min="0"><small class="tr-risk-sl"></small></label>
      <label class="tr-br"><input type="checkbox" name="useTp"${tk.useTp ? ' checked' : ''}><span>${esc(t('trade.tp'))}</span><input name="tp" type="number" step="any" min="0"><small class="tr-risk-tp"></small></label>
      <div class="tr-place-bar"><button type="submit" class="tr-place"></button></div>`;
    this.ticketKey = null;
    this.syncTicket();
    this.updateTicket();
  }

  /** Fills empty price fields from the chart's price (the entry, and 1% / 2% for the stops). */
  ticketPrefill(force = false) {
    const t = this.ticket;
    const px = this.priceOf(this.view);
    if (!Number.isFinite(px)) return false;
    const sym = this.view?.state.symbol;
    const round = (v) => this.roundPrice(sym, v);
    const f = this.ticketEl.elements;
    if (!f.price) return false;
    if (force || !t.price) { t.price = round(px); f.price.value = t.price; }
    const ref = t.type === 'market' ? px : Number(t.price) || px;
    const buy = t.side === 'buy';
    if (force || !t.sl) { t.sl = round(ref * (buy ? 0.99 : 1.01)); f.sl.value = t.sl; }
    if (force || !t.tp) { t.tp = round(ref * (buy ? 1.02 : 0.98)); f.tp.value = t.tp; }
    return true;
  }

  onTicketClick(e) {
    const side = e.target.closest('[data-side]')?.dataset.side;
    if (side && side !== this.ticket.side) {
      this.ticket.side = side;
      this.saveTicket();
      this.ticketEl.querySelectorAll('[data-side]').forEach((b) => {
        b.classList.toggle('on', b.dataset.side === side);
        b.setAttribute('aria-pressed', String(b.dataset.side === side));
      });
      this.ticketPrefill(true); // stops flip sides with the trade
      this.updateTicket();
      return;
    }
    const size = Number(e.target.closest('[data-size]')?.dataset.size);
    if (size) {
      const view = this.view;
      const px = this.priceOf(view);
      if (!Number.isFinite(px)) return;
      const acct = this.accountFor(view);
      const room = acct.equity * acct.settings.leverage * (size / 100);
      const q = room / px;
      this.setQty(Number(q >= 10 ? Math.floor(q) : q.toPrecision(4)));
      this.updateTicket();
    }
  }

  onTicketInput(e) {
    const { name, type, checked, value } = e.target;
    if (!name) return;
    this.ticket[name] = type === 'checkbox' ? checked : name === 'type' ? value : value;
    if (name === 'qty' && Number(value) > 0) this.setQty(Number(value));
    if (name === 'type') this.ticketPrefill(false);
    if (name === 'type' || name === 'useSl' || name === 'useTp' || name === 'qty') this.saveTicket();
    this.updateTicket();
  }

  /** The ticket's live parts: symbol and price, order value, risk and the button label. */
  updateTicket() {
    const f = this.ticketEl.elements;
    if (!f?.qty) return;
    const tk = this.ticket;
    const view = this.view;
    const acct = this.accountFor(view);
    const px = this.priceOf(view);
    const sym = view ? displayTicker(view.state.symbol) : '—';
    this.ticketEl.querySelector('.tr-tk').textContent = sym;
    this.ticketEl.querySelector('.tr-px').textContent = Number.isFinite(px) ? fmtPrice(px) : t('trade.loading');
    this.ticketEl.querySelector('.tr-price-row').hidden = tk.type === 'market';
    f.sl.disabled = !tk.useSl;
    f.tp.disabled = !tk.useTp;
    const qty = Number(tk.qty);
    const entry = tk.type === 'market' ? px : Number(tk.price);
    const value = qty * entry;
    this.ticketEl.querySelector('.tr-value').textContent = !(Number.isFinite(value) && value > 0) ? ''
      : acct.equity > 0 ? t('trade.ticket.valueOfEquity', { value: money(value), pct: ((value / acct.equity) * 100).toFixed(0) }) : `≈ ${money(value)}`;
    const dir = tk.side === 'buy' ? 1 : -1;
    const risk = (stop) => (Number(stop) > 0 && Number.isFinite(entry) && qty > 0 ? (Number(stop) - entry) * qty * dir : null);
    const sl = tk.useSl ? risk(tk.sl) : null;
    const tp = tk.useTp ? risk(tk.tp) : null;
    this.ticketEl.querySelector('.tr-risk-sl').textContent = sl == null ? '' : `${money(sl, true)}${acct.equity ? ` (${pct((sl / acct.equity) * 100)})` : ''}`;
    this.ticketEl.querySelector('.tr-risk-sl').className = `tr-risk-sl ${cls(sl)}`;
    this.ticketEl.querySelector('.tr-risk-tp').textContent = tp == null ? '' : `${money(tp, true)}${sl && sl < 0 ? ` · ${fixed(tp / -sl, 1)}R` : ''}`;
    this.ticketEl.querySelector('.tr-risk-tp').className = `tr-risk-tp ${cls(tp)}`;
    const btn = this.ticketEl.querySelector('.tr-place');
    btn.className = `tr-place ${tk.side}`;
    btn.textContent = t(sideType('trade.ticket.', tk.side, tk.type), { qty: fmtQty(qty) || '', symbol: sym, price: fmtPrice(Number(tk.price)) });
  }
}
