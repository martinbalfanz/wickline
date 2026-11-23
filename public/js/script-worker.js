// Runs user indicator scripts in a Web Worker: no access to the page, its storage or the DOM,
// and the app can stop it if it runs too long. See README → "Writing your own indicators".

import { TA } from './indicators.js';
import { runBacktest } from './backtest.js';

// User code runs inside its own block, so it may declare names like `max` or `n` itself.
const PREFIX = '"use strict";{\n';
const SUFFIX = '\n}';
// Names a script can't reach directly (shadowed with undefined). Not a hard security boundary,
// but it keeps scripts focused on chart math.
const BLOCKED = ['self', 'globalThis', 'postMessage', 'importScripts', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'EventSource', 'indexedDB', 'caches', 'navigator', 'location', 'Worker'];

let lineOffset = null;

function compile(names, code) {
  return new Function(...names, PREFIX + code + SUFFIX); // eslint-disable-line no-new-func
}

/** Line of the user's code that an error stack points at, or null. */
function errorLine(err, names) {
  const stack = String(err?.stack || '');
  const m = /<anonymous>:(\d+):(\d+)/.exec(stack);
  if (!m) return null;
  if (lineOffset === null) {
    try { compile(names, 'throw new Error("x")')(); } catch (e) {
      const k = /<anonymous>:(\d+):\d+/.exec(String(e.stack));
      lineOffset = k ? Number(k[1]) - 1 : 2;
    }
  }
  const line = Number(m[1]) - lineOffset;
  return line >= 1 ? line : null;
}

const SHAPES = { up: 'arrowUp', down: 'arrowDown', arrowUp: 'arrowUp', arrowDown: 'arrowDown', circle: 'circle', square: 'square' };
const POSITIONS = { above: 'aboveBar', below: 'belowBar', inside: 'inBar', aboveBar: 'aboveBar', belowBar: 'belowBar', inBar: 'inBar' };
const STYLES = ['line', 'histogram', 'dots', 'step'];

