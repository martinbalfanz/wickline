// User indicator scripts: storage, starter templates, and the engine that runs them in a worker.

import { uid } from './util.js';
import { sanitizeResult } from './script-sanitize.js';

const KEY = 'wickline.scripts';
const TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function packBars(bars) {
  const n = bars.length;
  const data = {
    time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n),
    low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    data.time[i] = b.time; data.open[i] = b.open; data.high[i] = b.high;
    data.low[i] = b.low; data.close[i] = b.close; data.volume[i] = b.volume;
  }
  return data;
}

export class ScriptError extends Error {
  constructor(message, { line = null, logs = [], restarted = false } = {}) {
    super(message);
    this.line = line;
    this.logs = logs;
    this.restarted = restarted;
  }
}

const IDLE_MS = 120000;  // a script's worker that hasn't run for this long is stopped
const MAX_WORKERS = 16;  // more scripts than this at once wait for a worker to become free

/** A short fingerprint of a script's code (for runs that don't name their script). */
function codeKey(code) {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `code:${code.length}:${(h >>> 0).toString(36)}`;
}

/** The worker of one script. A script can change things inside its worker, but only for itself. */
class ScriptWorker {
  constructor(key, engine) {
    this.key = key;
    this.engine = engine;
    this.pending = new Map();
    this.idleTimer = null;
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(new URL('./script-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => this.settle(data);
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      // An error between runs (say, from a timer the script left behind) leaves the worker usable.
      if (!this.pending.size) return;
      this.restart(new ScriptError(`Script engine error: ${String(e.message || 'unknown').slice(0, 200)}`, { restarted: true }));
    };
  }

  send(job) {
    clearTimeout(this.idleTimer);
    const { data } = job;
    const timer = setTimeout(() => {
      if (!this.pending.has(job.id)) return;
      this.pending.delete(job.id);
      job.reject(new ScriptError(`Stopped: the script ran longer than ${TIMEOUT_MS / 1000} seconds (an endless loop?)`));
      // Other runs of this script waiting on the stopped worker are retried by their charts.
      this.restart(new ScriptError('Script engine restarted', { restarted: true }));
    }, TIMEOUT_MS);
    this.pending.set(job.id, { ...job, data: null, bars: data.time.length, timer });
    this.worker.postMessage({ id: job.id, code: job.code, data, inputs: job.inputs, ctx: job.ctx }, Object.values(data).map((a) => a.buffer));
  }

  settle(data) {
    const p = data && typeof data === 'object' ? this.pending.get(data.id) : null;
    if (!p) return;
    this.pending.delete(data.id);
    clearTimeout(p.timer);
    if (data.ok) {
      let res = null;
      try { res = sanitizeResult(data.result, { bars: p.bars }); } catch (e) { p.reject(new ScriptError(`Bad script result: ${e.message}`)); }
      if (res) p.resolve({ ...res, ms: Number(data.ms) || 0 });
    } else {
      const line = Number.isInteger(data.line) && data.line > 0 ? data.line : null;
      const logs = Array.isArray(data.logs) ? data.logs.slice(0, 200).map((l) => (typeof l === 'string' ? l.slice(0, 1000) : '')) : [];
      p.reject(new ScriptError(typeof data.error === 'string' ? data.error.slice(0, 500) : 'Script error', { line, logs }));
    }
    this.idle();
  }

  restart(reason) {
    try { this.worker.terminate(); } catch { /* ignore */ }
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) { clearTimeout(p.timer); p.reject(reason); }
    this.spawn();
    this.idle();
  }

  idle() {
    if (this.pending.size) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.engine.retire(this), IDLE_MS);
    this.engine.workerFree();
  }

  terminate() {
    clearTimeout(this.idleTimer);
    try { this.worker.terminate(); } catch { /* ignore */ }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ScriptError('Script engine restarted', { restarted: true })); }
    this.pending.clear();
  }
}

