// Paper trading: a simulated account that fills market, limit and stop orders against live
// prices (ticks) or replayed candles, with a stop loss and take profit on each position.
// No DOM and no network, so it's unit-tested in test/paper.test.mjs (in English: Node has no UI
// language). Fill reasons ('Market', 'Stop loss'…) are ids, kept in English; trading.js shows them.

import { t, locale } from './i18n.js';
//
// One position per symbol (netting): buying while short reduces, closes or flips the short.
// Prices and P&L are in each instrument's own currency; the account adds them up as-is.

export const PAPER_DEFAULTS = {
  balance: 100000, // starting cash
  commission: 0, // % of each fill's value
  slippage: 0, // % worse than the price for market and stop fills
  leverage: 1, // positions may total up to equity × leverage
};

const EPS = 1e-9;
const round = (v, d = 10) => Math.round(v * 10 ** d) / 10 ** d; // keeps 0.1 + 0.2 tidy
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const opt = (v) => (v === '' || v == null ? null : Number(v));

export const ORDER_TYPES = { market: t('paper.type.market'), limit: t('paper.type.limit'), stop: t('paper.type.stop') };

export class PaperAccount {
  /** settings: PAPER_DEFAULTS overrides; saved: a previous toJSON(). */
  constructor(settings = {}, saved = null) {
    const s = { ...PAPER_DEFAULTS, ...(saved?.settings || {}), ...settings };
    this.settings = s;
    this.cash = finite(saved?.cash) ? saved.cash : s.balance;
    this.positions = saved?.positions ? JSON.parse(JSON.stringify(saved.positions)) : {};
    this.orders = saved?.orders ? JSON.parse(JSON.stringify(saved.orders)) : [];
    this.trades = saved?.trades ? [...saved.trades] : [];
    this.fills = saved?.fills ? [...saved.fills] : [];
    this.last = saved?.last ? { ...saved.last } : {}; // symbol -> last price
    this.seq = saved?.seq || 0;
  }

  toJSON() {
    return {
      settings: this.settings, cash: this.cash, positions: this.positions, orders: this.orders,
      trades: this.trades.slice(-500), fills: this.fills.slice(-1000), last: this.last, seq: this.seq,
    };
  }

  /** Back to the starting balance with nothing open (optionally with new settings). */
  reset(settings = {}) {
    Object.assign(this, new PaperAccount({ ...this.settings, ...settings }));
  }

  // --- numbers ---------------------------------------------------------------

  unrealized(symbol) {
    const p = this.positions[symbol];
    const px = this.last[symbol];
    if (!p || !finite(px)) return 0;
    return (px - p.avg) * p.qty;
  }

  get openPnl() { return Object.keys(this.positions).reduce((s, sym) => s + this.unrealized(sym), 0); }
  get equity() { return this.cash + this.openPnl; }
  get realized() { return this.cash - this.settings.balance; }

  /** Total value of all positions at their last prices. */
  exposure(except = null) {
    let x = 0;
    for (const [sym, p] of Object.entries(this.positions)) if (sym !== except) x += Math.abs(p.qty) * (this.last[sym] ?? p.avg);
    return x;
  }

  stats() {
    const t = this.trades;
    const wins = t.filter((x) => x.pnl > 0);
    const losses = t.filter((x) => x.pnl < 0);
    const gross = (arr) => arr.reduce((s, x) => s + x.pnl, 0);
    return {
      trades: t.length,
      winRate: t.length ? (wins.length / t.length) * 100 : null,
      profitFactor: losses.length ? gross(wins) / -gross(losses) : wins.length ? Infinity : null,
      avgWin: wins.length ? gross(wins) / wins.length : null,
      avgLoss: losses.length ? gross(losses) / losses.length : null,
      net: gross(t),
    };
  }

  // --- orders ----------------------------------------------------------------