function run({ code, data, inputs = {}, ctx = {} }) {
  const n = data.time.length;
  const col = (k) => Array.from(data[k]);
  const time = col('time'), open = col('open'), high = col('high'), low = col('low'), close = col('close'), volume = col('volume');
  const bars = time.map((t, i) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i] }));
  const hl2 = bars.map((b) => (b.high + b.low) / 2);
  const hlc3 = bars.map((b) => (b.high + b.low + b.close) / 3);
  const ohlc4 = bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
  const logs = [];

  const out = {
    meta: { name: 'Untitled script', short: '', overlay: false, precision: null },
    inputs: [], plots: [], hlines: [], fills: [], markers: [], consts: {}, benchmarks: [],
  };

  const toSeries = (v, what) => {
    let arr;
    if (typeof v === 'number' || typeof v === 'boolean') arr = new Array(n).fill(Number(v));
    else if (typeof v === 'function') arr = Array.from({ length: n }, (_, i) => v(i));
    else if (v && typeof v.length === 'number') arr = Array.from(v, (x) => (x == null ? NaN : Number(x)));
    else throw new Error(`${what}: expected an array of ${n} values, a number or a function (i) => value`);
    if (arr.length !== n) throw new Error(`${what}: got ${arr.length} values but the chart has ${n} bars`);
    return arr;
  };

  const elementwise = (f) => (a, b) => {
    const A = Array.isArray(a), B = Array.isArray(b);
    if (!A && !B) return f(a, b);
    return Array.from({ length: n }, (_, i) => f(A ? a[i] : a, B ? b[i] : b));
  };

  // Bar-based helpers get this chart's bars bound in.
  const ta = { ...TA };
  delete ta.bars;
  for (const [k, fn] of Object.entries(TA.bars)) ta[k] = (...args) => fn(bars, ...args);

  // --- strategy (backtesting) ------------------------------------------------
  const strat = { declared: false, props: {}, entries: [], closes: [], exits: [], onBar: null };
  const toWhen = (when, what) => {
    if (when === undefined || when === true) return true;
    if (when === false || when == null) return false;
    if (typeof when === 'function') return when;
    return toSeries(when, what);
  };
  const needStrategy = (fn) => {
    if (!strat.declared) throw new Error(`strategy.${fn}(): call strategy('Name', { … }) at the top of the script first`);
  };
  const DIRS = { long: 'long', short: 'short', buy: 'long', sell: 'short' };
  const strategy = (name, opts = {}) => {
    strat.declared = true;
    out.meta.name = String(name || 'Untitled strategy').slice(0, 60);
    out.meta.short = String(opts.shortName || '').slice(0, 30);
    out.meta.overlay = opts.overlay !== false;
    out.meta.strategy = true;
    if (opts.precision != null) out.meta.precision = Math.max(0, Math.min(10, Math.round(opts.precision)));
    const size = opts.size;
    let sizeType, sizeValue;
    if (typeof size === 'number') { sizeType = 'percent'; sizeValue = size; }
    else if (size?.percent != null) { sizeType = 'percent'; sizeValue = size.percent; }
    else if (size?.cash != null) { sizeType = 'cash'; sizeValue = size.cash; }
    else if (size?.qty != null) { sizeType = 'fixed'; sizeValue = size.qty; }
    strat.props = {
      initialCapital: opts.capital, sizeType, sizeValue, commission: opts.commission, slippage: opts.slippage,
      pyramiding: opts.pyramiding, fillOn: opts.fillOn === 'close' ? 'close' : opts.fillOn === 'open' ? 'open' : undefined,
    };
  };
  strategy.entry = (id, direction, when = true, opts = {}) => {
    needStrategy('entry');
    const dir = DIRS[String(direction).toLowerCase()];
    if (!dir) throw new Error(`strategy.entry(): direction must be 'long' or 'short', got ${JSON.stringify(direction)}`);
    strat.entries.push({ id: String(id), dir, when: toWhen(when, 'strategy.entry()'), qty: opts.qty, comment: opts.comment });
  };
  strategy.close = (id = null, when = true) => {
    needStrategy('close');
    strat.closes.push({ id: id == null ? null : String(id), when: toWhen(when, 'strategy.close()') });
  };
  strategy.closeAll = (when = true) => strategy.close(null, when);
  strategy.exit = (opts = {}) => {
    needStrategy('exit');
    const price = (v, what) => (v == null ? null : typeof v === 'number' ? v : toSeries(v, what));
    strat.exits.push({
      from: opts.from == null ? null : String(opts.from),
      stopLoss: Number(opts.stopLoss) || 0, takeProfit: Number(opts.takeProfit) || 0, trailing: Number(opts.trailing) || 0,
      stopPrice: price(opts.stopPrice, 'strategy.exit({ stopPrice })'), limitPrice: price(opts.limitPrice, 'strategy.exit({ limitPrice })'),
    });
  };
  strategy.onBar = (fn) => {
    needStrategy('onBar');
    if (typeof fn !== 'function') throw new Error('strategy.onBar(): pass a function (i, s) => { … }');
    strat.onBar = fn;
  };

  const api = {
    strategy,
    // data
    open, high, low, close, volume, time, hl2, hlc3, ohlc4, n,
    bar_index: Array.from({ length: n }, (_, i) => i),
    timeframe: { seconds: ctx.tfSec || 0, intraday: (ctx.tfSec || 0) < 86400 },
    symbol: ctx.symbol || '',
    // Request an aligned benchmark series; the chart loads it out of band
    // and re-runs this script after prices arrive.
    compareClose(fullSymbol) {
      const sym = String(fullSymbol).toUpperCase();
      if (!/^[A-Z0-9^._:/=-]{1,64}$/.test(sym)) throw new Error('compareClose(): invalid symbol');
      if (!out.benchmarks.includes(sym)) {
        if (out.benchmarks.length >= 4) throw new Error('compareClose(): 4-symbol limit');
        out.benchmarks.push(sym);
      }
      const values = ctx.compareCloses?.[sym];
      return Array.isArray(values) && values.length === n ? values : new Array(n).fill(NaN);
    },
    // declarations
    indicator(name, opts = {}) {
      out.meta.name = String(name || 'Untitled script').slice(0, 60);
      out.meta.short = String(opts.shortName || '').slice(0, 30);
      out.meta.overlay = !!opts.overlay;
      if (opts.precision != null) out.meta.precision = Math.max(0, Math.min(10, Math.round(opts.precision)));
    },
    input(title, def, opts = {}) {
      const key = `in${out.inputs.length}`;
      const type = typeof def === 'boolean' ? 'bool' : typeof def === 'string' ? (opts.options ? 'select' : 'text') : 'number';
      if (type === 'number' && !Number.isFinite(def)) throw new Error(`input("${title}"): default must be a number, true/false or text`);
      out.inputs.push({
        key, title: String(title), def, type,
        options: opts.options ? opts.options.map(String) : undefined,
        min: opts.min, max: opts.max, step: opts.step,
      });
      const v = inputs[key];
      if (v === undefined) return def;
      if (type === 'number') return Number.isFinite(Number(v)) ? Number(v) : def;
      if (type === 'bool') return !!v;
      return String(v);
    },
    plot(series, opts = {}) {
      const values = toSeries(series, 'plot()');
      const key = `p${out.plots.length}`;
      let color = typeof opts.color === 'string' ? opts.color : '#4FA3F7';
      let colors = null;
      if (Array.isArray(opts.color)) colors = opts.color.map((c) => (c ? String(c) : null));
      else if (typeof opts.color === 'function') colors = values.map((v, i) => { const c = opts.color(i, v); return c ? String(c) : null; });
      if (colors) color = colors.find(Boolean) || color;
      out.plots.push({
        key,
        title: String(opts.title || `Plot ${out.plots.length + 1}`).slice(0, 40),
        color, colors, legend: opts.legend !== false,
        type: STYLES.includes(opts.style) ? opts.style : 'line',
        width: opts.width ? Math.max(1, Math.min(4, Number(opts.width))) : undefined,
        values: Float64Array.from(values),
      });
      return key;
    },
    hline(price, opts = {}) {
      out.hlines.push({ price: Number(price), color: opts.color || '#8E8A82' });
    },
    fill(a, b, opts = {}) {
      const ref = (x) => {
        if (typeof x === 'number') { const k = `_c${Object.keys(out.consts).length}`; out.consts[k] = x; return k; }
        if (typeof x === 'string' && /^p\d+$/.test(x)) return x;
        throw new Error('fill(): pass two values returned by plot(), or numbers');
      };
      out.fills.push({ from: ref(a), to: ref(b), color: opts.color || 'rgba(79, 163, 247, 0.12)' });
    },
    marker(condition, opts = {}) {
      const c = toSeries(condition, 'marker()');
      const shape = SHAPES[opts.shape] || 'circle';
      const position = POSITIONS[opts.position] || 'aboveBar';
      for (let i = 0; i < n && out.markers.length < 5000; i++) {
        if (c[i] && !Number.isNaN(c[i])) {
          out.markers.push({ i, shape, position, color: opts.color || '#4FA3F7', text: opts.text ? String(opts.text).slice(0, 20) : '' });
        }
      }
    },
    dashboard(opts = {}) {
      const tones = ['positive', 'warning', 'negative', 'neutral'];
      const tone = (v) => tones.includes(v) ? v : 'neutral';
      out.meta.dashboard = {
        status: String(opts.status || '').slice(0, 32),
        tone: tone(opts.tone),
        metrics: (Array.isArray(opts.metrics) ? opts.metrics : []).slice(0, 4).map((m) => ({
          label: String(m?.label || '').slice(0, 18),
          value: String(m?.value || '').slice(0, 22),
          tone: tone(m?.tone),
        })),
      };
    },
    log(...args) { if (logs.length < 200) logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); },
    // helpers
    ta,
    na: NaN,
    nz: (x, y = 0) => (Array.isArray(x) ? x.map((v) => (Number.isFinite(v) ? v : y)) : Number.isFinite(x) ? x : y),
    add: elementwise((a, b) => a + b),
    sub: elementwise((a, b) => a - b),
    mul: elementwise((a, b) => a * b),
    div: elementwise((a, b) => a / b),
    max: elementwise(Math.max),
    min: elementwise(Math.min),
    iff: (cond, a, b) => Array.from({ length: n }, (_, i) => ((Array.isArray(cond) ? cond[i] : cond)
      ? (Array.isArray(a) ? a[i] : a) : (Array.isArray(b) ? b[i] : b))),
    rgba(hex, alpha = 1) {
      const h = String(hex).replace('#', '');
      const v = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
      return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
    },
  };

  const names = [...Object.keys(api), ...BLOCKED];
  let fn;
  try {
    fn = compile(names, code);
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}`, line: null, logs };
  }
  try {
    fn(...Object.values(api), ...BLOCKED.map(() => undefined));
    if (strat.declared) {
      const report = runBacktest(bars, strat, { ...strat.props, ...(ctx.strategy || {}) }, strat.onBar, ctx.tfSec || 86400);
      out.strategy = report;
    }
  } catch (e) {
    return { ok: false, error: `${e.name || 'Error'}: ${e.message}`, line: errorLine(e, names), logs };
  }
  return { ok: true, result: { ...out, logs } };
}

self.onmessage = ({ data: msg }) => {
  const started = performance.now();
  let res;
  try {
    res = run(msg);
  } catch (e) {
    res = { ok: false, error: String(e?.message || e), line: null, logs: [] };
  }
  res.ms = Math.round(performance.now() - started);
  const transfer = res.ok ? res.result.plots.map((p) => p.values.buffer) : [];
  const st = res.ok && res.result.strategy;
  if (st) transfer.push(st.equity.buffer, st.drawdown.buffer, st.buyHold.buffer);
  self.postMessage({ id: msg.id, ...res }, transfer);
};