/**
 * Runs scripts, each in a worker of its own: a script that changes built-ins (say,
 * `Array.prototype.push`) or hangs can't touch another script's results. Workers that sit idle are
 * stopped, and at most MAX_WORKERS run at once.
 */
class ScriptEngine {
  constructor() {
    this.seq = 0;
    this.workers = new Map(); // key → ScriptWorker, least recently used first
    this.queue = [];          // [key, job] waiting for a free worker
  }

  /**
   * Runs a script over bars. `key` names the script (its id); runs with the same key share a worker.
   * Resolves with { meta, inputs, plots, hlines, fills, markers, consts, logs, ms }.
   */
  run(code, bars, inputs = {}, ctx = {}, key = null) {
    const src = String(code ?? '');
    const k = key == null || key === '' ? codeKey(src) : `script:${key}`;
    return new Promise((resolve, reject) => {
      // The bars are packed now, so a run that has to wait for a worker still uses the bars of this moment.
      this.dispatch(k, { id: ++this.seq, code: src, data: packBars(bars), inputs, ctx, resolve, reject });
    });
  }

  dispatch(key, job) {
    let w = this.workers.get(key);
    if (w) {
      this.workers.delete(key); // most recently used goes last
    } else {
      if (this.workers.size >= MAX_WORKERS && !this.retireIdle()) { this.queue.push([key, job]); return; }
      w = new ScriptWorker(key, this);
    }
    this.workers.set(key, w);
    w.send(job);
  }

  /** Stops the least recently used worker that has nothing to do. */
  retireIdle() {
    for (const w of this.workers.values()) {
      if (!w.pending.size) { this.retire(w); return true; }
    }
    return false;
  }

  retire(w) {
    w.terminate();
    if (this.workers.get(w.key) === w) this.workers.delete(w.key);
  }

  workerFree() {
    if (!this.queue.length) return;
    const waiting = this.queue;
    this.queue = [];
    for (const [key, job] of waiting) this.dispatch(key, job);
  }
}

let engineInstance = null;
export const engine = () => (engineInstance ||= new ScriptEngine());

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const listeners = new Set();

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

function writeAll(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export const scriptStore = {
  list() { return readAll(); },
  get(id) { return readAll().find((s) => s.id === id) || null; },
  /** `community` ({ id, updated, author, issue }) marks a copy installed from the community library. */
  save({ id, name, code, community }) {
    const list = readAll();
    const now = Date.now();
    let s = id && list.find((x) => x.id === id);
    if (s) Object.assign(s, { name, code, updated: now }, community ? { community } : {});
    else { s = { id: id || uid(), name, code, created: now, updated: now, ...(community ? { community } : {}) }; list.push(s); }
    writeAll(list);
    listeners.forEach((fn) => fn(s.id));
    return s.id;
  },
  remove(id) {
    writeAll(readAll().filter((s) => s.id !== id));
    listeners.forEach((fn) => fn(id));
  },
  /** fn(scriptId) is called whenever a script is saved or deleted (also from other windows). */
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

// Keep other windows (pop-outs) in sync.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) listeners.forEach((fn) => fn(null));
});

// ---------------------------------------------------------------------------
// Starter templates
// ---------------------------------------------------------------------------

