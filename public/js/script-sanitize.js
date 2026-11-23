// Cleans what a script run sends back before the page uses it.
//
// Scripts, including ones installed from the community library, run in a worker, but a worker can
// post any message it likes. So nothing in a result is trusted: colours, names, settings and numbers
// are checked here before they reach the page's HTML, the chart or the strategy tester.
//
// The work is bounded too: series must have exactly one value per bar, trades and markers are copied
// field by field (a fixed list, nothing nested), and everything else counts against a total budget,
// so a small message full of shared references can't make the page do millions of steps.

const STYLES = ['line', 'histogram', 'dots', 'step'];
const SHAPES = ['arrowUp', 'arrowDown', 'circle', 'square'];
const POSITIONS = ['aboveBar', 'belowBar', 'inBar'];
import { sanitizeIndicatorExtras } from './indicator-extensions.js';

const INPUT_TYPES = ['number', 'bool', 'text', 'select'];

/** At most this many values are copied from a result, apart from the per-bar series. */
export const MAX_RESULT_VALUES = 2_000_000;

/**
 * What one script may declare. The worker (script-worker.js) stops a script that goes past these
 * with an error, so the checks below never have to cut a legitimate result short.
 */
export const LIMITS = {
  inputs: 100, options: 50, optionText: 200, text: 1000, // input() settings; text: a text setting's length
  plots: 64, hlines: 50, fills: 64, markers: 5000, logs: 200, logText: 1000,
};

const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([-\d.%\s,/a-z]*\)|[a-z]{3,20})$/i;

/** A colour string that is safe to put in a style attribute, or `fallback`. */
export function safeColor(c, fallback = '#4FA3F7') {
  if (typeof c !== 'string') return fallback;
  const s = c.trim();
  return s.length <= 48 && COLOR_RE.test(s) && !/[;:"'<>\\]/.test(s) ? s : fallback;
}

// Only strings and numbers are converted: String() or Number() of an array would walk all of it.
const str = (v, max = 60) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const toNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.length <= 64 ? Number(v) : typeof v === 'boolean' ? Number(v) : NaN);
const numOr = (v, d) => { const x = toNum(v); return Number.isFinite(x) ? x : d; };
const optNum = (v) => (v == null || v === '' ? undefined : numOr(v, undefined));
const numOrNull = (v) => (v == null ? null : toNum(v));
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const isList = (v) => Array.isArray(v) || v instanceof Float64Array;

class Budget {
  constructor(max) { this.left = max; }
  spend(k) {
    this.left -= k;
    if (this.left < 0) throw new Error(`the result is too large (more than ${MAX_RESULT_VALUES.toLocaleString('en-US')} values)`);
  }
}

/** One value per bar as a Float64Array; anything else is an error. */
function perBar(v, n, what) {
  const len = isList(v) ? v.length : 0;
  if (len !== n) throw new Error(`${what} has ${len} values but the chart has ${n} bars`);
  return v instanceof Float64Array ? v : Float64Array.from(v, toNum);
}

/**
 * Cleans a script worker result: { meta, inputs, plots, hlines, fills, consts, markers, logs, strategy? }.
 * `bars` is the number of bars the script ran on. Throws when the result breaks the rules above.
 */
