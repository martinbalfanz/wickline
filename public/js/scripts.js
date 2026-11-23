// User indicator scripts: storage, starter templates, and the engine that runs them in a worker.

import { uid } from './util.js';
import { RS_LEADER_SCRIPT } from './rs-leader.js';

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

class ScriptEngine {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(new URL('./script-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.ok) p.resolve({ ...data.result, ms: data.ms });
      else p.reject(new ScriptError(data.error, { line: data.line, logs: data.logs }));
    };
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this.restart(new ScriptError(`Script engine error: ${e.message || 'unknown'}`, { restarted: true }));
    };
  }

  restart(reason) {
    try { this.worker.terminate(); } catch { /* ignore */ }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear();
    this.spawn();
  }

  /** Runs a script over bars. Resolves with { meta, inputs, plots, hlines, fills, markers, consts, logs, ms }. */
  run(code, bars, inputs = {}, ctx = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const data = packBars(bars);
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new ScriptError(`Stopped: the script ran longer than ${TIMEOUT_MS / 1000} seconds (an endless loop?)`));
        // Other scripts waiting on the stopped worker are retried by their charts.
        this.restart(new ScriptError('Script engine restarted', { restarted: true }));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, code, data, inputs, ctx }, Object.values(data).map((a) => a.buffer));
    });
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
  save({ id, name, code }) {
    const list = readAll();
    const now = Date.now();
    let s = id && list.find((x) => x.id === id);
    if (s) Object.assign(s, { name, code, updated: now });
    else { s = { id: id || uid(), name, code, created: now, updated: now }; list.push(s); }
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
  { name: 'MB RS Leader vs SPY', code: RS_LEADER_SCRIPT },
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

strategy.entry('Breakout', 'long', close.map((c, i) => c > upper[i]));
strategy.close('Breakout', close.map((c, i) => c < lower[i]));
strategy.exit({ trailing: trail });
`,
  },
  {
    name: 'Strategy: Supertrend with time stop (onBar)',
    code: `// strategy.onBar runs once per bar, for logic that depends on the open position:
// enter when Supertrend turns up; exit when it turns down or after a maximum number of bars.
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