export const TEMPLATES = [
  {
    name: 'Blank indicator',
    code: `// Your indicator. Save with Ctrl+S, put it on the chart with Ctrl+Enter.
indicator('My indicator', { overlay: true });

const length = input('Length', 20, { min: 1 });

plot(ta.sma(close, length), { title: 'SMA', color: '#4FA3F7' });
`,
  },
  {
    name: 'EMA crossover signals',
    code: `// Two EMAs with a shaded gap and buy/sell markers where they cross.
indicator('EMA Cross Signals', { overlay: true });

const fastLength = input('Fast EMA', 9, { min: 1 });
const slowLength = input('Slow EMA', 21, { min: 1 });

const fast = ta.ema(close, fastLength);
const slow = ta.ema(close, slowLength);

const a = plot(fast, { title: 'Fast', color: '#00BCD4' });
const b = plot(slow, { title: 'Slow', color: '#FF9800' });
fill(a, b, { color: 'rgba(0, 188, 212, 0.08)' });

marker(ta.crossover(fast, slow), { position: 'below', shape: 'up', color: '#34B886', text: 'Buy' });
marker(ta.crossunder(fast, slow), { position: 'above', shape: 'down', color: '#EC5246', text: 'Sell' });
`,
  },
  {
    name: 'RSI with colored zones',
    code: `// RSI in its own pane; the line turns red when overbought and green when oversold.
indicator('RSI Zones', { overlay: false, precision: 1 });

const length = input('Length', 14, { min: 2 });
const upper = input('Overbought', 70);
const lower = input('Oversold', 30);

const r = ta.rsi(close, length);
plot(r, {
  title: 'RSI',
  color: r.map((v) => (v > upper ? '#EC5246' : v < lower ? '#34B886' : '#7E57C2')),
});
hline(upper);
hline(lower);
fill(upper, lower, { color: 'rgba(126, 87, 194, 0.08)' });
`,
  },
  {
    name: 'Volume spikes',
    code: `// Marks bars whose volume is far above its recent average.
indicator('Volume Spikes', { overlay: true });

const length = input('Average length', 20, { min: 1 });
const multiple = input('Spike multiple', 2.5, { min: 1, step: 0.1 });

const average = ta.sma(volume, length);
const spike = volume.map((v, i) => v > average[i] * multiple);

marker(spike.map((s, i) => s && close[i] >= open[i]), { position: 'below', shape: 'circle', color: '#34B886' });
marker(spike.map((s, i) => s && close[i] < open[i]), { position: 'above', shape: 'circle', color: '#EC5246' });
`,
  },
  {
    name: 'MACD histogram (4 colors)',
    code: `// MACD with a histogram colored by direction and whether it is growing or fading.
indicator('MACD Colors', { overlay: false });

const { macd, signal, hist } = ta.macd(close, input('Fast', 12), input('Slow', 26), input('Signal', 9));

plot(hist, {
  title: 'Histogram',
  style: 'histogram',
  color: hist.map((h, i) => (h >= 0
    ? (h >= hist[i - 1] ? '#26A69A' : '#B2DFDB')
    : (h <= hist[i - 1] ? '#FF5252' : '#FFCDD2'))),
});
plot(macd, { title: 'MACD', color: '#4FA3F7' });
plot(signal, { title: 'Signal', color: '#FF6D00' });
hline(0);
`,
  },
  {
    name: 'Strategy: EMA cross (long & short)',
    code: `// Goes long when the fast EMA crosses above the slow one and short when it crosses below,
// with a stop loss and a take profit on every trade. Results appear in the Strategy tester.
strategy('EMA Cross Strategy', { capital: 10000, size: { percent: 100 }, commission: 0.1 });

const fastLength = input('Fast EMA', 12, { min: 1 });
const slowLength = input('Slow EMA', 26, { min: 1 });
const stopLoss = input('Stop loss %', 3, { min: 0, step: 0.5 });
const takeProfit = input('Take profit %', 6, { min: 0, step: 0.5 });

const fast = ta.ema(close, fastLength);
const slow = ta.ema(close, slowLength);
plot(fast, { title: 'Fast', color: '#00BCD4' });
plot(slow, { title: 'Slow', color: '#FF9800' });

strategy.entry('Long', 'long', ta.crossover(fast, slow));
strategy.entry('Short', 'short', ta.crossunder(fast, slow));
strategy.exit({ stopLoss, takeProfit });
`,
  },
  {
    name: 'Strategy: RSI mean reversion (long only)',
    code: `// Buys when RSI climbs back above the oversold level and sells when it reaches the exit level.
strategy('RSI Mean Reversion', { overlay: false, commission: 0.1 });

const length = input('RSI length', 14, { min: 2 });
const oversold = input('Buy when RSI crosses above', 30);
const exitLevel = input('Sell when RSI reaches', 60);
const stopLoss = input('Stop loss %', 8, { min: 0, step: 0.5 });

const r = ta.rsi(close, length);
plot(r, { title: 'RSI', color: '#7E57C2' });
hline(oversold);
hline(exitLevel);

strategy.entry('Buy', 'long', ta.crossover(r, oversold));
strategy.close('Buy', r.map((v) => v >= exitLevel));
strategy.exit({ stopLoss });
`,
  },
  {
    name: 'Strategy: breakout with trailing stop',
    code: `// Buys a breakout above the highest high of the last N bars and rides it with a trailing stop.
strategy('Breakout + Trailing Stop', { commission: 0.1 });

const length = input('Breakout lookback', 20, { min: 2 });
const trail = input('Trailing stop %', 4, { min: 0.5, step: 0.5 });

// Range of the previous N bars (not including the current one).
const upper = ta.shift(ta.highest(high, length), 1);
const lower = ta.shift(ta.lowest(low, length), 1);
plot(upper, { title: 'Upper', color: '#34B886', style: 'step' });
plot(lower, { title: 'Lower', color: '#EC5246', style: 'step' });

// Enter only on the bar the signal starts: a signal that stays true would stack entries when Pyramiding is raised.
const breakout = close.map((c, i) => c > upper[i]);
strategy.entry('Breakout', 'long', breakout.map((x, i) => x && !breakout[i - 1]));
strategy.close('Breakout', close.map((c, i) => c < lower[i]));
strategy.exit({ trailing: trail });
`,
  },
  {
    name: 'Strategy: Supertrend with time stop (onBar)',
    code: `// Enters when Supertrend turns up and exits when it turns down or after a maximum number of bars.
// It uses strategy.onBar, which runs once per bar, for logic that depends on the open position.
strategy('Supertrend + Time Stop', { commission: 0.1 });

const factor = input('Factor', 3, { min: 0.5, step: 0.5 });
const atrLength = input('ATR length', 10, { min: 1 });
const maxBars = input('Max bars in a trade', 30, { min: 1 });

const st = ta.supertrend(factor, atrLength);
plot(st.value, { title: 'Supertrend', color: st.direction.map((d) => (d === 1 ? '#34B886' : '#EC5246')) });

strategy.onBar((i, s) => {
  const turnedUp = st.direction[i] === 1 && st.direction[i - 1] === -1;
  const turnedDown = st.direction[i] === -1 && st.direction[i - 1] === 1;
  if (!s.position.side && turnedUp) s.long('Trend');
  if (s.position.side === 'long' && (turnedDown || s.position.barsInTrade >= maxBars)) s.close();
});
`,
  },
  {
    name: 'Strategy: Golden cross (50/200 SMA)',
    code: `// The classic long-term trend signal: be long while the 50-period SMA is above the 200,
// and step aside when it falls back below.
strategy('Golden Cross', { commission: 0.1 });

const fastLength = input('Fast SMA', 50, { min: 1 });
const slowLength = input('Slow SMA', 200, { min: 2 });

const fast = ta.sma(close, fastLength);
const slow = ta.sma(close, slowLength);
plot(fast, { title: 'Fast SMA', color: '#FFB300' });
plot(slow, { title: 'Slow SMA', color: '#7E57C2', width: 2 });

// Enter only on the bar the signal starts: a signal that stays true would stack entries when Pyramiding is raised.
const above = fast.map((f, i) => f > slow[i]);
strategy.entry('Long', 'long', above.map((x, i) => x && !above[i - 1]));
strategy.close('Long', fast.map((f, i) => f < slow[i]));
`,
  },
  {
    name: 'Strategy: MACD cross with trend filter',
    code: `// Trades MACD signal-line crosses, but only in the direction of the long-term trend:
// longs above the 200 EMA, shorts below it. Every trade has a stop loss and a take profit.
strategy('MACD + Trend Filter', { commission: 0.1 });

const trendLength = input('Trend EMA', 200, { min: 2 });
const fastLength = input('MACD fast', 12, { min: 1 });
const slowLength = input('MACD slow', 26, { min: 2 });
const signalLength = input('MACD signal', 9, { min: 1 });
const stopLoss = input('Stop loss %', 3, { min: 0, step: 0.5 });
const takeProfit = input('Take profit %', 6, { min: 0, step: 0.5 });

const trend = ta.ema(close, trendLength);
const { macd, signal } = ta.macd(close, fastLength, slowLength, signalLength);
plot(trend, { title: 'Trend EMA', color: '#FF9800', width: 2 });

const crossUp = ta.crossover(macd, signal);
const crossDown = ta.crossunder(macd, signal);
const aboveTrend = close.map((c, i) => c > trend[i]);
const belowTrend = close.map((c, i) => c < trend[i]);

strategy.entry('Long', 'long', crossUp.map((x, i) => x && aboveTrend[i]));
strategy.entry('Short', 'short', crossDown.map((x, i) => x && belowTrend[i]));
strategy.close('Long', crossDown);
strategy.close('Short', crossUp);
strategy.exit({ stopLoss, takeProfit });
`,
  },
  {
    name: 'Strategy: Bollinger Bands mean reversion',
    code: `// Buys when price closes back above the lower Bollinger Band (a stretched move snapping back)
// and sells when it reaches the middle band.
strategy('Bollinger Mean Reversion', { commission: 0.1 });

const length = input('Length', 20, { min: 2 });
const mult = input('StdDev', 2, { min: 0.5, step: 0.1 });
const stopLoss = input('Stop loss %', 5, { min: 0, step: 0.5 });

const { upper, basis, lower } = ta.bb(close, length, mult);
const a = plot(upper, { title: 'Upper', color: '#4FA3F7' });
plot(basis, { title: 'Basis', color: '#FF6D00' });
const b = plot(lower, { title: 'Lower', color: '#4FA3F7' });
fill(a, b, { color: 'rgba(79, 163, 247, 0.06)' });

strategy.entry('Long', 'long', ta.crossover(close, lower));
strategy.close('Long', close.map((c, i) => c >= basis[i]));
strategy.exit({ stopLoss });
`,
  },
  {
    name: 'Strategy: Turtle breakout (Donchian)',
    code: `// The Turtle traders' rules: buy a 20-bar high, sell a 10-bar low,
// and get out if price closes 2 ATRs below the entry.
strategy('Turtle Breakout', { commission: 0.1 });

const entryLength = input('Entry: highest high of', 20, { min: 2 });
const exitLength = input('Exit: lowest low of', 10, { min: 2 });
const atrMult = input('Stop (x ATR)', 2, { min: 0.5, step: 0.5 });

// Channels of the previous bars (not including the current one).
const upper = ta.shift(ta.highest(high, entryLength), 1);
const lower = ta.shift(ta.lowest(low, exitLength), 1);
const atr = ta.atr(20);
plot(upper, { title: 'Entry channel', color: '#34B886', style: 'step' });
plot(lower, { title: 'Exit channel', color: '#EC5246', style: 'step' });

// Enter only on the bar the signal starts: a signal that stays true would stack entries when Pyramiding is raised.
const breakout = close.map((c, i) => c > upper[i]);
strategy.entry('Long', 'long', breakout.map((x, i) => x && !breakout[i - 1]));
strategy.close('Long', close.map((c, i) => c < lower[i]));
strategy.onBar((i, s) => {
  if (s.position.side === 'long' && close[i] < s.position.avgPrice - atrMult * atr[i]) s.close('Long', { comment: 'ATR stop' });
});
`,
  },
  {
    name: 'Strategy: RSI(2) pullback in an uptrend',
    code: `// A short-term pullback system: when price is above its 200 SMA (an uptrend), buy when the
// 2-period RSI is deeply oversold, and sell as soon as price closes above its 5 SMA.
strategy('RSI(2) Pullback', { commission: 0.05 });

const rsiLength = input('RSI length', 2, { min: 2 });
const buyBelow = input('Buy when RSI below', 10, { min: 1, max: 50 });
const trendLength = input('Trend SMA', 200, { min: 2 });
const exitLength = input('Exit SMA', 5, { min: 2 });

const r = ta.rsi(close, rsiLength);
const trend = ta.sma(close, trendLength);
const exitMa = ta.sma(close, exitLength);
plot(trend, { title: 'Trend SMA', color: '#7E57C2', width: 2 });
plot(exitMa, { title: 'Exit SMA', color: '#00BCD4' });

// Enter only on the bar the signal starts: a signal that stays true would stack entries when Pyramiding is raised.
const setup = close.map((c, i) => c > trend[i] && r[i] < buyBelow);
strategy.entry('Long', 'long', setup.map((x, i) => x && !setup[i - 1]));
strategy.close('Long', close.map((c, i) => c > exitMa[i]));
`,
  },
  {
    name: 'Strategy: Supertrend with ADX filter',
    code: `// Follows Supertrend flips both ways, but only opens a trade when ADX says the market is
// actually trending (above the threshold). A flip the other way closes the trade.
strategy('Supertrend + ADX', { commission: 0.1 });

const factor = input('Factor', 3, { min: 0.5, step: 0.5 });
const atrLength = input('ATR length', 10, { min: 1 });
const adxLength = input('ADX length', 14, { min: 2 });
const minAdx = input('Trade when ADX above', 20, { min: 0 });

const st = ta.supertrend(factor, atrLength);
const { adx } = ta.dmi(adxLength, adxLength);
plot(st.value, { title: 'Supertrend', color: st.direction.map((d) => (d === 1 ? '#34B886' : '#EC5246')) });

const turnedUp = st.direction.map((d, i) => d === 1 && st.direction[i - 1] === -1);
const turnedDown = st.direction.map((d, i) => d === -1 && st.direction[i - 1] === 1);
const trending = adx.map((v) => v > minAdx);

strategy.entry('Long', 'long', turnedUp.map((x, i) => x && trending[i]));
strategy.entry('Short', 'short', turnedDown.map((x, i) => x && trending[i]));
strategy.close('Long', turnedDown);
strategy.close('Short', turnedUp);
`,
  },
  {
    name: 'Strategy: Parabolic SAR flip',
    code: `// Always in the market: long while price is above the Parabolic SAR, short while it is below.
strategy('Parabolic SAR Flip', { commission: 0.1 });

const start = input('Start', 0.02, { min: 0.001, step: 0.01 });
const increment = input('Increment', 0.02, { min: 0.001, step: 0.01 });
const maximum = input('Maximum', 0.2, { min: 0.01, step: 0.05 });

// dir is 1 while the SAR is below price (uptrend) and -1 while it is above.
const { sar, dir } = ta.psar(start, increment, maximum);
plot(sar, { title: 'SAR', style: 'dots', color: dir.map((d) => (d === 1 ? '#34B886' : '#EC5246')) });

strategy.entry('Long', 'long', dir.map((d, i) => d === 1 && dir[i - 1] === -1));
strategy.entry('Short', 'short', dir.map((d, i) => d === -1 && dir[i - 1] === 1));
`,
  },
  {
    name: 'Strategy: Stochastic pullback',
    code: `// Buys when the Stochastic turns up from oversold while price is above its 200 EMA,
// and sells when the Stochastic reaches overbought (or on the stop loss).
strategy('Stochastic Pullback', { overlay: false, commission: 0.1 });

const kLength = input('%K length', 14, { min: 1 });
const smooth = input('%K smoothing', 3, { min: 1 });
const dLength = input('%D length', 3, { min: 1 });
const trendLength = input('Trend EMA', 200, { min: 2 });
const oversold = input('Oversold', 20);
const overbought = input('Overbought', 80);
const stopLoss = input('Stop loss %', 4, { min: 0, step: 0.5 });

const k = ta.sma(ta.stoch(close, high, low, kLength), smooth);
const d = ta.sma(k, dLength);
const trend = ta.ema(close, trendLength);
plot(k, { title: '%K', color: '#4FA3F7' });
plot(d, { title: '%D', color: '#FF9800' });
hline(overbought);
hline(oversold);
fill(overbought, oversold, { color: 'rgba(79, 163, 247, 0.06)' });

// %K crossing back above %D, with the Stochastic oversold in the last few bars.
const turnUp = ta.crossover(k, d);
const wasOversold = ta.lowest(k, 5).map((v) => v < oversold);
strategy.entry('Long', 'long', turnUp.map((x, i) => x && wasOversold[i] && close[i] > trend[i]));
strategy.close('Long', k.map((v) => v > overbought));
strategy.exit({ stopLoss });
`,
  },
  {
    name: 'Strategy: Bollinger squeeze breakout',
    code: `// Volatility comes in waves: when the Bollinger Bands get as narrow as they have been in a
// while (a squeeze), trade the first close outside the bands, and ride it with a trailing stop.
strategy('Squeeze Breakout', { commission: 0.1 });

const length = input('Length', 20, { min: 2 });
const mult = input('StdDev', 2, { min: 0.5, step: 0.1 });
const lookback = input('Squeeze: narrowest in (bars)', 60, { min: 5 });
const window = input('Breakout within (bars)', 10, { min: 1 });
const trail = input('Trailing stop %', 3, { min: 0.5, step: 0.5 });

const { upper, basis, lower } = ta.bb(close, length, mult);
const width = upper.map((u, i) => (u - lower[i]) / basis[i]);
const narrowest = ta.lowest(width, lookback);
// 1 on bars where the bands were (within 5% of) their narrowest, then "was there one recently?"
const squeeze = width.map((w, i) => (w <= narrowest[i] * 1.05 ? 1 : 0));
const recentSqueeze = ta.highest(squeeze, window);

const a = plot(upper, { title: 'Upper', color: '#4FA3F7' });
plot(basis, { title: 'Basis', color: '#8E8A82' });
const b = plot(lower, { title: 'Lower', color: '#4FA3F7' });
fill(a, b, { color: 'rgba(79, 163, 247, 0.06)' });
marker(squeeze.map((s, i) => s && !squeeze[i - 1]), { position: 'below', shape: 'circle', color: '#FFB300' });

// Enter only on the bar the signal starts: a signal that stays true would stack entries when Pyramiding is raised.
const up = close.map((c, i) => c > upper[i] && recentSqueeze[i] === 1);
const down = close.map((c, i) => c < lower[i] && recentSqueeze[i] === 1);
strategy.entry('Long', 'long', up.map((x, i) => x && !up[i - 1]));
strategy.entry('Short', 'short', down.map((x, i) => x && !down[i - 1]));
strategy.exit({ trailing: trail });
`,
  },
  {
    name: 'Daily range breakout',
    code: `// Highest high and lowest low of the last N bars, with markers on breakouts.
indicator('Range Breakout', { overlay: true });

const length = input('Lookback', 20, { min: 2 });
const showMarkers = input('Show markers', true);

// Range of the previous N bars (excluding the current one).
const top = ta.shift(ta.highest(high, length), 1);
const bottom = ta.shift(ta.lowest(low, length), 1);

const a = plot(top, { title: 'Range high', color: '#34B886', style: 'step' });
const b = plot(bottom, { title: 'Range low', color: '#EC5246', style: 'step' });
fill(a, b, { color: 'rgba(120, 123, 134, 0.06)' });

if (showMarkers) {
  marker(close.map((c, i) => c > top[i] && close[i - 1] <= top[i - 1]), { position: 'below', shape: 'up', color: '#34B886' });
  marker(close.map((c, i) => c < bottom[i] && close[i - 1] >= bottom[i - 1]), { position: 'above', shape: 'down', color: '#EC5246' });
}
`,
  },
];