  /**
   * Places an order. o: { symbol, side: 'buy'|'sell', type: 'market'|'limit'|'stop', qty,
   * price (limit/stop level), sl, tp }. at: { price (current market price), time }.
   * Returns { ok, order?, fills: [...], error? }. Marketable orders fill right away.
   */
  placeOrder(o, at = {}) {
    const symbol = o.symbol;
    const side = o.side;
    const type = o.type || 'market';
    const qty = Number(o.qty);
    const price = opt(o.price);
    const sl = opt(o.sl);
    const tp = opt(o.tp);
    const now = finite(at.price) ? at.price : this.last[symbol];
    if (finite(at.price)) this.last[symbol] = at.price;
    if (!symbol) return { ok: false, error: t('paper.err.noSymbol') };
    if (side !== 'buy' && side !== 'sell') return { ok: false, error: t('paper.err.side') };
    if (!ORDER_TYPES[type]) return { ok: false, error: t('paper.err.type') };
    if (!finite(qty) || qty <= 0) return { ok: false, error: t('paper.err.qty') };
    if (type !== 'market' && (!finite(price) || price <= 0)) return { ok: false, error: type === 'stop' ? t('paper.err.stopPrice') : t('paper.err.limitPrice') };
    if (type === 'market' && !finite(now)) return { ok: false, error: t('paper.err.noPriceYet') };
    const marketable = type === 'market'
      || (finite(now) && (type === 'limit' ? (side === 'buy' ? now <= price : now >= price) : (side === 'buy' ? now >= price : now <= price)));
    // An order that fills now has its stops checked against the price it fills at.
    const bad = this.checkBracket(side, marketable ? now : price, sl, tp);
    if (bad) return { ok: false, error: bad };

    const order = { id: `o${++this.seq}`, symbol, side, type, qty, price: type === 'market' ? null : price, sl, tp, created: at.time ?? null };
    if (marketable) {
      const fillAt = type === 'limit' ? now : this.slip(side, now);
      const err = this.checkBuyingPower(symbol, side, qty, fillAt);
      if (err) return { ok: false, error: err };
      const fills = this.fill(order, fillAt, at.time ?? null, type === 'market' ? 'Market' : type === 'limit' ? 'Limit' : 'Stop');
      return { ok: true, order, fills };
    }
    const err = this.checkBuyingPower(symbol, side, qty, price);
    if (err) return { ok: false, error: err };
    this.orders.push(order);
    return { ok: true, order, fills: [] };
  }

  cancelOrder(id) {
    const n = this.orders.length;
    this.orders = this.orders.filter((o) => o.id !== id);
    return this.orders.length < n;
  }

  cancelAll(symbol = null) { this.orders = this.orders.filter((o) => symbol && o.symbol !== symbol); }