export function sanitizeResult(r, { bars } = {}) {
  if (!Number.isInteger(bars) || bars < 0) throw new TypeError('sanitizeResult needs the bar count');
  const n = bars;
  const budget = new Budget(MAX_RESULT_VALUES);
  const colorCache = new Map(); // per-bar colours repeat a lot
  const color = (c, fallback) => {
    if (typeof c !== 'string') return fallback;
    let ok = colorCache.get(c);
    if (ok === undefined) { ok = safeColor(c, null) !== null; colorCache.set(c, ok); }
    return ok ? c.trim() : fallback;
  };

  const o = r && typeof r === 'object' ? r : {};
  const m = o.meta && typeof o.meta === 'object' ? o.meta : {};
  const meta = {
    name: str(m.name) || 'Untitled script',
    short: str(m.short, 30),
    overlay: !!m.overlay,
    precision: m.precision == null ? null : Math.max(0, Math.min(10, Math.round(numOr(m.precision, 2)))),
  };
  if (m.strategy) meta.strategy = true;
  const extras = sanitizeIndicatorExtras(o, budget);
  if (extras.dashboard) meta.dashboard = extras.dashboard;

  const inputs = list(o.inputs, LIMITS.inputs).map((i, k) => {
    const x = i && typeof i === 'object' ? i : {};
    const type = oneOf(x.type, INPUT_TYPES, 'number');
    let def = x.def;
    if (type === 'number') def = numOr(def, 0);
    else if (type === 'bool') def = !!def;
    else def = str(def, LIMITS.text);
    const options = type === 'select' ? list(x.options, LIMITS.options).map((v) => str(v, LIMITS.optionText)) : undefined;
    budget.spend(1 + (options?.length || 0));
    return { key: `in${k}`, title: str(x.title, 60), def, type, options, min: optNum(x.min), max: optNum(x.max), step: optNum(x.step) };
  });

  const plots = list(o.plots, LIMITS.plots).map((p, k) => {
    const x = p && typeof p === 'object' ? p : {};
    const width = optNum(x.width);
    const values = perBar(x.values, n, `plot ${k + 1}`);
    let colors = null;
    if (x.colors != null) {
      if (!Array.isArray(x.colors) || x.colors.length !== n) {
        throw new Error(`plot ${k + 1} has ${Array.isArray(x.colors) ? x.colors.length : 0} colours but the chart has ${n} bars`);
      }
      colors = new Array(n);
      for (let i = 0; i < n; i++) { const c = x.colors[i]; colors[i] = c ? color(c, null) : null; }
    }
    return {
      key: `p${k}`,
      title: str(x.title, 40) || `Plot ${k + 1}`,
      color: color(x.color, '#4FA3F7'),
      colors,
      type: oneOf(x.type, STYLES, 'line'),
      width: width === undefined ? undefined : Math.max(1, Math.min(4, width)),
      legend: x.legend !== false,
      values,
    };
  });

  const consts = {};
  if (o.consts && typeof o.consts === 'object') {
    const keys = Object.keys(o.consts);
    budget.spend(keys.length);
    for (const k of keys) if (/^_c\d{1,4}$/.test(k)) consts[k] = numOr(o.consts[k], NaN);
  }
  // A fill must point at a plot of this result or one of its constants.
  const known = (x) => typeof x === 'string' && (/^p\d{1,3}$/.test(x) ? Number(x.slice(1)) < plots.length : Object.hasOwn(consts, x));
  const fills = list(o.fills, LIMITS.fills)
    .filter((f) => f && known(f.from) && known(f.to))
    .map((f) => ({ from: f.from, to: f.to, color: color(f.color, 'rgba(79, 163, 247, 0.12)') }));
  budget.spend(fills.length);

  const hlines = list(o.hlines, LIMITS.hlines).map((h) => ({ price: toNum(h?.price), color: color(h?.color, '#8E8A82') }));
  budget.spend(hlines.length);

  const rawMarkers = list(o.markers, LIMITS.markers);
  budget.spend(rawMarkers.length);
  const markers = rawMarkers
    .filter((mk) => mk && Number.isInteger(mk.i) && mk.i >= 0 && mk.i < n)
    .map((mk) => ({
      i: mk.i, shape: oneOf(mk.shape, SHAPES, 'circle'), position: oneOf(mk.position, POSITIONS, 'aboveBar'),
      color: color(mk.color, '#4FA3F7'), text: str(mk.text, 20),
    }))
    .sort((a, b) => a.i - b.i); // the chart's marker layer needs them in time order (a stable sort)

  const logs = list(o.logs, LIMITS.logs).map((l) => str(l, LIMITS.logText));
  const out = { meta, inputs, plots, hlines, fills, consts, markers, logs, benchmarks: extras.benchmarks };
  if (o.strategy && typeof o.strategy === 'object') out.strategy = sanitizeReport(o.strategy, n, budget);
  return out;
}

// --- strategy reports ---------------------------------------------------------------
// Exactly the fields backtest.js produces: numbers, a few short texts and the side.

const TRADE = {
  text: ['id', 'comment', 'reason'],
  num: ['qty', 'entryIndex', 'entryPrice', 'exitIndex', 'exitPrice', 'pnl', 'pnlPct', 'commission',
    'runup', 'runupPct', 'drawdown', 'drawdownPct', 'bars'],
};
const OPEN_TRADE = { text: ['id', 'comment'], num: ['qty', 'entryIndex', 'entryPrice', 'pnl', 'pnlPct', 'bars'] };
const REPORT_MARKER = { text: ['kind', 'id', 'comment', 'reason'], num: ['i', 'price'] };
// Statistics that are null when there's nothing to measure (no losing trades, flat equity…).
const NULLABLE = ['profitFactor', 'winRate', 'avgTrade', 'avgTradePct', 'avgWin', 'avgLoss', 'ratioWinLoss',
  'largestWin', 'largestLoss', 'avgBars', 'buyHoldPct', 'sharpe', 'sortino'];
const STATS = ['netProfit', 'netProfitPct', 'grossProfit', 'grossLoss', 'profitFactor', 'trades', 'wins', 'losses',
  'winRate', 'avgTrade', 'avgTradePct', 'avgWin', 'avgLoss', 'ratioWinLoss', 'largestWin', 'largestLoss', 'avgBars',
  'maxConsecWins', 'maxConsecLosses', 'commission'];