  /** Moves a working order (e.g. dragged on the chart). Fills right away if it became marketable. */
  modifyOrder(id, changes = {}, at = {}) {
    const o = this.orders.find((x) => x.id === id);
    if (!o) return { ok: false, error: t('paper.err.orderGone') };
    const next = { ...o, ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, k === 'qty' ? Number(v) : opt(v)])) };
    if (!finite(next.qty) || next.qty <= 0) return { ok: false, error: t('paper.err.qty') };
    if (!finite(next.price) || next.price <= 0) return { ok: false, error: t('paper.err.price') };
    const bad = this.checkBracket(next.side, next.price, next.sl, next.tp);
    if (bad) return { ok: false, error: bad };
    this.cancelOrder(id);
    const res = this.placeOrder({ ...next }, at);
    if (!res.ok) { this.orders.push(o); return res; } // put the old one back
    res.order.id = o.id; // keep its identity (the chart line follows it)
    for (const f of res.fills) f.orderId = o.id;
    return res;
  }

  /** Sets or clears the stop loss / take profit of an open position. */
  setBracket(symbol, { sl, tp } = {}) {
    const p = this.positions[symbol];
    if (!p) return { ok: false, error: t('paper.err.noPosition') };
    const next = { sl: sl === undefined ? p.sl : opt(sl), tp: tp === undefined ? p.tp : opt(tp) };
    const ref = this.last[symbol] ?? p.avg;
    const bad = this.checkBracket(p.qty > 0 ? 'buy' : 'sell', ref, next.sl, next.tp, true);
    if (bad) return { ok: false, error: bad };
    Object.assign(p, next);
    return { ok: true };
  }

  /** Closes all (or qty of) a position at the market. */
  closePosition(symbol, at = {}) {
    const p = this.positions[symbol];
    if (!p) return { ok: false, error: t('paper.err.noPosition') };
    if (finite(at.price)) this.last[symbol] = at.price;
    const px = this.last[symbol];
    if (!finite(px)) return { ok: false, error: t('paper.err.noPrice') };
    const qty = Math.min(Math.abs(p.qty), finite(at.qty) && at.qty > 0 ? at.qty : Infinity);
    const side = p.qty > 0 ? 'sell' : 'buy';
    const fills = this.fill({ id: null, symbol, side, qty }, this.slip(side, px), at.time ?? null, 'Close');
    return { ok: true, fills };
  }

  closeAll(at = {}) {
    const fills = [];
    for (const sym of Object.keys(this.positions)) fills.push(...(this.closePosition(sym, { time: at.time }).fills || []));
    return fills;
  }

  // --- prices ----------------------------------------------------------------

  /** A live trade at `price`: fills any order or stop it reached. Returns the fills. */
  tick(symbol, price, time = null) {
    if (!finite(price)) return [];
    const prev = this.last[symbol];
    this.last[symbol] = price;
    if (!this.hasWork(symbol)) return [];
    // Between two trades the price moved through every level in between: a resting limit there
    // filled at its price, a stop triggered and filled at the next trade (this one).
    return this.walk(symbol, [[finite(prev) ? prev : price, price, 'trades']], time);
  }

  /**
   * A whole candle (bar replay): the price is taken from the previous close to the open (a gap:
   * fills there happen at the open), then through the candle's range. A rising candle is assumed
   * to dip first (open → low → high → close), a falling one to rally first.
   */
  bar(symbol, b, time = null) {
    if (![b?.open, b?.high, b?.low, b?.close].every(finite)) return [];
    const prev = this.last[symbol];
    this.last[symbol] = b.close;
    if (!this.hasWork(symbol)) return [];
    const path = b.close >= b.open ? [b.open, b.low, b.high, b.close] : [b.open, b.high, b.low, b.close];
    const segs = [[finite(prev) ? prev : b.open, b.open, 'gap']];
    for (let i = 0; i < 3; i++) segs.push([path[i], path[i + 1], 'range']);
    return this.walk(symbol, segs, time);
  }

  hasWork(symbol) { return !!this.positions[symbol] || this.orders.some((o) => o.symbol === symbol); }

  // --- internals -------------------------------------------------------------

  slip(side, price) {
    const s = this.settings.slippage / 100;
    return s ? round(price * (side === 'buy' ? 1 + s : 1 - s), 12) : price;
  }

  /** For a buy, the stop loss must sit below the entry and the take profit above (a sell: the reverse). */
  checkBracket(side, ref, sl, tp, existing = false) {
    if (sl != null && (!finite(sl) || sl <= 0)) return t('paper.err.slPrice');
    if (tp != null && (!finite(tp) || tp <= 0)) return t('paper.err.tpPrice');
    if (!finite(ref)) return null;
    // Checked against the current price (an open position) or the entry price (a new order).
    if (side === 'buy') {
      if (sl != null && sl >= ref) return existing ? t('paper.err.longSlNow') : t('paper.err.longSlEntry');
      if (tp != null && tp <= ref) return existing ? t('paper.err.longTpNow') : t('paper.err.longTpEntry');
    } else {
      if (sl != null && sl <= ref) return existing ? t('paper.err.shortSlNow') : t('paper.err.shortSlEntry');
      if (tp != null && tp >= ref) return existing ? t('paper.err.shortTpNow') : t('paper.err.shortTpEntry');
    }
    return null;
  }

  checkBuyingPower(symbol, side, qty, price) {
    const p = this.positions[symbol];
    const cur = p?.qty || 0;
    const next = cur + (side === 'buy' ? qty : -qty);
    if (Math.abs(next) <= Math.abs(cur) + EPS) return null; // only reduces
    const needed = this.exposure(symbol) + Math.abs(next) * price;
    const power = Math.max(0, this.equity) * this.settings.leverage;
    if (needed > power + EPS) {
      const fmt = (v) => v.toLocaleString(locale, { maximumFractionDigits: 2 });
      return t('paper.err.buyingPower', { needed: fmt(needed), power: fmt(power), leverage: this.settings.leverage });
    }
    return null;
  }

  /** Orders and stops that can fill on this symbol: [{ kind, side, level, isStop, order? }]. */
  triggers(symbol) {
    const out = [];
    for (const o of this.orders) {
      if (o.symbol === symbol) out.push({ kind: 'order', side: o.side, level: o.price, isStop: o.type === 'stop', order: o });
    }
    const p = this.positions[symbol];
    if (p) {
      const exit = p.qty > 0 ? 'sell' : 'buy';
      if (p.sl != null) out.push({ kind: 'sl', side: exit, level: p.sl, isStop: true });
      if (p.tp != null) out.push({ kind: 'tp', side: exit, level: p.tp, isStop: false });
    }
    return out;
  }

  /**
   * Walks the price along segments [from, to, kind], filling triggers in the order the price reaches
   * them. kind 'range': a candle's continuous range (fills at the level); 'gap': nothing traded in
   * between, e.g. an opening gap (fills at the far end, better for limits, worse for stops);
   * 'trades': between two live trades (limits fill at their level, stops at the new trade).
   */
  walk(symbol, segs, time) {
    const fills = [];
    for (const [a0, b, kind] of segs) {
      let a = a0;
      for (let guard = 0; guard < 50; guard++) {
        let best = null;
        for (const t of this.triggers(symbol)) {
          // Buy limits and sell stops wait for the price to fall to their level; the others for it to rise.
          const falls = (t.side === 'buy') !== t.isStop;
          const inZone = (x) => (falls ? x <= t.level + EPS : x >= t.level - EPS);
          let at;
          const atLevel = kind === 'range' || (kind === 'trades' && !t.isStop);
          if (inZone(a)) at = kind === 'range' ? a : kind === 'trades' && !t.isStop ? a : b; // passed already
          else if (inZone(b)) at = atLevel ? t.level : b;
          else continue;
          const dist = Math.abs(at - a);
          if (!best || dist < best.dist) best = { t, at, dist };
        }
        if (!best) break;
        const { t } = best;
        const px = t.isStop ? this.slip(t.side, best.at) : best.at;
        if (t.kind === 'order') {
          this.orders = this.orders.filter((o) => o !== t.order);
          if (this.checkBuyingPower(symbol, t.side, t.order.qty, px)) {
            fills.push({ rejected: true, order: t.order, reason: 'Not enough buying power', symbol, time });
            continue;
          }
          fills.push(...this.fill(t.order, px, time, t.isStop ? 'Stop' : 'Limit'));
        } else {
          const p = this.positions[symbol];
          fills.push(...this.fill({ id: null, symbol, side: t.side, qty: Math.abs(p.qty) }, px, time, t.kind === 'sl' ? 'Stop loss' : 'Take profit'));
        }
        a = best.at; // keep walking from where it filled
      }
    }
    return fills;
  }

  /** Books one fill: opens, adds to, reduces, closes or flips the position. */
  fill(order, price, time, reason) {
    const { symbol, side } = order;
    let qty = order.qty;
    const sgn = side === 'buy' ? 1 : -1;
    const commission = round(Math.abs(qty * price) * (this.settings.commission / 100), 8);
    this.cash = round(this.cash - commission);
    this.last[symbol] ??= price;
    const fill = { id: `f${++this.seq}`, orderId: order.id, symbol, side, qty, price, time, reason, commission };
    this.fills.push(fill);
    const out = [fill];

    let p = this.positions[symbol];
    if (p && Math.sign(p.qty) !== sgn) {
      // Reduce or close (and maybe flip below).
      const close = Math.min(qty, Math.abs(p.qty));
      const dir = Math.sign(p.qty);
      const gross = (price - p.avg) * close * dir;
      const share = close / Math.abs(p.qty);
      const entryComm = p.comm * share;
      const exitComm = commission * (close / qty);
      this.cash = round(this.cash + gross);
      const trade = {
        id: `t${++this.seq}`, symbol, side: dir > 0 ? 'long' : 'short', qty: close, entry: p.avg, exit: price,
        pnl: round(gross - entryComm - exitComm, 8), pnlPct: ((price - p.avg) / p.avg) * 100 * dir,
        entryTime: p.opened, exitTime: time, reason,
      };
      this.trades.push(trade);
      fill.trade = trade.id;
      p.comm -= entryComm;
      p.qty = round(p.qty - dir * close);
      qty = round(qty - close);
      if (Math.abs(p.qty) < EPS) { delete this.positions[symbol]; p = null; }
      if (qty < EPS) return out;
      // What's left opens a position the other way, at commission already paid for this fill.
      this.positions[symbol] = p = { qty: 0, avg: price, sl: null, tp: null, opened: time, comm: 0 };
      p.comm = commission * (qty / order.qty);
    } else if (!p) {
      this.positions[symbol] = p = { qty: 0, avg: price, sl: null, tp: null, opened: time, comm: 0 };
      p.comm = commission;
    } else {
      p.comm += commission;
    }
    const next = round(p.qty + sgn * qty);
    p.avg = (Math.abs(p.qty) * p.avg + qty * price) / Math.abs(next);
    p.qty = next;
    if (order.sl != null) p.sl = order.sl;
    if (order.tp != null) p.tp = order.tp;
    return out;
  }
}