const SUMMARY = [...STATS, 'maxDrawdown', 'maxDrawdownPct', 'openPnl', 'finalEquity', 'buyHoldPct', 'sharpe', 'sortino',
  'exposurePct', 'commissionPaid', 'bars'];

function flat(v, spec) {
  const x = v && typeof v === 'object' ? v : {};
  const o = {};
  for (const k of spec.text) o[k] = str(x[k], 60);
  o.side = x.side === 'long' || x.side === 'short' ? x.side : null;
  for (const k of spec.num) o[k] = toNum(x[k]);
  return o;
}

function stats(v, keys) {
  const x = v && typeof v === 'object' ? v : {};
  const o = {};
  for (const k of keys) o[k] = NULLABLE.includes(k) ? numOrNull(x[k]) : toNum(x[k]);
  return o;
}

/** Bars × this (plus a little) is the most trades a report may have; markers may be twice that. */
const TRADES_PER_BAR = 10;

export function sanitizeReport(r, bars, budget = new Budget(MAX_RESULT_VALUES)) {
  const n = bars;
  const P = r.props && typeof r.props === 'object' ? r.props : {};
  const maxTrades = TRADES_PER_BAR * n + 1000;
  const count = (v, max, what) => {
    const len = Array.isArray(v) ? v.length : 0;
    if (len > max) throw new Error(`the backtest has ${len.toLocaleString('en-US')} ${what} for ${n.toLocaleString('en-US')} bars (at most ${max.toLocaleString('en-US')})`);
    return len ? v : [];
  };
  const trades = count(r.trades, maxTrades, 'trades');
  const markers = count(r.markers, 2 * maxTrades, 'trade markers');
  const openTrades = list(r.openTrades, 1000);
  budget.spend(trades.length * (TRADE.text.length + TRADE.num.length + 1)
    + openTrades.length * (OPEN_TRADE.text.length + OPEN_TRADE.num.length + 1)
    + markers.length * (REPORT_MARKER.text.length + REPORT_MARKER.num.length + 1));

  const summary = r.summary && typeof r.summary === 'object' ? r.summary : {};
  return {
    props: {
      initialCapital: numOr(P.initialCapital, 10000),
      sizeType: oneOf(P.sizeType, ['percent', 'cash', 'fixed'], 'percent'),
      sizeValue: numOr(P.sizeValue, 100),
      commission: numOr(P.commission, 0),
      slippage: numOr(P.slippage, 0),
      pyramiding: Math.max(1, Math.floor(numOr(P.pyramiding, 1))),
      fillOn: oneOf(P.fillOn, ['open', 'close'], 'open'),
    },
    trades: trades.map((t) => flat(t, TRADE)),
    openTrades: openTrades.map((t) => flat(t, OPEN_TRADE)),
    markers: markers.map((t) => flat(t, REPORT_MARKER)).filter((mk) => Number.isInteger(mk.i) && mk.i >= 0 && mk.i < n)
      .sort((a, b) => a.i - b.i),
    equity: perBar(r.equity, n, 'the equity curve'),
    drawdown: perBar(r.drawdown, n, 'the drawdown curve'),
    buyHold: perBar(r.buyHold, n, 'the buy & hold curve'),
    summary: { ...stats(summary, SUMMARY), long: stats(summary.long, STATS), short: stats(summary.short, STATS) },
  };
}

// --- indicator settings ----------------------------------------------------------------

/**
 * A setting's value as its declared type: { type: 'bool' | 'select' | 'text' | (number), def,
 * options, min, max }. Stored settings come from saved workspaces, pop-out links and earlier runs of
 * a script that may have declared the input differently, so they're never used as they are.
 */
export function coerceParam(v, p) {
  const type = p.type || 'number';
  if (type === 'bool') return typeof v === 'boolean' ? v : !!p.def;
  if (type === 'select') {
    const options = Array.isArray(p.options) ? p.options : [];
    return typeof v === 'string' && options.includes(v) ? v : p.def;
  }
  if (type === 'text') return typeof v === 'string' ? v.slice(0, LIMITS.text) : typeof p.def === 'string' ? p.def.slice(0, LIMITS.text) : '';
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && v.length <= 64 ? Number(v) : NaN;
  if (!Number.isFinite(x)) return p.def;
  const lo = Number.isFinite(p.min) ? p.min : -Infinity;
  const hi = Number.isFinite(p.max) ? p.max : Infinity;
  return Math.min(hi, Math.max(lo, x));
}

/** Settings for `specs` (an indicator's params): each one coerced, unknown keys dropped. */
export function coerceParams(params, specs = []) {
  const src = params && typeof params === 'object' ? params : {};
  const out = {};
  for (const p of specs) out[p.key] = coerceParam(Object.hasOwn(src, p.key) ? src[p.key] : undefined, p);
  return out;
}
