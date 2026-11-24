// Technical indicators.
// Every calc(bars, params, ctx) returns arrays aligned 1:1 with the bars; NaN = no value (a gap).
// The math helpers are also exported as `ta` for user scripts (see script-worker.js).

import { withAlpha } from './util.js';
import { t } from './i18n.js';

const isNum = Number.isFinite;
const DAY = 86400;

// Candle colors of the current theme (live bindings: importers see updates).
export let UP = '#2EBD85';
export let DOWN = '#F6465D';
export function setTrendColors(up, down) { UP = up; DOWN = down; }
const alpha = withAlpha;
export const PALETTE = ['#4FA3F7', '#FF9800', '#E040FB', '#00BCD4', '#FFEB3B', '#4CAF50', '#F06292', '#8D6E63'];

// ---------------------------------------------------------------------------
// Math helpers (all take/return plain arrays)
// ---------------------------------------------------------------------------

const nanArray = (n) => new Array(n).fill(NaN);
const pick = (bars, key) => bars.map((b) => b[key]);

export const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];
export function source(bars, name = 'close') {
  switch (name) {
    case 'hl2': return bars.map((b) => (b.high + b.low) / 2);
    case 'hlc3': return bars.map((b) => (b.high + b.low + b.close) / 3);
    case 'ohlc4': return bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
    case 'open': case 'high': case 'low': case 'volume': return pick(bars, name);
    default: return pick(bars, 'close');
  }
}

export function sma(src, len) {
  const out = nanArray(src.length);
  let sum = 0, count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) { sum = 0; count = 0; continue; }
    sum += v; count++;
    if (count > len) { sum -= src[i - len]; count = len; }
    if (count === len) out[i] = sum / len;
  }
  return out;
}

/** Exponential average seeded with an SMA. alpha defaults to 2/(len+1); 1/len gives Wilder's RMA. */
export function ema(src, len, alpha = 2 / (len + 1)) {
  const out = nanArray(src.length);
  let prev = NaN, sum = 0, count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) continue;
    if (!isNum(prev)) {
      sum += v; count++;
      if (count === len) { prev = sum / len; out[i] = prev; }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export const rma = (src, len) => ema(src, len, 1 / len);

export function wma(src, len) {
  const out = nanArray(src.length);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const v = src[i - j];
      if (!isNum(v)) { ok = false; break; }
      s += v * (len - j);
    }
    if (ok) out[i] = s / denom;
  }
  return out;
}

/** Rolling sum; NaN while the window holds a missing value. */
export function sum(src, len) {
  const out = nanArray(src.length);
  let s = 0, bad = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (isNum(v)) s += v; else bad++;
    if (i >= len) { const o = src[i - len]; if (isNum(o)) s -= o; else bad--; }
    if (i >= len - 1 && !bad) out[i] = s;
  }
  return out;
}

export function stdev(src, len) {
  const out = nanArray(src.length);
  let s = 0, sq = 0, bad = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (isNum(v)) { s += v; sq += v * v; } else bad++;
    if (i >= len) { const o = src[i - len]; if (isNum(o)) { s -= o; sq -= o * o; } else bad--; }
    if (i >= len - 1 && !bad) out[i] = Math.sqrt(Math.max(sq / len - (s / len) ** 2, 0));
  }
  return out;
}

/**
 * The highest (max) or lowest value of each window of len bars, skipping gaps; NaN before the
 * first full window and where a window has no values. O(n): a monotonic deque of indexes whose
 * front is the window's extreme (each index goes in and out once).
 */
function rollingExtreme(src, len, max) {
  const n = src.length;
  const out = nanArray(n);
  len = Number(len);
  if (!Number.isInteger(len) || len < 1) return out; // no whole window: nothing to report
  const q = new Int32Array(n); // indexes, oldest first; their values strictly decrease (max) / increase (min)
  let h = 0, t = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i];
    if (isNum(x)) {
      // Older values this one beats (or ties) can never be the extreme again.
      if (max) while (t > h && src[q[t - 1]] <= x) t--;
      else while (t > h && src[q[t - 1]] >= x) t--;
      q[t++] = i;
    }
    while (t > h && q[h] <= i - len) h++; // slid out of the window
    if (i >= len - 1 && t > h) out[i] = src[q[h]];
  }
  return out;
}
export const highest = (src, len) => rollingExtreme(src, len, true);
export const lowest = (src, len) => rollingExtreme(src, len, false);

/** Bars since the highest (or lowest) value within the last len+1 bars. */
function barsSinceExtreme(src, len, better) {
  const out = nanArray(src.length);
  for (let i = len; i < src.length; i++) {
    let best = src[i], at = 0;
    for (let j = 1; j <= len; j++) if (better(src[i - j], best)) { best = src[i - j]; at = j; }
    out[i] = at;
  }
  return out;
}

export const change = (src, len = 1) => src.map((v, i) => (i >= len ? v - src[i - len] : NaN));
export const mom = change;
export const roc = (src, len) => src.map((v, i) => (i >= len && src[i - len] ? (100 * (v - src[i - len])) / src[i - len] : NaN));

export function cum(src) {
  let s = 0;
  return src.map((v) => (s += isNum(v) ? v : 0));
}

export const shift = (src, k) => src.map((_, i) => (i - k >= 0 && i - k < src.length ? src[i - k] : NaN));

export function linreg(src, len, offset = 0) {
  const out = nanArray(src.length);
  const sx = (len * (len - 1)) / 2;
  const sxx = ((len - 1) * len * (2 * len - 1)) / 6;
  for (let i = len - 1; i < src.length; i++) {
    let sy = 0, sxy = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const y = src[i - len + 1 + j];
      if (!isNum(y)) { ok = false; break; }
      sy += y; sxy += j * y;
    }
    if (!ok) continue;
    const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx);
    const intercept = (sy - slope * sx) / len;
    out[i] = intercept + slope * (len - 1 - offset);
  }
  return out;
}

export function hma(src, len) {
  const half = wma(src, Math.max(1, Math.round(len / 2)));
  const full = wma(src, len);
  return wma(half.map((v, i) => 2 * v - full[i]), Math.max(1, Math.round(Math.sqrt(len))));
}

export function dema(src, len) {
  const e1 = ema(src, len), e2 = ema(e1, len);
  return e1.map((v, i) => 2 * v - e2[i]);
}

export function tema(src, len) {
  const e1 = ema(src, len), e2 = ema(e1, len), e3 = ema(e2, len);
  return e1.map((v, i) => 3 * v - 3 * e2[i] + e3[i]);
}

export function vwma(src, vol, len) {
  const num = sma(src.map((v, i) => v * vol[i]), len);
  const den = sma(vol, len);
  return num.map((v, i) => (den[i] ? v / den[i] : NaN));
}

export function alma(src, len, offset = 0.85, sigma = 6) {
  const out = nanArray(src.length);
  const m = offset * (len - 1), s = len / sigma;
  const w = Array.from({ length: len }, (_, j) => Math.exp(-((j - m) ** 2) / (2 * s * s)));
  const norm = w.reduce((a, b) => a + b, 0);
  for (let i = len - 1; i < src.length; i++) {
    let acc = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const v = src[i - len + 1 + j];
      if (!isNum(v)) { ok = false; break; }
      acc += v * w[j];
    }
    if (ok) out[i] = acc / norm;
  }
  return out;
}

export function rsi(src, len) {
  const gain = src.map((v, i) => (i === 0 ? NaN : Math.max(v - src[i - 1], 0)));
  const loss = src.map((v, i) => (i === 0 ? NaN : Math.max(src[i - 1] - v, 0)));
  const ag = rma(gain, len), al = rma(loss, len);
  return ag.map((g, i) => (!isNum(g) ? NaN : al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])));
}

export function macd(src, fast = 12, slow = 26, signal = 9) {
  const f = ema(src, fast), s = ema(src, slow);
  const m = f.map((v, i) => v - s[i]);
  const sig = ema(m, signal);
  return { macd: m, signal: sig, hist: m.map((v, i) => v - sig[i]) };
}

export function bb(src, len = 20, mult = 2) {
  const basis = sma(src, len), dev = stdev(src, len);
  return { basis, upper: basis.map((b, i) => b + mult * dev[i]), lower: basis.map((b, i) => b - mult * dev[i]) };
}

/** Raw stochastic %K of src within the high/low range of the last len bars. */
export function stoch(src, high, low, len) {
  const hh = highest(high, len), ll = lowest(low, len);
  return src.map((v, i) => (hh[i] === ll[i] ? 50 : (100 * (v - ll[i])) / (hh[i] - ll[i])));
}

export function cci(src, len) {
  const ma = sma(src, len);
  return src.map((v, i) => {
    if (!isNum(ma[i])) return NaN;
    let md = 0;
    for (let j = 0; j < len; j++) md += Math.abs(src[i - j] - ma[i]);
    md /= len;
    return md ? (v - ma[i]) / (0.015 * md) : 0;
  });
}

export function tr(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

export const atr = (bars, len) => rma(tr(bars), len);

export function mfi(bars, len) {
  const tp = source(bars, 'hlc3');
  const pos = tp.map((v, i) => (i > 0 && v > tp[i - 1] ? v * bars[i].volume : 0));
  const neg = tp.map((v, i) => (i > 0 && v < tp[i - 1] ? v * bars[i].volume : 0));
  const sp = sum(pos, len), sn = sum(neg, len);
  return sp.map((p, i) => (!isNum(p) ? NaN : sn[i] === 0 ? 100 : 100 - 100 / (1 + p / sn[i])));
}

export function obv(bars) {
  let s = 0;
  return bars.map((b, i) => (s += i === 0 ? 0 : Math.sign(b.close - bars[i - 1].close) * b.volume));
}

export function wpr(bars, len) {
  const hh = highest(pick(bars, 'high'), len), ll = lowest(pick(bars, 'low'), len);
  return bars.map((b, i) => (hh[i] === ll[i] ? -50 : (-100 * (hh[i] - b.close)) / (hh[i] - ll[i])));
}

export function dmi(bars, diLen = 14, adxLen = 14) {
  const plusDM = bars.map((b, i) => {
    if (i === 0) return NaN;
    const up = b.high - bars[i - 1].high, down = bars[i - 1].low - b.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDM = bars.map((b, i) => {
    if (i === 0) return NaN;
    const up = b.high - bars[i - 1].high, down = bars[i - 1].low - b.low;
    return down > up && down > 0 ? down : 0;
  });
  const trur = rma(tr(bars), diLen);
  const plus = rma(plusDM, diLen).map((v, i) => (100 * v) / trur[i]);
  const minus = rma(minusDM, diLen).map((v, i) => (100 * v) / trur[i]);
  const dx = plus.map((p, i) => { const s = p + minus[i]; return Math.abs(p - minus[i]) / (s === 0 ? 1 : s); });
  return { plus, minus, adx: rma(dx, adxLen).map((v) => 100 * v) };
}

export function supertrend(bars, factor = 3, len = 10) {
  const a = atr(bars, len);
  const value = nanArray(bars.length), direction = nanArray(bars.length);
  let fu = NaN, fl = NaN, dir = 1;
  for (let i = 0; i < bars.length; i++) {
    if (!isNum(a[i])) continue;
    const b = bars[i];
    const hl2 = (b.high + b.low) / 2;
    const bu = hl2 + factor * a[i], bl = hl2 - factor * a[i];
    const pc = i > 0 ? bars[i - 1].close : b.close;
    const nfu = !isNum(fu) || bu < fu || pc > fu ? bu : fu;
    const nfl = !isNum(fl) || bl > fl || pc < fl ? bl : fl;
    if (isNum(fu)) {
      if (dir === -1 && b.close > nfu) dir = 1;
      else if (dir === 1 && b.close < nfl) dir = -1;
    }
    fu = nfu; fl = nfl;
    value[i] = dir === 1 ? fl : fu;
    direction[i] = dir;
  }
  return { value, direction };
}

/** VWAP that restarts every day (bar times are in exchange/local time). */
export function vwap(bars) {
  const out = nanArray(bars.length);
  let day = null, pv = 0, vol = 0;
  bars.forEach((b, i) => {
    const d = Math.floor(b.time / DAY);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume; vol += b.volume;
    out[i] = vol > 0 ? pv / vol : tp;
  });
  return out;
}

export function psar(bars, start = 0.02, inc = 0.02, max = 0.2) {
  const n = bars.length;
  const out = nanArray(n), dir = nanArray(n);
  if (n < 2) return { sar: out, dir };
  let up = bars[1].close >= bars[0].close;
  let ep = up ? bars[0].high : bars[0].low;
  let sar = up ? bars[0].low : bars[0].high;
  let af = start;
  for (let i = 1; i < n; i++) {
    const b = bars[i], p1 = bars[i - 1], p2 = bars[Math.max(0, i - 2)];
    sar += af * (ep - sar);
    if (up) {
      sar = Math.min(sar, p1.low, p2.low);
      if (b.low < sar) { up = false; sar = ep; ep = b.low; af = start; }
      else if (b.high > ep) { ep = b.high; af = Math.min(af + inc, max); }
    } else {
      sar = Math.max(sar, p1.high, p2.high);
      if (b.high > sar) { up = true; sar = ep; ep = b.high; af = start; }
      else if (b.low < ep) { ep = b.low; af = Math.min(af + inc, max); }
    }
    out[i] = sar;
    dir[i] = up ? 1 : -1;
  }
  return { sar: out, dir };
}

export const crossover = (a, b) => a.map((v, i) => {
  const bv = Array.isArray(b) ? b[i] : b, bp = Array.isArray(b) ? b[i - 1] : b;
  return i > 0 && v > bv && a[i - 1] <= bp;
});
export const crossunder = (a, b) => a.map((v, i) => {
  const bv = Array.isArray(b) ? b[i] : b, bp = Array.isArray(b) ? b[i - 1] : b;
  return i > 0 && v < bv && a[i - 1] >= bp;
});
export const cross = (a, b) => crossover(a, b).map((x, i) => x || crossunder(a, b)[i]);

/** Price at pivot-high bars (higher than `left` bars before and `right` bars after), NaN elsewhere. */
export function pivothigh(src, left = 5, right = 5) {
  return src.map((v, i) => {
    if (i < left || i + right >= src.length) return NaN;
    for (let j = 1; j <= left; j++) if (!(v > src[i - j])) return NaN;
    for (let j = 1; j <= right; j++) if (!(v >= src[i + j])) return NaN;
    return v;
  });
}
export function pivotlow(src, left = 5, right = 5) {
  return src.map((v, i) => {
    if (i < left || i + right >= src.length) return NaN;
    for (let j = 1; j <= left; j++) if (!(v < src[i - j])) return NaN;
    for (let j = 1; j <= right; j++) if (!(v <= src[i + j])) return NaN;
    return v;
  });
}

// --- more averages, oscillators and bar-based studies --------------------------------

/** highest/lowest of a derived series: NaN until the whole window holds values. */
const fullWindow = (out, src, len) => out.map((v, i) => (i >= len - 1 && isNum(src[i - len + 1]) ? v : NaN));
/** Symmetric 4-bar weighted average (1, 2, 2, 1) / 6. */
const swma = (src) => src.map((v, i) => (i >= 3 ? (v + 2 * src[i - 1] + 2 * src[i - 2] + src[i - 3]) / 6 : NaN));
/** Up and down parts of a change series, NaN where the change is missing. */
const ups = (ch) => ch.map((v) => (isNum(v) ? Math.max(v, 0) : NaN));
const downs = (ch) => ch.map((v) => (isNum(v) ? Math.max(-v, 0) : NaN));

/** Kaufman's efficiency ratio: net change over the sum of bar-to-bar changes, 0–1. */
export function er(src, len = 10) {
  const net = change(src, len), path = sum(change(src).map(Math.abs), len);
  return net.map((d, i) => (!isNum(d) || !isNum(path[i]) ? NaN : path[i] ? Math.abs(d) / path[i] : 0));
}

/** Kaufman Adaptive Moving Average; seeded with the close before the first full window. */
export function kama(src, len = 10, fast = 2, slow = 30) {
  const e = er(src, len), f = 2 / (fast + 1), s = 2 / (slow + 1);
  const out = nanArray(src.length);
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    if (!isNum(e[i])) continue;
    if (!isNum(prev)) prev = src[i - 1];
    prev += (e[i] * (f - s) + s) ** 2 * (src[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** Zero-lag EMA: EMA of 2 × price − price (len − 1) / 2 bars ago. */
export function zlema(src, len = 20) {
  const lag = Math.floor((len - 1) / 2);
  return ema(src.map((v, i) => (i >= lag ? 2 * v - src[i - lag] : NaN)), len);
}

/** Tillson T3: six chained EMAs combined with the volume factor. */
export function t3(src, len = 5, v = 0.7) {
  const e1 = ema(src, len), e2 = ema(e1, len), e3 = ema(e2, len), e4 = ema(e3, len), e5 = ema(e4, len), e6 = ema(e5, len);
  const c1 = -(v ** 3), c2 = 3 * v * v + 3 * v ** 3, c3 = -6 * v * v - 3 * v - 3 * v ** 3, c4 = 1 + 3 * v + v ** 3 + 3 * v * v;
  return e6.map((x, i) => c1 * x + c2 * e5[i] + c3 * e4[i] + c4 * e3[i]);
}

/** McGinley Dynamic, seeded with an SMA; a step never overshoots the price. */
export function mcginley(src, len = 14) {
  const out = nanArray(src.length), seed = sma(src, len);
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) continue;
    if (!isNum(prev)) { if (isNum(seed[i])) out[i] = prev = seed[i]; continue; }
    const d = len * (prev ? v / prev : NaN) ** 4;
    prev += (d > 0 && isNum(d) ? Math.min(1, 1 / d) : 1) * (v - prev);
    out[i] = prev;
  }
  return out;
}

/** Chande's VIDYA: an EMA whose speed scales with the absolute CMO; seeded with an SMA. */
export function vidya(src, len = 9, cmoLen = 9) {
  const ch = change(src), up = sum(ups(ch), cmoLen), dn = sum(downs(ch), cmoLen);
  const out = nanArray(src.length), seed = sma(src, len), a = 2 / (len + 1);
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    if (!isNum(up[i]) || !isNum(src[i])) continue;
    const k = up[i] + dn[i] ? Math.abs(up[i] - dn[i]) / (up[i] + dn[i]) : 0;
    if (!isNum(prev)) { if (isNum(seed[i])) out[i] = prev = seed[i]; continue; }
    prev += a * k * (src[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** Triangular moving average (an SMA of an SMA). */
export const trima = (src, len = 20) => sma(sma(src, Math.floor(len / 2) + 1), Math.ceil(len / 2));

/** Least-squares line over each window: end value, slope per bar and standard error. */
function regression(src, len) {
  const n = src.length, value = nanArray(n), slope = nanArray(n), se = nanArray(n);
  if (len < 2) return { value, slope, se };
  const sx = (len * (len - 1)) / 2, sxx = ((len - 1) * len * (2 * len - 1)) / 6, den = len * sxx - sx * sx;
  for (let i = len - 1; i < n; i++) {
    const ref = src[i]; // centre on the last value for precision
    let sy = 0, syy = 0, sxy = 0, ok = isNum(ref);
    for (let j = 0; j < len && ok; j++) {
      const y = src[i - len + 1 + j] - ref;
      if (!isNum(y)) { ok = false; break; }
      sy += y; syy += y * y; sxy += j * y;
    }
    if (!ok) continue;
    const b = (len * sxy - sx * sy) / den, a = (sy - b * sx) / len;
    value[i] = ref + a + b * (len - 1);
    slope[i] = b;
    if (len > 2) se[i] = Math.sqrt(Math.max(syy - a * sy - b * sxy, 0) / (len - 2));
  }
  return { value, slope, se };
}
export const linregSlope = (src, len = 20) => regression(src, len).slope;

/** Standard error bands: linear regression ± mult × standard error, both smoothed by an SMA. */
export function stderrBands(src, len = 21, mult = 2, smooth = 3) {
  const { value, se } = regression(src, len);
  return {
    basis: sma(value, smooth),
    upper: sma(value.map((v, i) => v + mult * se[i]), smooth),
    lower: sma(value.map((v, i) => v - mult * se[i]), smooth),
  };
}

/** Percentage price oscillator: MACD as a percent of the slow EMA. */
export function ppo(src, fast = 12, slow = 26, signal = 9) {
  const f = ema(src, fast), s = ema(src, slow);
  const p = f.map((v, i) => (s[i] ? (100 * (v - s[i])) / s[i] : NaN));
  const sig = ema(p, signal);
  return { ppo: p, signal: sig, hist: p.map((v, i) => v - sig[i]) };
}

/** Pring's Know Sure Thing: weighted sum of four smoothed ROCs, with an SMA signal. */
export function kst(src, r1 = 10, r2 = 15, r3 = 20, r4 = 30, s1 = 10, s2 = 10, s3 = 10, s4 = 15, signal = 9) {
  const a = sma(roc(src, r1), s1), b = sma(roc(src, r2), s2), c = sma(roc(src, r3), s3), d = sma(roc(src, r4), s4);
  const k = a.map((v, i) => v + 2 * b[i] + 3 * c[i] + 4 * d[i]);
  return { kst: k, signal: sma(k, signal) };
}

/** Schaff Trend Cycle: a MACD put through two smoothed stochastics, 0–100. */
export function stc(src, len = 10, fast = 23, slow = 50, factor = 0.5) {
  const es = ema(src, slow), m = ema(src, fast).map((v, i) => v - es[i]);
  const stage = (x) => {
    const lo = lowest(x, len), hi = highest(x, len), out = nanArray(x.length);
    let f = NaN, pf = NaN;
    for (let i = 0; i < x.length; i++) {
      if (!isNum(x[i]) || !isNum(x[i - len + 1])) continue;
      const r = hi[i] - lo[i];
      if (r > 0) f = (100 * (x[i] - lo[i])) / r;
      if (!isNum(f)) continue;
      pf = isNum(pf) ? pf + factor * (f - pf) : f;
      out[i] = pf;
    }
    return out;
  };
  return stage(stage(m));
}

/** Z-score: distance from the SMA in standard deviations. */
export function zscore(src, len = 20) {
  const m = sma(src, len), s = stdev(src, len);
  return src.map((v, i) => (!isNum(m[i]) ? NaN : s[i] ? (v - m[i]) / s[i] : 0));
}

/** Ehlers' Laguerre RSI, 0–1. The filter starts at the first price, and the first 3 bars are left empty. */
export function laguerreRsi(src, gamma = 0.5) {
  const out = nanArray(src.length), g = gamma;
  let l0 = NaN, l1, l2, l3, prev = NaN, seen = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) continue;
    if (!isNum(l0)) { l0 = l1 = l2 = l3 = v; seen = 1; continue; }
    const p0 = l0, p1 = l1, p2 = l2;
    l0 = (1 - g) * v + g * p0;
    l1 = -g * l0 + p0 + g * p1;
    l2 = -g * l1 + p1 + g * p2;
    l3 = -g * l2 + p2 + g * l3;
    const d = [l0 - l1, l1 - l2, l2 - l3];
    const cu = d.reduce((s, x) => s + Math.max(x, 0), 0), cd = d.reduce((s, x) => s + Math.max(-x, 0), 0);
    if (cu + cd) prev = cu / (cu + cd);
    if (++seen > 3) out[i] = prev;
  }
  return out;
}

/** Consecutive up (positive) or down (negative) bars; 0 when unchanged. */
export function streak(src) {
  let s = 0;
  return src.map((v, i) => {
    const p = src[i - 1];
    if (!isNum(v) || !isNum(p)) return (s = 0);
    s = v > p ? Math.max(s, 0) + 1 : v < p ? Math.min(s, 0) - 1 : 0;
    return s;
  });
}

/** Percent of the previous len values that are below the current one, 0–100. */
export function percentrank(src, len) {
  const out = nanArray(src.length);
  if (Number.isInteger(len) && len >= 24) { // shorter: the plain scan below is quicker
    // The previous len values kept sorted (gaps counted, not kept): a binary search counts those
    // below, instead of comparing with each of them.
    const win = new Float64Array(len);
    let size = 0, bad = 0;
    const below = (v) => { // values < v
      let lo = 0, hi = size;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (win[mid] < v) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const add = (x) => {
      if (!isNum(x)) { bad++; return; }
      const at = below(x);
      win.copyWithin(at + 1, at, size);
      win[at] = x;
      size++;
    };
    const drop = (x) => {
      if (!isNum(x)) { bad--; return; }
      const at = below(x); // an equal value
      win.copyWithin(at, at + 1, size);
      size--;
    };
    for (let i = 0; i < Math.min(len, src.length); i++) add(src[i]);
    for (let i = len; i < src.length; i++) {
      const v = src[i], o = src[i - len];
      const at = isNum(v) ? below(v) : 0;
      if (!bad && isNum(v)) out[i] = (100 * at) / len;
      if (!isNum(v) || !isNum(o)) { drop(o); add(v); continue; }
      // o leaves and v comes in: only the values between their places move, by one.
      const from = below(o);
      if (at > from) {
        for (let k = from; k < at - 1; k++) win[k] = win[k + 1];
        win[at - 1] = v;
      } else {
        for (let k = from; k > at; k--) win[k] = win[k - 1];
        win[at] = v;
      }
    }
    return out;
  }
  for (let i = len; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) continue;
    let below = 0, ok = true;
    for (let j = 1; j <= len; j++) {
      const x = src[i - j];
      if (!isNum(x)) { ok = false; break; }
      if (x < v) below++;
    }
    if (ok) out[i] = (100 * below) / len;
  }
  return out;
}

/** Connors RSI: average of RSI, RSI of the up/down streak and the percent rank of the 1-bar ROC. */
export function connorsRsi(src, rsiLen = 3, streakLen = 2, rankLen = 100) {
  const a = rsi(src, rsiLen), b = rsi(streak(src), streakLen), c = percentrank(roc(src, 1), rankLen);
  return a.map((v, i) => (v + b[i] + c[i]) / 3);
}

/** Dorsey's Relative Volatility Index: RSI-style ratio of standard deviations on up vs down bars. */
export function rvi(src, len = 10, smooth = 14) {
  const sd = stdev(src, len), ch = change(src);
  const u = sd.map((s, i) => (isNum(s) && isNum(ch[i]) ? (ch[i] > 0 ? s : 0) : NaN));
  const d = sd.map((s, i) => (isNum(s) && isNum(ch[i]) ? (ch[i] < 0 ? s : 0) : NaN));
  const au = rma(u, smooth), ad = rma(d, smooth);
  return au.map((v, i) => (!isNum(v) ? NaN : v + ad[i] ? (100 * v) / (v + ad[i]) : 50));
}

/** Vertical Horizontal Filter: close range over the sum of close-to-close moves. */
export function vhf(src, len = 28) {
  const hh = highest(src, len), ll = lowest(src, len), path = sum(change(src).map(Math.abs), len);
  return path.map((p, i) => (!isNum(p) ? NaN : p ? (hh[i] - ll[i]) / p : 0));
}

/** Hannula's Polarized Fractal Efficiency, −100 to 100, EMA-smoothed. */
export function pfe(src, len = 10, smooth = 5) {
  const raw = src.map((v, i) => {
    if (i < len) return NaN;
    const d = v - src[i - len];
    let path = 0;
    for (let j = 0; j < len; j++) path += Math.sqrt((src[i - j] - src[i - j - 1]) ** 2 + 1);
    return path ? (Math.sign(d) * 100 * Math.sqrt(d * d + len * len)) / path : NaN;
  });
  return ema(raw, smooth);
}

/** Ulcer Index: root-mean-square percent drawdown from the rolling high. */
export function ulcer(src, len = 14) {
  const mx = highest(src, len);
  const dd = src.map((v, i) => (isNum(mx[i]) && mx[i] ? ((100 * (v - mx[i])) / mx[i]) ** 2 : NaN));
  return sum(dd, len).map((s) => Math.sqrt(s / len));
}

// Bar-based (exposed to scripts under TA.bars)

/** Williams Alligator: SMMAs of the bar midpoint, shifted forward. */
export function alligator(bars, jaw = 13, jawOffset = 8, teeth = 8, teethOffset = 5, lips = 5, lipsOffset = 3) {
  const m = source(bars, 'hl2');
  return { jaw: shift(rma(m, jaw), jawOffset), teeth: shift(rma(m, teeth), teethOffset), lips: shift(rma(m, lips), lipsOffset) };
}

/** Chandelier Exit: ATR stops hung from the highest high (long) and lowest low (short). */
export function chandelier(bars, len = 22, mult = 3) {
  const a = atr(bars, len), hh = highest(pick(bars, 'high'), len), ll = lowest(pick(bars, 'low'), len);
  return { long: hh.map((h, i) => h - mult * a[i]), short: ll.map((l, i) => l + mult * a[i]) };
}

/** Chande Kroll Stop (p, x, q) from The New Technical Trader. */
export function chandeKroll(bars, p = 10, x = 1, q = 9) {
  const a = atr(bars, p);
  const fh = highest(pick(bars, 'high'), p).map((h, i) => h - x * a[i]);
  const fl = lowest(pick(bars, 'low'), p).map((l, i) => l + x * a[i]);
  return { stopShort: fullWindow(highest(fh, q), fh, q), stopLong: fullWindow(lowest(fl, q), fl, q) };
}

/** SSL Channel: SMAs of highs and lows that swap sides when the close breaks out. */
export function ssl(bars, len = 10) {
  const hi = sma(pick(bars, 'high'), len), lo = sma(pick(bars, 'low'), len);
  const up = nanArray(bars.length), down = nanArray(bars.length);
  let hlv = 0;
  for (let i = 0; i < bars.length; i++) {
    if (!isNum(hi[i]) || !isNum(lo[i])) continue;
    const c = bars[i].close;
    hlv = c > hi[i] ? 1 : c < lo[i] ? -1 : hlv;
    up[i] = hlv < 0 ? lo[i] : hi[i];
    down[i] = hlv < 0 ? hi[i] : lo[i];
  }
  return { up, down };
}

/** Random Walk Index: moves against what a random walk would cover in len bars. */
export function rwi(bars, len = 14) {
  const a = atr(bars, len), k = Math.sqrt(len);
  return {
    high: bars.map((b, i) => (i >= len && a[i] ? (b.high - bars[i - len].low) / (a[i] * k) : NaN)),
    low: bars.map((b, i) => (i >= len && a[i] ? (bars[i - len].high - b.low) / (a[i] * k) : NaN)),
  };
}

/** Elder Ray: high (bull power) and low (bear power) minus an EMA of the close. */
export function elderRay(bars, len = 13) {
  const e = ema(source(bars), len);
  return { bull: bars.map((b, i) => b.high - e[i]), bear: bars.map((b, i) => b.low - e[i]) };
}

/** Dorsey's Mass Index: sum of the single/double EMA ratio of the bar range. */
export function massIndex(bars, len = 9, sumLen = 25) {
  const e1 = ema(bars.map((b) => b.high - b.low), len), e2 = ema(e1, len);
  return sum(e1.map((v, i) => (e2[i] ? v / e2[i] : NaN)), sumLen);
}

/** Blau's Stochastic Momentum Index, −100 to 100, with an EMA signal. */
export function smi(bars, len = 10, smoothK = 3, smoothD = 3, signal = 10) {
  const hh = highest(pick(bars, 'high'), len), ll = lowest(pick(bars, 'low'), len);
  const rel = bars.map((b, i) => b.close - (hh[i] + ll[i]) / 2), rng = hh.map((h, i) => h - ll[i]);
  const a = ema(ema(rel, smoothK), smoothD), d = ema(ema(rng, smoothK), smoothD);
  const s = a.map((v, i) => (!isNum(v) ? NaN : d[i] ? (200 * v) / d[i] : 0));
  return { smi: s, signal: ema(s, signal) };
}

/** Ehlers' Relative Vigor Index: close−open vs high−low, with a symmetric-weighted signal. */
export function rvgi(bars, len = 10) {
  const sn = sum(swma(bars.map((b) => b.close - b.open)), len), sd = sum(swma(bars.map((b) => b.high - b.low)), len);
  const r = sn.map((v, i) => (!isNum(v) ? NaN : sd[i] ? v / sd[i] : 0));
  return { rvgi: r, signal: swma(r) };
}

/** Chande's Intraday Momentum Index: RSI built from open-to-close moves, 0–100. */
export function imi(bars, len = 14) {
  const g = sum(bars.map((b) => Math.max(b.close - b.open, 0)), len), l = sum(bars.map((b) => Math.max(b.open - b.close, 0)), len);
  return g.map((v, i) => (!isNum(v) ? NaN : v + l[i] ? (100 * v) / (v + l[i]) : 50));
}

/** Qstick: moving average of close − open. */
export const qstick = (bars, len = 8) => sma(bars.map((b) => b.close - b.open), len);

/**
 * Squeeze momentum: Bollinger Bands inside Keltner Channels, plus a linear-regression momentum value.
 * state: 1 = squeeze on (BB inside KC), −1 = released, 0 = neither.
 */
export function squeeze(bars, len = 20, mult = 2, kcLen = 20, kcMult = 1.5) {
  const c = source(bars), basis = sma(c, len), dev = stdev(c, len);
  const ma = sma(c, kcLen), rng = sma(tr(bars), kcLen);
  const hh = highest(pick(bars, 'high'), kcLen), ll = lowest(pick(bars, 'low'), kcLen);
  const value = linreg(c.map((v, i) => v - ((hh[i] + ll[i]) / 2 + ma[i]) / 2), kcLen);
  const state = bars.map((_, i) => {
    if (!isNum(basis[i]) || !isNum(ma[i]) || !isNum(rng[i])) return NaN;
    const ub = basis[i] + mult * dev[i], lb = basis[i] - mult * dev[i];
    const uk = ma[i] + kcMult * rng[i], lk = ma[i] - kcMult * rng[i];
    return lb > lk && ub < uk ? 1 : lb < lk && ub > uk ? -1 : 0;
  });
  return { value, state };
}

/** Klinger Volume Oscillator (StockCharts' volume force), with an EMA signal. */
export function klinger(bars, fast = 34, slow = 55, signal = 13) {
  const vf = nanArray(bars.length);
  let trend = 0, cm = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    const t = b.high + b.low + b.close > p.high + p.low + p.close ? 1 : -1;
    const dm = b.high - b.low;
    cm = t === trend ? cm + dm : p.high - p.low + dm;
    trend = t;
    vf[i] = cm ? (isNum(b.volume) ? b.volume : 0) * Math.abs(2 * (dm / cm - 1)) * t * 100 : 0;
  }
  const s = ema(vf, slow), k = ema(vf, fast).map((v, i) => v - s[i]);
  return { kvo: k, signal: ema(k, signal) };
}

/** Arms' Ease of Movement: midpoint move × range ÷ volume, averaged. Zero-volume bars count as 0. */
export function eom(bars, len = 14, divisor = 10000) {
  return sma(bars.map((b, i) => {
    if (i === 0) return NaN;
    const p = bars[i - 1];
    return b.volume > 0 ? (divisor * ((b.high + b.low) / 2 - (p.high + p.low) / 2) * (b.high - b.low)) / b.volume : 0;
  }), len);
}

/** Starts at 1000 and adds the percent change only on bars where volume moved the given way. */
function volumeIndex(bars, when) {
  let v = 1000;
  return bars.map((b, i) => {
    const p = bars[i - 1];
    if (p && p.close && when(b.volume, p.volume)) v += ((b.close - p.close) / p.close) * v;
    return v;
  });
}
export const nvi = (bars) => volumeIndex(bars, (v, pv) => v < pv);
export const pvi = (bars) => volumeIndex(bars, (v, pv) => v > pv);

/** Volume-weighted MACD (Dormeier): VWMA fast − VWMA slow, EMA signal. */
export function vwmacd(bars, fast = 12, slow = 26, signal = 9) {
  const c = source(bars), v = pick(bars, 'volume'), s = vwma(c, v, slow);
  const m = vwma(c, v, fast).map((x, i) => x - s[i]);
  const sig = ema(m, signal);
  return { macd: m, signal: sig, hist: m.map((x, i) => x - sig[i]) };
}

/** ATR as a percent of the close. */
export const atrp = (bars, len = 14) => atr(bars, len).map((a, i) => (bars[i].close ? (100 * a) / bars[i].close : NaN));

/** Chaikin Volatility: rate of change of an EMA of the bar range. */
export const chaikinVolatility = (bars, len = 10, rocLen = 10) => roc(ema(bars.map((b) => b.high - b.low), len), rocLen);

/** Stoller's STARC bands: SMA ± mult × ATR. */
export function starc(bars, len = 6, atrLen = 15, mult = 2) {
  const basis = sma(source(bars), len), a = atr(bars, atrLen);
  return { basis, upper: basis.map((v, i) => v + mult * a[i]), lower: basis.map((v, i) => v - mult * a[i]) };
}

/** Daily VWAP with volume-weighted standard deviation (bands at ± mult × dev). */
export function vwapBands(bars, mult = 1) {
  const n = bars.length, vw = nanArray(n), dev = nanArray(n);
  let day = null, pv = 0, pv2 = 0, vol = 0, base = 0;
  bars.forEach((b, i) => {
    const d = Math.floor(b.time / DAY);
    const tp = (b.high + b.low + b.close) / 3;
    if (d !== day) { day = d; pv = 0; pv2 = 0; vol = 0; base = tp; }
    const w = b.volume > 0 ? b.volume : 0, x = tp - base; // offset by the session's first price for precision
    pv += x * w; pv2 += x * x * w; vol += w;
    if (vol > 0) { const m = pv / vol; vw[i] = base + m; dev[i] = Math.sqrt(Math.max(pv2 / vol - m * m, 0)); }
    else { vw[i] = tp; dev[i] = 0; }
  });
  return { vwap: vw, dev, upper: vw.map((v, i) => v + mult * dev[i]), lower: vw.map((v, i) => v - mult * dev[i]) };
}

// ---------------------------------------------------------------------------
// Indicator definitions
// ---------------------------------------------------------------------------

const P = (key, label, def, min = 1, max = 1000, step = 1) => ({ key, label, def, min, max, step });
/** What the source options show (their values stay the ids above; hl2, hlc3 and ohlc4 show as they are). */
const SOURCE_LABELS = { close: t('ind.src.close'), open: t('ind.src.open'), high: t('ind.src.high'), low: t('ind.src.low') };
const SRC = (def = 'close') => ({ key: 'source', label: t('ind.p.source'), def, type: 'select', options: SOURCES, optionLabels: SOURCE_LABELS });
const levelsFill = (top, bottom, color) => ({ from: '_top', to: '_bottom', color, consts: { _top: top, _bottom: bottom } });
/** MACD-style histogram colours: strong while moving away from zero, pale while moving back. */
const macdHistColor = (hist, i) => {
  const h = hist[i], prev = hist[i - 1];
  if (h >= 0) return isNum(prev) && h < prev ? '#B2DFDB' : '#26A69A';
  return isNum(prev) && h > prev ? '#FFCDD2' : '#FF5252';
};

/** Builds a simple single-line moving average definition. */
const maDef = (name, short, description, len, fn) => ({
  name, short, description, category: 'Moving averages', overlay: true,
  params: [P('length', t('ind.p.length'), len), SRC()],
  plots: [{ key: 'ma', title: short, color: 'auto' }],
  calc: (bars, p) => ({ ma: fn(source(bars, p.source), p.length, bars) }),
});

export const CATEGORIES = [
  'Moving averages', 'Bands & channels', 'Trend', 'Oscillators', 'Momentum', 'Trend strength', 'Volume', 'Volatility',
];

const CATEGORY_KEYS = {
  'Moving averages': 'ind.cat.ma', 'Bands & channels': 'ind.cat.bands', Trend: 'ind.cat.trend', Oscillators: 'ind.cat.osc',
  Momentum: 'ind.cat.momentum', 'Trend strength': 'ind.cat.strength', Volume: 'ind.cat.volume', Volatility: 'ind.cat.volatility',
};
/** A category (an English id, as in CATEGORIES and def.category) in the UI language. */
export const categoryLabel = (c) => (CATEGORY_KEYS[c] ? t(CATEGORY_KEYS[c]) : c);
/** The text shown for option o of a select param p; the option's value stays o. */
export const optionLabel = (p, o) => (p.optionLabels && Object.hasOwn(p.optionLabels, o) ? p.optionLabels[o] : String(o));

export const INDICATORS = {
  // --- Moving averages ------------------------------------------------------
  sma: maDef(t('ind.sma.name'), 'SMA', t('ind.sma.desc'), 20, sma),
  ema: maDef(t('ind.ema.name'), 'EMA', t('ind.ema.desc'), 21, (s, len) => ema(s, len)),
  wma: maDef(t('ind.wma.name'), 'WMA', t('ind.wma.desc'), 9, wma),
  hma: maDef(t('ind.hma.name'), 'HMA', t('ind.hma.desc'), 9, hma),
  dema: maDef(t('ind.dema.name'), 'DEMA', t('ind.dema.desc'), 9, dema),
  tema: maDef(t('ind.tema.name'), 'TEMA', t('ind.tema.desc'), 9, tema),
  smma: maDef(t('ind.smma.name'), 'SMMA', t('ind.smma.desc'), 7, rma),
  vwma: maDef(t('ind.vwma.name'), 'VWMA', t('ind.vwma.desc'), 20, (s, len, bars) => vwma(s, pick(bars, 'volume'), len)),
  alma: maDef(t('ind.alma.name'), 'ALMA', t('ind.alma.desc'), 9, (s, len) => alma(s, len)),
  lsma: maDef(t('ind.lsma.name'), 'LSMA', t('ind.lsma.desc'), 25, (s, len) => linreg(s, len)),
  macross: {
    name: t('ind.macross.name'), short: 'MA Cross', description: t('ind.macross.desc'), category: 'Moving averages', overlay: true,
    params: [P('fast', t('ind.p.fastLength'), 9), P('slow', t('ind.p.slowLength'), 21), { key: 'kind', label: t('ind.p.type'), def: 'EMA', type: 'select', options: ['EMA', 'SMA'] }],
    plots: [{ key: 'fast', title: t('ind.plot.fast'), color: '#00BCD4' }, { key: 'slow', title: t('ind.plot.slow'), color: '#FF9800' }],
    calc: (bars, p) => {
      const c = source(bars), f = p.kind === 'SMA' ? sma : ema;
      return { fast: f(c, p.fast), slow: f(c, p.slow) };
    },
  },
  kama: {
    name: t('ind.kama.name'), short: 'KAMA', description: t('ind.kama.desc'), category: 'Moving averages', overlay: true,
    params: [P('length', t('ind.p.lengthOf', { name: 'ER' }), 10), P('fast', t('ind.p.fastLength'), 2), P('slow', t('ind.p.slowLength'), 30), SRC()],
    plots: [{ key: 'ma', title: 'KAMA', color: 'auto' }],
    calc: (bars, p) => ({ ma: kama(source(bars, p.source), p.length, p.fast, p.slow) }),
  },
  zlema: maDef(t('ind.zlema.name'), 'ZLEMA', t('ind.zlema.desc'), 20, zlema),
  t3: {
    name: t('ind.t3.name'), short: 'T3', description: t('ind.t3.desc'), category: 'Moving averages', overlay: true,
    params: [P('length', t('ind.p.length'), 5), P('vfactor', t('ind.p.vfactor'), 0.7, 0, 1, 0.05), SRC()],
    plots: [{ key: 'ma', title: 'T3', color: 'auto' }],
    calc: (bars, p) => ({ ma: t3(source(bars, p.source), p.length, p.vfactor) }),
  },
  mcginley: maDef(t('ind.mcginley.name'), 'McGinley', t('ind.mcginley.desc'), 14, mcginley),
  vidya: {
    name: t('ind.vidya.name'), short: 'VIDYA', description: t('ind.vidya.desc'), category: 'Moving averages', overlay: true,
    params: [P('length', t('ind.p.length'), 9), P('cmoLength', t('ind.p.lengthOf', { name: 'CMO' }), 9), SRC()],
    plots: [{ key: 'ma', title: 'VIDYA', color: 'auto' }],
    calc: (bars, p) => ({ ma: vidya(source(bars, p.source), p.length, p.cmoLength) }),
  },
  trima: maDef(t('ind.trima.name'), 'TRIMA', t('ind.trima.desc'), 20, trima),
  maribbon: {
    name: t('ind.maribbon.name'), short: 'MA Ribbon', description: t('ind.maribbon.desc'), category: 'Moving averages', overlay: true,
    params: [
      { key: 'kind', label: t('ind.p.type'), def: 'EMA', type: 'select', options: ['EMA', 'SMA'] },
      P('len1', t('ind.p.lengthOf', { name: 'MA #1' }), 20), P('len2', t('ind.p.lengthOf', { name: 'MA #2' }), 50),
      P('len3', t('ind.p.lengthOf', { name: 'MA #3' }), 100), P('len4', t('ind.p.lengthOf', { name: 'MA #4' }), 200), SRC(),
    ],
    plots: [
      { key: 'ma1', title: 'MA #1', color: '#F6C309', width: 1 },
      { key: 'ma2', title: 'MA #2', color: '#FB9800', width: 1 },
      { key: 'ma3', title: 'MA #3', color: '#FB6500', width: 1 },
      { key: 'ma4', title: 'MA #4', color: '#F60C0C', width: 1 },
    ],
    calc: (bars, p) => {
      const c = source(bars, p.source), f = p.kind === 'SMA' ? sma : ema;
      return { ma1: f(c, p.len1), ma2: f(c, p.len2), ma3: f(c, p.len3), ma4: f(c, p.len4) };
    },
  },
  gmma: {
    name: t('ind.gmma.name'), short: 'GMMA', description: t('ind.gmma.desc'), category: 'Moving averages', overlay: true,
    params: [SRC()],
    plots: [3, 5, 8, 10, 12, 15, 30, 35, 40, 45, 50, 60].map((len) => (
      { key: `e${len}`, title: `EMA ${len}`, color: len < 30 ? '#26A69A' : '#EF5350', width: 1 })),
    calc: (bars, p) => {
      const c = source(bars, p.source);
      return Object.fromEntries([3, 5, 8, 10, 12, 15, 30, 35, 40, 45, 50, 60].map((len) => [`e${len}`, ema(c, len)]));
    },
  },

  // --- Bands & channels -------------------------------------------------------
  bb: {
    name: t('ind.bb.name'), short: 'BB', description: t('ind.bb.desc'), category: 'Bands & channels', overlay: true,
    params: [P('length', t('ind.p.length'), 20), P('mult', t('ind.p.stdDev'), 2, 0.1, 10, 0.1), SRC()],
    plots: [
      { key: 'upper', title: t('ind.plot.upper'), color: '#4FA3F7', width: 1 },
      { key: 'basis', title: t('ind.plot.basis'), color: '#FF6D00', width: 1 },
      { key: 'lower', title: t('ind.plot.lower'), color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => bb(source(bars, p.source), p.length, p.mult),
  },
  keltner: {
    name: t('ind.keltner.name'), short: 'KC', description: t('ind.keltner.desc'), category: 'Bands & channels', overlay: true,
    params: [P('length', t('ind.p.length'), 20), P('mult', t('ind.p.mult'), 2, 0.1, 10, 0.1), P('atrLength', t('ind.p.lengthOf', { name: 'ATR' }), 10)],
    plots: [
      { key: 'upper', title: t('ind.plot.upper'), color: '#4FA3F7', width: 1 },
      { key: 'basis', title: t('ind.plot.basis'), color: '#4FA3F7', width: 1 },
      { key: 'lower', title: t('ind.plot.lower'), color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => {
      const basis = ema(source(bars), p.length), a = atr(bars, p.atrLength);
      return { basis, upper: basis.map((v, i) => v + p.mult * a[i]), lower: basis.map((v, i) => v - p.mult * a[i]) };
    },
  },
  donchian: {
    name: t('ind.donchian.name'), short: 'DC', description: t('ind.donchian.desc'), category: 'Bands & channels', overlay: true,
    params: [P('length', t('ind.p.length'), 20)],
    plots: [
      { key: 'upper', title: t('ind.plot.upper'), color: '#4FA3F7', width: 1 },
      { key: 'basis', title: t('ind.plot.basis'), color: '#FF6D00', width: 1 },
      { key: 'lower', title: t('ind.plot.lower'), color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => {
      const upper = highest(pick(bars, 'high'), p.length), lower = lowest(pick(bars, 'low'), p.length);
      return { upper, lower, basis: upper.map((v, i) => (v + lower[i]) / 2) };
    },
  },
  envelopes: {
    name: t('ind.envelopes.name'), short: 'Env', description: t('ind.envelopes.desc'), category: 'Bands & channels', overlay: true,
    params: [P('length', t('ind.p.length'), 20), P('percent', t('ind.p.percent'), 10, 0.1, 100, 0.1)],
    plots: [
      { key: 'upper', title: t('ind.plot.upper'), color: '#4FA3F7', width: 1 },
      { key: 'basis', title: t('ind.plot.basis'), color: '#FF6D00', width: 1 },
      { key: 'lower', title: t('ind.plot.lower'), color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => {
      const basis = sma(source(bars), p.length), k = p.percent / 100;
      return { basis, upper: basis.map((v) => v * (1 + k)), lower: basis.map((v) => v * (1 - k)) };
    },
  },
  starc: {
    name: t('ind.starc.name'), short: 'STARC', description: t('ind.starc.desc'), category: 'Bands & channels', overlay: true,
    params: [P('length', t('ind.p.lengthOf', { name: 'SMA' }), 6), P('atrLength', t('ind.p.lengthOf', { name: 'ATR' }), 15), P('mult', t('ind.p.mult'), 2, 0.1, 10, 0.1)],
    plots: [
      { key: 'upper', title: t('ind.plot.upper'), color: '#4FA3F7', width: 1 },
      { key: 'basis', title: t('ind.plot.basis'), color: '#FF6D00', width: 1 },
      { key: 'lower', title: t('ind.plot.lower'), color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => starc(bars, p.length, p.atrLength, p.mult),
  },
  sebands: {
    name: t('ind.sebands.name'), short: 'SE Bands', description: t('ind.sebands.desc'), category: 'Bands & channels', overlay: true,
    params: [P('length', t('ind.p.length'), 21, 3), P('mult', t('ind.p.stdErrors'), 2, 0.1, 10, 0.1), P('smooth', t('ind.p.smoothing'), 3), SRC()], // a standard error needs 3 points
    plots: [
      { key: 'upper', title: t('ind.plot.upper'), color: '#4FA3F7', width: 1 },
      { key: 'basis', title: t('ind.plot.basis'), color: '#FF6D00', width: 1 },
      { key: 'lower', title: t('ind.plot.lower'), color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => stderrBands(source(bars, p.source), p.length, p.mult, p.smooth),
  },
  vwapbands: {
    name: t('ind.vwapbands.name'), short: 'VWAP Bands', description: t('ind.vwapbands.desc'), category: 'Bands & channels', overlay: true,
    params: [P('mult1', t('ind.p.bandMult', { n: 1 }), 1, 0.1, 10, 0.1), P('mult2', t('ind.p.bandMult', { n: 2 }), 2, 0.1, 10, 0.1)],
    plots: [
      { key: 'upper2', title: t('ind.plot.upperN', { n: 2 }), color: '#43A047', width: 1 },
      { key: 'upper1', title: t('ind.plot.upperN', { n: 1 }), color: '#4FA3F7', width: 1 },
      { key: 'vwap', title: 'VWAP', color: '#E040FB' },
      { key: 'lower1', title: t('ind.plot.lowerN', { n: 1 }), color: '#4FA3F7', width: 1 },
      { key: 'lower2', title: t('ind.plot.lowerN', { n: 2 }), color: '#43A047', width: 1 },
    ],
    fills: [{ from: 'upper1', to: 'lower1', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => {
      const { vwap: v, dev } = vwapBands(bars);
      const band = (k) => v.map((x, i) => x + k * dev[i]);
      return { vwap: v, upper1: band(p.mult1), lower1: band(-p.mult1), upper2: band(p.mult2), lower2: band(-p.mult2) };
    },
  },

  // --- Trend ----------------------------------------------------------------------
  supertrend: {
    name: t('ind.supertrend.name'), short: 'Supertrend', description: t('ind.supertrend.desc'), category: 'Trend', overlay: true,
    params: [P('length', t('ind.p.lengthOf', { name: 'ATR' }), 10), P('factor', t('ind.p.factor'), 3, 0.1, 20, 0.1)],
    plots: [
      { key: 'up', title: t('ind.plot.upTrend'), color: UP, optional: true },
      { key: 'down', title: t('ind.plot.downTrend'), color: DOWN, optional: true },
    ],
    calc: (bars, p) => {
      const { value, direction } = supertrend(bars, p.factor, p.length);
      return {
        up: value.map((v, i) => (direction[i] === 1 ? v : NaN)),
        down: value.map((v, i) => (direction[i] === -1 ? v : NaN)),
      };
    },
  },
  ichimoku: {
    name: t('ind.ichimoku.name'), short: 'Ichimoku', description: t('ind.ichimoku.desc'), category: 'Trend', overlay: true, hideLastValue: true,
    params: [P('conversion', t('ind.p.conversionLength'), 9), P('base', t('ind.p.baseLength'), 26), P('spanB', t('ind.p.spanBLength'), 52), P('displacement', t('ind.p.displacement'), 26)],
    plots: [
      { key: 'conversion', title: t('ind.plot.conversion'), color: '#4FA3F7', width: 1 },
      { key: 'base', title: t('ind.plot.base'), color: '#B71C1C', width: 1 },
      { key: 'lagging', title: t('ind.plot.lagging'), color: '#43A047', width: 1 },
      { key: 'spanA', title: t('ind.plot.leadingA'), color: '#A5D6A7', width: 1 },
      { key: 'spanB', title: t('ind.plot.leadingB'), color: '#EF9A9A', width: 1 },
    ],
    fills: [{ from: 'spanA', to: 'spanB', colors: ['rgba(67, 160, 71, 0.12)', 'rgba(244, 67, 54, 0.12)'] }],
    calc: (bars, p) => {
      const h = pick(bars, 'high'), l = pick(bars, 'low');
      const mid = (len) => { const hh = highest(h, len), ll = lowest(l, len); return hh.map((v, i) => (v + ll[i]) / 2); };
      const conversion = mid(p.conversion), base = mid(p.base), b52 = mid(p.spanB);
      const d = p.displacement - 1;
      const a = conversion.map((v, i) => (v + base[i]) / 2);
      return {
        conversion, base,
        lagging: bars.map((_, i) => (i + d < bars.length ? bars[i + d].close : NaN)),
        spanA: shift(a, d), spanB: shift(b52, d),
      };
    },
  },
  psar: {
    name: t('ind.psar.name'), short: 'SAR', description: t('ind.psar.desc'), category: 'Trend', overlay: true,
    params: [P('start', t('ind.p.start'), 0.02, 0.001, 1, 0.001), P('inc', t('ind.p.increment'), 0.02, 0.001, 1, 0.001), P('max', t('ind.p.maximum'), 0.2, 0.01, 1, 0.01)],
    plots: [{ key: 'sar', title: 'SAR', type: 'dots', colorFn: (i, out) => (out.dir[i] === 1 ? UP : DOWN) }],
    calc: (bars, p) => psar(bars, p.start, p.inc, p.max),
  },
  vwap: {
    name: t('ind.vwap.name'), short: 'VWAP', description: t('ind.vwap.desc'), category: 'Trend', overlay: true,
    params: [],
    plots: [{ key: 'vwap', title: 'VWAP', color: '#4FA3F7' }],
    calc: (bars) => ({ vwap: vwap(bars) }),
  },
  pivots: {
    name: t('ind.pivots.name'), short: 'Pivots', description: t('ind.pivots.desc'), category: 'Trend', overlay: true, hideLastValue: true,
    params: [{
      key: 'kind', label: t('ind.p.type'), def: 'Traditional', type: 'select', options: ['Traditional', 'Fibonacci'],
      optionLabels: { Traditional: t('ind.opt.traditional'), Fibonacci: t('ind.opt.fibonacci') },
    }],
    plots: [
      { key: 'r3', title: 'R3', color: '#EC5246', width: 1, type: 'step' },
      { key: 'r2', title: 'R2', color: '#EC5246', width: 1, type: 'step' },
      { key: 'r1', title: 'R1', color: '#EC5246', width: 1, type: 'step' },
      { key: 'p', title: 'P', color: '#FF9800', width: 1, type: 'step' },
      { key: 's1', title: 'S1', color: '#34B886', width: 1, type: 'step' },
      { key: 's2', title: 'S2', color: '#34B886', width: 1, type: 'step' },
      { key: 's3', title: 'S3', color: '#34B886', width: 1, type: 'step' },
    ],
    calc: (bars, p, ctx = {}) => {
      // Period: day for intraday charts, week for daily, month for weekly, year for monthly.
      const sec = ctx.tfSec || 3600;
      const periodOf = (t) => {
        if (sec < DAY) return Math.floor(t / DAY);
        const d = new Date(t * 1000);
        if (sec < 7 * DAY) return Math.floor((t / DAY + 3) / 7);
        if (sec < 28 * DAY) return d.getUTCFullYear() * 12 + d.getUTCMonth();
        return d.getUTCFullYear();
      };
      const keys = ['p', 'r1', 's1', 'r2', 's2', 'r3', 's3'];
      const out = Object.fromEntries(keys.map((k) => [k, nanArray(bars.length)]));
      let cur = null, ph = -Infinity, pl = Infinity, pc = NaN, lv = null, curH = -Infinity, curL = Infinity;
      bars.forEach((b, i) => {
        const per = periodOf(b.time);
        if (per !== cur) {
          if (cur !== null) { ph = curH; pl = curL; pc = bars[i - 1].close; }
          cur = per; curH = -Infinity; curL = Infinity;
          if (isNum(pc)) {
            const pp = (ph + pl + pc) / 3, r = ph - pl;
            lv = p.kind === 'Fibonacci'
              ? { p: pp, r1: pp + 0.382 * r, s1: pp - 0.382 * r, r2: pp + 0.618 * r, s2: pp - 0.618 * r, r3: pp + r, s3: pp - r }
              : { p: pp, r1: 2 * pp - pl, s1: 2 * pp - ph, r2: pp + r, s2: pp - r, r3: ph + 2 * (pp - pl), s3: pl - 2 * (ph - pp) };
          }
          curH = b.high; curL = b.low;
          return; // leave a gap at the first bar of each period
        }
        curH = Math.max(curH, b.high); curL = Math.min(curL, b.low);
        if (lv) for (const k of keys) out[k][i] = lv[k];
      });
      return out;
    },
  },
  alligator: {
    name: t('ind.alligator.name'), short: 'Alligator', description: t('ind.alligator.desc'), category: 'Trend', overlay: true,
    params: [
      P('jaw', t('ind.p.jawLength'), 13), P('jawOffset', t('ind.p.jawOffset'), 8, 0, 100), P('teeth', t('ind.p.teethLength'), 8),
      P('teethOffset', t('ind.p.teethOffset'), 5, 0, 100), P('lips', t('ind.p.lipsLength'), 5), P('lipsOffset', t('ind.p.lipsOffset'), 3, 0, 100),
    ],
    plots: [
      { key: 'jaw', title: t('ind.plot.jaw'), color: '#2962FF' },
      { key: 'teeth', title: t('ind.plot.teeth'), color: '#E91E63' },
      { key: 'lips', title: t('ind.plot.lips'), color: '#66BB6A' },
    ],
    calc: (bars, p) => alligator(bars, p.jaw, p.jawOffset, p.teeth, p.teethOffset, p.lips, p.lipsOffset),
  },
  chandelier: {
    name: t('ind.chandelier.name'), short: 'Chandelier', description: t('ind.chandelier.desc'), category: 'Trend', overlay: true,
    params: [P('length', t('ind.p.length'), 22), P('mult', t('ind.p.multOf', { name: 'ATR' }), 3, 0.1, 20, 0.1)],
    plots: [{ key: 'long', title: t('ind.plot.longStop'), color: '#26A69A', width: 1 }, { key: 'short', title: t('ind.plot.shortStop'), color: '#EF5350', width: 1 }],
    calc: (bars, p) => chandelier(bars, p.length, p.mult),
  },
  ckstop: {
    name: t('ind.ckstop.name'), short: 'CK Stop', description: t('ind.ckstop.desc'), category: 'Trend', overlay: true,
    params: [P('p', t('ind.p.lengthOf', { name: 'ATR' }), 10), P('x', t('ind.p.multOf', { name: 'ATR' }), 1, 0.1, 20, 0.1), P('q', t('ind.p.stopLength'), 9)],
    plots: [{ key: 'stopLong', title: t('ind.plot.longStop'), color: '#2962FF', width: 1 }, { key: 'stopShort', title: t('ind.plot.shortStop'), color: '#FF6D00', width: 1 }],
    calc: (bars, p) => chandeKroll(bars, p.p, p.x, p.q),
  },
  ssl: {
    name: t('ind.ssl.name'), short: 'SSL', description: t('ind.ssl.desc'), category: 'Trend', overlay: true,
    params: [P('length', t('ind.p.length'), 10)],
    plots: [{ key: 'up', title: t('ind.plot.up'), color: '#26A69A' }, { key: 'down', title: t('ind.plot.down'), color: '#EF5350' }],
    fills: [{ from: 'up', to: 'down', colors: ['rgba(38, 166, 154, 0.1)', 'rgba(239, 83, 80, 0.1)'] }],
    calc: (bars, p) => ssl(bars, p.length),
  },

  // --- Oscillators ------------------------------------------------------------------
  rsi: {
    name: t('ind.rsi.name'), short: 'RSI', description: t('ind.rsi.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 14), SRC()],
    levels: [70, 30],
    fills: [levelsFill(70, 30, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'rsi', title: 'RSI', color: '#7E57C2' }],
    calc: (bars, p) => ({ rsi: rsi(source(bars, p.source), p.length) }),
  },
  stochrsi: {
    name: t('ind.stochrsi.name'), short: 'Stoch RSI', description: t('ind.stochrsi.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('k', 'K', 3), P('d', 'D', 3), P('rsiLength', t('ind.p.lengthOf', { name: 'RSI' }), 14), P('stochLength', t('ind.p.stochLength'), 14)],
    levels: [80, 20],
    fills: [levelsFill(80, 20, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'k', title: 'K', color: '#4FA3F7' }, { key: 'd', title: 'D', color: '#FF6D00' }],
    calc: (bars, p) => {
      const r = rsi(source(bars), p.rsiLength);
      const k = sma(stoch(r, r, r, p.stochLength), p.k);
      return { k, d: sma(k, p.d) };
    },
  },
  stoch: {
    name: t('ind.stoch.name'), short: 'Stoch', description: t('ind.stoch.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.lengthOf', { name: '%K' }), 14), P('smooth', t('ind.p.smoothingOf', { name: '%K' }), 3), P('d', t('ind.p.smoothingOf', { name: '%D' }), 3)],
    levels: [80, 20],
    fills: [levelsFill(80, 20, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'k', title: '%K', color: '#4FA3F7' }, { key: 'd', title: '%D', color: '#FF6D00' }],
    calc: (bars, p) => {
      const k = sma(stoch(source(bars), pick(bars, 'high'), pick(bars, 'low'), p.length), p.smooth);
      return { k, d: sma(k, p.d) };
    },
  },
  cci: {
    name: t('ind.cci.name'), short: 'CCI', description: t('ind.cci.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 20), SRC('hlc3')],
    levels: [100, -100],
    fills: [levelsFill(100, -100, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'cci', title: 'CCI', color: '#4FA3F7' }],
    calc: (bars, p) => ({ cci: cci(source(bars, p.source), p.length) }),
  },
  willr: {
    name: t('ind.willr.name'), short: '%R', description: t('ind.willr.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 14)],
    levels: [-20, -80],
    fills: [levelsFill(-20, -80, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'r', title: '%R', color: '#7E57C2' }],
    calc: (bars, p) => ({ r: wpr(bars, p.length) }),
  },
  mfi: {
    name: t('ind.mfi.name'), short: 'MFI', description: t('ind.mfi.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 14)],
    levels: [80, 20],
    fills: [levelsFill(80, 20, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'mfi', title: 'MF', color: '#7E57C2' }],
    calc: (bars, p) => ({ mfi: mfi(bars, p.length) }),
  },
  uo: {
    name: t('ind.uo.name'), short: 'UO', description: t('ind.uo.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('fast', t('ind.p.fast'), 7), P('middle', t('ind.p.middle'), 14), P('slow', t('ind.p.slow'), 28)],
    plots: [{ key: 'uo', title: 'UO', color: '#F44336' }],
    calc: (bars, p) => {
      const bp = bars.map((b, i) => b.close - Math.min(b.low, i ? bars[i - 1].close : b.low));
      const t = bars.map((b, i) => Math.max(b.high, i ? bars[i - 1].close : b.high) - Math.min(b.low, i ? bars[i - 1].close : b.low));
      const avg = (len) => { const a = sum(bp, len), c = sum(t, len); return a.map((v, i) => v / c[i]); };
      const a1 = avg(p.fast), a2 = avg(p.middle), a3 = avg(p.slow);
      return { uo: a1.map((v, i) => (100 * (4 * v + 2 * a2[i] + a3[i])) / 7) };
    },
  },
  cmo: {
    name: t('ind.cmo.name'), short: 'CMO', description: t('ind.cmo.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 9)],
    levels: [50, -50],
    plots: [{ key: 'cmo', title: 'CMO', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const ch = change(source(bars));
      const su = sum(ch.map((v) => (v > 0 ? v : 0)), p.length), sd = sum(ch.map((v) => (v < 0 ? -v : 0)), p.length);
      return { cmo: su.map((u, i) => (u + sd[i] ? (100 * (u - sd[i])) / (u + sd[i]) : 0)) };
    },
  },
  fisher: {
    name: t('ind.fisher.name'), short: 'Fisher', description: t('ind.fisher.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 9)],
    levels: [1.5, 0, -1.5],
    plots: [{ key: 'fisher', title: 'Fisher', color: '#4FA3F7' }, { key: 'trigger', title: t('ind.plot.trigger'), color: '#FF6D00' }],
    calc: (bars, p) => {
      const h = source(bars, 'hl2'), hh = highest(h, p.length), ll = lowest(h, p.length);
      const fisher = nanArray(bars.length), trigger = nanArray(bars.length);
      let v = 0, f = 0;
      for (let i = 0; i < bars.length; i++) {
        if (!isNum(hh[i])) continue;
        const r = hh[i] - ll[i];
        v = 0.66 * ((r ? (h[i] - ll[i]) / r : 0.5) - 0.5) + 0.67 * v;
        v = Math.max(-0.999, Math.min(0.999, v));
        trigger[i] = f;
        f = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * f;
        fisher[i] = f;
      }
      return { fisher, trigger };
    },
  },
  tsi: {
    name: t('ind.tsi.name'), short: 'TSI', description: t('ind.tsi.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('long', t('ind.p.longLength'), 25), P('short', t('ind.p.shortLength'), 13), P('signal', t('ind.p.signalLength'), 13)],
    levels: [0],
    plots: [{ key: 'tsi', title: 'TSI', color: '#4FA3F7' }, { key: 'signal', title: t('ind.plot.signal'), color: '#EC5246' }],
    calc: (bars, p) => {
      const pc = change(source(bars));
      const ds = ema(ema(pc, p.long), p.short), dsa = ema(ema(pc.map(Math.abs), p.long), p.short);
      const t = ds.map((v, i) => (dsa[i] ? (100 * v) / dsa[i] : NaN));
      return { tsi: t, signal: ema(t, p.signal) };
    },
  },
  trix: {
    name: t('ind.trix.name'), short: 'TRIX', description: t('ind.trix.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 18)],
    levels: [0],
    plots: [{ key: 'trix', title: 'TRIX', color: '#EC5246' }],
    calc: (bars, p) => {
      const e = ema(ema(ema(source(bars).map(Math.log), p.length), p.length), p.length);
      return { trix: change(e).map((v) => v * 10000) };
    },
  },
  dpo: {
    name: t('ind.dpo.name'), short: 'DPO', description: t('ind.dpo.desc'), category: 'Oscillators', overlay: false,
    params: [P('length', t('ind.p.length'), 21)],
    levels: [0],
    plots: [{ key: 'dpo', title: 'DPO', color: '#43A047' }],
    calc: (bars, p) => {
      const c = source(bars), ma = sma(c, p.length), back = Math.floor(p.length / 2) + 1;
      return { dpo: c.map((v, i) => (i >= back ? v - ma[i - back] : NaN)) };
    },
  },
  coppock: {
    name: t('ind.coppock.name'), short: 'Coppock', description: t('ind.coppock.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('wma', t('ind.p.lengthOf', { name: 'WMA' }), 10), P('longRoc', t('ind.p.longRoc'), 14), P('shortRoc', t('ind.p.shortRoc'), 11)],
    levels: [0],
    plots: [{ key: 'c', title: 'Coppock', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const c = source(bars), a = roc(c, p.longRoc), b = roc(c, p.shortRoc);
      return { c: wma(a.map((v, i) => v + b[i]), p.wma) };
    },
  },
  bbpct: {
    name: t('ind.bbpct.name'), short: '%B', description: t('ind.bbpct.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 20), P('mult', t('ind.p.stdDev'), 2, 0.1, 10, 0.1)],
    levels: [1, 0],
    fills: [levelsFill(1, 0, 'rgba(38, 166, 154, 0.08)')],
    plots: [{ key: 'b', title: '%B', color: '#26A69A' }],
    calc: (bars, p) => {
      const c = source(bars), { upper, lower } = bb(c, p.length, p.mult);
      return { b: c.map((v, i) => (v - lower[i]) / (upper[i] - lower[i])) };
    },
  },
  stc: {
    name: t('ind.stc.name'), short: 'STC', description: t('ind.stc.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [
      P('length', t('ind.p.cycleLength'), 10, 2), P('fast', t('ind.p.fastLength'), 23), P('slow', t('ind.p.slowLength'), 50),
      P('factor', t('ind.p.factor'), 0.5, 0.01, 1, 0.01), SRC(),
    ],
    levels: [75, 25],
    fills: [levelsFill(75, 25, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'stc', title: 'STC', color: '#26A69A' }],
    calc: (bars, p) => ({ stc: stc(source(bars, p.source), p.length, p.fast, p.slow, p.factor) }),
  },
  rvgi: {
    name: t('ind.rvgi.name'), short: 'RVGI', description: t('ind.rvgi.desc'), category: 'Oscillators', overlay: false, precision: 3,
    params: [P('length', t('ind.p.length'), 10)],
    levels: [0],
    plots: [{ key: 'rvgi', title: 'RVGI', color: '#26A69A' }, { key: 'signal', title: t('ind.plot.signal'), color: '#EF5350' }],
    calc: (bars, p) => rvgi(bars, p.length),
  },
  smi: {
    name: t('ind.smi.name'), short: 'SMI', description: t('ind.smi.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [
      P('length', t('ind.p.lengthOf', { name: '%K' }), 10), P('smoothK', t('ind.p.firstSmoothing'), 3),
      P('smoothD', t('ind.p.secondSmoothing'), 3), P('signal', t('ind.p.signalLength'), 10),
    ],
    levels: [40, -40],
    fills: [levelsFill(40, -40, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'smi', title: 'SMI', color: '#4FA3F7' }, { key: 'signal', title: t('ind.plot.signal'), color: '#FF6D00' }],
    calc: (bars, p) => smi(bars, p.length, p.smoothK, p.smoothD, p.signal),
  },
  crsi: {
    name: t('ind.crsi.name'), short: 'CRSI', description: t('ind.crsi.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('rsiLength', t('ind.p.lengthOf', { name: 'RSI' }), 3), P('streakLength', t('ind.p.streakLength'), 2), P('rankLength', t('ind.p.rankLength'), 100), SRC()],
    levels: [90, 10],
    fills: [levelsFill(90, 10, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'crsi', title: 'CRSI', color: '#7E57C2' }],
    calc: (bars, p) => ({ crsi: connorsRsi(source(bars, p.source), p.rsiLength, p.streakLength, p.rankLength) }),
  },
  laguerre: {
    name: t('ind.laguerre.name'), short: 'Laguerre RSI', description: t('ind.laguerre.desc'), category: 'Oscillators', overlay: false, precision: 3,
    params: [P('gamma', t('ind.p.gamma'), 0.5, 0.01, 0.99, 0.01), SRC()],
    levels: [0.8, 0.2],
    fills: [levelsFill(0.8, 0.2, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'lrsi', title: 'LRSI', color: '#7E57C2' }],
    calc: (bars, p) => ({ lrsi: laguerreRsi(source(bars, p.source), p.gamma) }),
  },
  gator: {
    name: t('ind.gator.name'), short: 'Gator', description: t('ind.gator.desc'), category: 'Oscillators', overlay: false,
    params: [
      P('jaw', t('ind.p.jawLength'), 13), P('jawOffset', t('ind.p.jawOffset'), 8, 0, 100), P('teeth', t('ind.p.teethLength'), 8),
      P('teethOffset', t('ind.p.teethOffset'), 5, 0, 100), P('lips', t('ind.p.lipsLength'), 5), P('lipsOffset', t('ind.p.lipsOffset'), 3, 0, 100),
    ],
    plots: [
      { key: 'upper', title: t('ind.plot.upper'), type: 'histogram', colorFn: (i, out) => (!(out.upper[i] < out.upper[i - 1]) ? '#26A69A' : '#EF5350') },
      { key: 'lower', title: t('ind.plot.lower'), type: 'histogram', colorFn: (i, out) => (!(out.lower[i] > out.lower[i - 1]) ? '#26A69A' : '#EF5350') },
    ],
    calc: (bars, p) => {
      const { jaw, teeth, lips } = alligator(bars, p.jaw, p.jawOffset, p.teeth, p.teethOffset, p.lips, p.lipsOffset);
      return { upper: jaw.map((v, i) => Math.abs(v - teeth[i])), lower: teeth.map((v, i) => -Math.abs(v - lips[i])) };
    },
  },
  imi: {
    name: t('ind.imi.name'), short: 'IMI', description: t('ind.imi.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 14)],
    levels: [70, 30],
    fills: [levelsFill(70, 30, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'imi', title: 'IMI', color: '#7E57C2' }],
    calc: (bars, p) => ({ imi: imi(bars, p.length) }),
  },
  zscore: {
    name: t('ind.zscore.name'), short: 'Z-Score', description: t('ind.zscore.desc'), category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 20), SRC()],
    levels: [2, 0, -2],
    fills: [levelsFill(2, -2, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'z', title: 'Z', color: '#4FA3F7' }],
    calc: (bars, p) => ({ z: zscore(source(bars, p.source), p.length) }),
  },

  // --- Momentum ---------------------------------------------------------------------
  macd: {
    name: t('ind.macd.name'), short: 'MACD', description: t('ind.macd.desc'), category: 'Momentum', overlay: false,
    params: [P('fast', t('ind.p.fastLength'), 12), P('slow', t('ind.p.slowLength'), 26), P('signal', t('ind.p.signalLength'), 9), SRC()],
    plots: [
      { key: 'hist', title: t('ind.plot.histogram'), type: 'histogram', colorFn: (i, out) => macdHistColor(out.hist, i) },
      { key: 'macd', title: 'MACD', color: '#4FA3F7' },
      { key: 'signal', title: t('ind.plot.signal'), color: '#FF6D00' },
    ],
    calc: (bars, p) => macd(source(bars, p.source), p.fast, p.slow, p.signal),
  },
  ao: {
    name: t('ind.ao.name'), short: 'AO', description: t('ind.ao.desc'), category: 'Momentum', overlay: false,
    params: [],
    plots: [{ key: 'ao', title: 'AO', type: 'histogram', colorFn: (i, out) => (out.ao[i] >= (out.ao[i - 1] ?? -Infinity) ? '#34B886' : '#EC5246') }],
    calc: (bars) => { const h = source(bars, 'hl2'), a = sma(h, 5), b = sma(h, 34); return { ao: a.map((v, i) => v - b[i]) }; },
  },
  mom: {
    name: t('ind.mom.name'), short: 'Mom', description: t('ind.mom.desc'), category: 'Momentum', overlay: false,
    params: [P('length', t('ind.p.length'), 10), SRC()],
    levels: [0],
    plots: [{ key: 'mom', title: 'Mom', color: '#4FA3F7' }],
    calc: (bars, p) => ({ mom: change(source(bars, p.source), p.length) }),
  },
  roc: {
    name: t('ind.roc.name'), short: 'ROC', description: t('ind.roc.desc'), category: 'Momentum', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 9), SRC()],
    levels: [0],
    plots: [{ key: 'roc', title: 'ROC', color: '#4FA3F7' }],
    calc: (bars, p) => ({ roc: roc(source(bars, p.source), p.length) }),
  },
  bop: {
    name: t('ind.bop.name'), short: 'BoP', description: t('ind.bop.desc'), category: 'Momentum', overlay: false, precision: 2,
    params: [],
    levels: [0],
    plots: [{ key: 'bop', title: 'BoP', color: '#EC5246' }],
    calc: (bars) => ({ bop: bars.map((b) => (b.high === b.low ? 0 : (b.close - b.open) / (b.high - b.low))) }),
  },
  efi: {
    name: t('ind.efi.name'), short: 'EFI', description: t('ind.efi.desc'), category: 'Momentum', overlay: false, format: 'volume',
    params: [P('length', t('ind.p.length'), 13)],
    levels: [0],
    plots: [{ key: 'efi', title: 'EFI', color: '#EC5246' }],
    calc: (bars, p) => ({ efi: ema(change(source(bars)).map((v, i) => v * bars[i].volume), p.length) }),
  },
  ppo: {
    name: t('ind.ppo.name'), short: 'PPO', description: t('ind.ppo.desc'), category: 'Momentum', overlay: false, precision: 2,
    params: [P('fast', t('ind.p.fastLength'), 12), P('slow', t('ind.p.slowLength'), 26), P('signal', t('ind.p.signalLength'), 9), SRC()],
    plots: [
      { key: 'hist', title: t('ind.plot.histogram'), type: 'histogram', colorFn: (i, out) => macdHistColor(out.hist, i) },
      { key: 'ppo', title: 'PPO', color: '#4FA3F7' },
      { key: 'signal', title: t('ind.plot.signal'), color: '#FF6D00' },
    ],
    calc: (bars, p) => ppo(source(bars, p.source), p.fast, p.slow, p.signal),
  },
  kst: {
    name: t('ind.kst.name'), short: 'KST', description: t('ind.kst.desc'), category: 'Momentum', overlay: false, precision: 2,
    params: [
      P('roc1', 'ROC #1', 10), P('roc2', 'ROC #2', 15), P('roc3', 'ROC #3', 20), P('roc4', 'ROC #4', 30),
      P('sma1', 'SMA #1', 10), P('sma2', 'SMA #2', 10), P('sma3', 'SMA #3', 10), P('sma4', 'SMA #4', 15), P('signal', t('ind.p.signalLength'), 9),
    ],
    levels: [0],
    plots: [{ key: 'kst', title: 'KST', color: '#009688' }, { key: 'signal', title: t('ind.plot.signal'), color: '#F44336' }],
    calc: (bars, p) => kst(source(bars), p.roc1, p.roc2, p.roc3, p.roc4, p.sma1, p.sma2, p.sma3, p.sma4, p.signal),
  },
  elderray: {
    name: t('ind.elderray.name'), short: 'Elder Ray', description: t('ind.elderray.desc'), category: 'Momentum', overlay: false,
    params: [P('length', t('ind.p.lengthOf', { name: 'EMA' }), 13)],
    plots: [{ key: 'bull', title: t('ind.plot.bullPower'), type: 'histogram', color: '#26A69A' }, { key: 'bear', title: t('ind.plot.bearPower'), type: 'histogram', color: '#EF5350' }],
    calc: (bars, p) => elderRay(bars, p.length),
  },
  qstick: {
    name: t('ind.qstick.name'), short: 'Qstick', description: t('ind.qstick.desc'), category: 'Momentum', overlay: false,
    params: [P('length', t('ind.p.length'), 8)],
    levels: [0],
    plots: [{ key: 'q', title: 'Qstick', color: '#4FA3F7' }],
    calc: (bars, p) => ({ q: qstick(bars, p.length) }),
  },
  ac: {
    name: t('ind.ac.name'), short: 'AC', description: t('ind.ac.desc'), category: 'Momentum', overlay: false,
    params: [],
    plots: [{ key: 'ac', title: 'AC', type: 'histogram', colorFn: (i, out) => (!(out.ac[i] < out.ac[i - 1]) ? '#34B886' : '#EC5246') }],
    calc: (bars) => {
      const h = source(bars, 'hl2'), a = sma(h, 5), b = sma(h, 34), ao = a.map((v, i) => v - b[i]), s = sma(ao, 5);
      return { ac: ao.map((v, i) => v - s[i]) };
    },
  },
  squeeze: {
    name: t('ind.squeeze.name'), short: 'Squeeze', description: t('ind.squeeze.desc'), category: 'Momentum', overlay: false,
    params: [
      P('length', t('ind.p.lengthOf', { name: 'BB' }), 20), P('mult', t('ind.p.bbStdDev'), 2, 0.1, 10, 0.1),
      P('kcLength', t('ind.p.lengthOf', { name: 'KC' }), 20, 2), P('kcMult', t('ind.p.multOf', { name: 'KC' }), 1.5, 0.1, 10, 0.1),
    ],
    plots: [
      { key: 'value', title: t('ind.plot.momentum'), type: 'histogram', colorFn: (i, out) => macdHistColor(out.value, i) },
      // dots on the zero line: red = squeeze on, green = released, blue = neither
      { key: 'sqz', title: 'Squeeze', type: 'dots', colorFn: (i, out) => (out.state[i] === 1 ? '#F23645' : out.state[i] === -1 ? '#089981' : '#4FA3F7') },
    ],
    calc: (bars, p) => {
      const { value, state } = squeeze(bars, p.length, p.mult, p.kcLength, p.kcMult);
      return { value, state, sqz: state.map((s) => (isNum(s) ? 0 : NaN)) };
    },
  },

  // --- Trend strength ---------------------------------------------------------------
  adx: {
    name: t('ind.adx.name'), short: 'DMI', description: t('ind.adx.desc'), category: 'Trend strength', overlay: false, precision: 2,
    params: [P('diLength', t('ind.p.lengthOf', { name: 'DI' }), 14), P('adxLength', t('ind.p.smoothingOf', { name: 'ADX' }), 14)],
    plots: [
      { key: 'adx', title: 'ADX', color: '#F50057' },
      { key: 'plus', title: '+DI', color: '#4FA3F7' },
      { key: 'minus', title: '−DI', color: '#FF6D00' },
    ],
    calc: (bars, p) => dmi(bars, p.diLength, p.adxLength),
  },
  aroon: {
    name: t('ind.aroon.name'), short: 'Aroon', description: t('ind.aroon.desc'), category: 'Trend strength', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 14)],
    plots: [{ key: 'up', title: t('ind.plot.up'), color: '#FB8C00' }, { key: 'down', title: t('ind.plot.down'), color: '#4FA3F7' }],
    calc: (bars, p) => {
      const hs = barsSinceExtreme(pick(bars, 'high'), p.length, (a, b) => a > b);
      const ls = barsSinceExtreme(pick(bars, 'low'), p.length, (a, b) => a < b);
      return { up: hs.map((v) => (100 * (p.length - v)) / p.length), down: ls.map((v) => (100 * (p.length - v)) / p.length) };
    },
  },
  vortex: {
    name: t('ind.vortex.name'), short: 'VI', description: t('ind.vortex.desc'), category: 'Trend strength', overlay: false, precision: 3,
    params: [P('length', t('ind.p.length'), 14)],
    plots: [{ key: 'plus', title: 'VI+', color: '#4FA3F7' }, { key: 'minus', title: 'VI−', color: '#E91E63' }],
    calc: (bars, p) => {
      const vp = bars.map((b, i) => (i ? Math.abs(b.high - bars[i - 1].low) : NaN));
      const vm = bars.map((b, i) => (i ? Math.abs(b.low - bars[i - 1].high) : NaN));
      const t = sum(tr(bars), p.length), sp = sum(vp, p.length), sm = sum(vm, p.length);
      return { plus: sp.map((v, i) => v / t[i]), minus: sm.map((v, i) => v / t[i]) };
    },
  },
  chop: {
    name: t('ind.chop.name'), short: 'CHOP', description: t('ind.chop.desc'), category: 'Trend strength', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 14)],
    levels: [61.8, 38.2],
    fills: [levelsFill(61.8, 38.2, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'chop', title: 'CHOP', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const s = sum(tr(bars), p.length);
      const hh = highest(pick(bars, 'high'), p.length), ll = lowest(pick(bars, 'low'), p.length);
      return { chop: s.map((v, i) => (100 * Math.log10(v / (hh[i] - ll[i]))) / Math.log10(p.length)) };
    },
  },
  lrslope: {
    name: t('ind.lrslope.name'), short: 'LR Slope', description: t('ind.lrslope.desc'), category: 'Trend strength', overlay: false,
    params: [P('length', t('ind.p.length'), 20, 2), SRC()],
    levels: [0],
    plots: [{ key: 'slope', title: t('ind.plot.slope'), color: '#4FA3F7' }],
    calc: (bars, p) => ({ slope: linregSlope(source(bars, p.source), p.length) }),
  },
  rwi: {
    name: t('ind.rwi.name'), short: 'RWI', description: t('ind.rwi.desc'), category: 'Trend strength', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 14)],
    levels: [1],
    plots: [{ key: 'high', title: t('ind.plot.rwiHigh'), color: '#26A69A' }, { key: 'low', title: t('ind.plot.rwiLow'), color: '#EF5350' }],
    calc: (bars, p) => rwi(bars, p.length),
  },
  vhf: {
    name: t('ind.vhf.name'), short: 'VHF', description: t('ind.vhf.desc'), category: 'Trend strength', overlay: false, precision: 3,
    params: [P('length', t('ind.p.length'), 28), SRC()],
    plots: [{ key: 'vhf', title: 'VHF', color: '#4FA3F7' }],
    calc: (bars, p) => ({ vhf: vhf(source(bars, p.source), p.length) }),
  },
  er: {
    name: t('ind.er.name'), short: 'ER', description: t('ind.er.desc'), category: 'Trend strength', overlay: false, precision: 3,
    params: [P('length', t('ind.p.length'), 10), SRC()],
    plots: [{ key: 'er', title: 'ER', color: '#FF9800' }],
    calc: (bars, p) => ({ er: er(source(bars, p.source), p.length) }),
  },
  pfe: {
    name: t('ind.pfe.name'), short: 'PFE', description: t('ind.pfe.desc'), category: 'Trend strength', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 10), P('smooth', t('ind.p.smoothing'), 5), SRC()],
    levels: [0],
    plots: [{ key: 'pfe', title: 'PFE', color: '#4FA3F7' }],
    calc: (bars, p) => ({ pfe: pfe(source(bars, p.source), p.length, p.smooth) }),
  },

  // --- Volume ------------------------------------------------------------------------
  volume: {
    name: t('ind.volume.name'), short: 'Vol', description: t('ind.volume.desc'), category: 'Volume', overlay: true, scale: 'volume', format: 'volume',
    params: [],
    plots: [{
      key: 'vol', title: t('common.volume'), type: 'histogram',
      colorFn: (i, out, bars) => alpha(bars[i].close >= bars[i].open ? UP : DOWN, 0.45),
    }],
    calc: (bars) => ({ vol: bars.map((b) => b.volume) }),
  },
  obv: {
    name: t('ind.obv.name'), short: 'OBV', description: t('ind.obv.desc'), category: 'Volume', overlay: false, format: 'volume',
    params: [],
    plots: [{ key: 'obv', title: 'OBV', color: '#4FA3F7' }],
    calc: (bars) => ({ obv: obv(bars) }),
  },
  ad: {
    name: t('ind.ad.name'), short: 'A/D', description: t('ind.ad.desc'), category: 'Volume', overlay: false, format: 'volume',
    params: [],
    plots: [{ key: 'ad', title: 'A/D', color: '#999915' }],
    calc: (bars) => ({ ad: cum(bars.map((b) => (b.high === b.low ? 0 : (((b.close - b.low) - (b.high - b.close)) / (b.high - b.low)) * b.volume))) }),
  },
  cmf: {
    name: t('ind.cmf.name'), short: 'CMF', description: t('ind.cmf.desc'), category: 'Volume', overlay: false, precision: 3,
    params: [P('length', t('ind.p.length'), 20)],
    levels: [0],
    plots: [{ key: 'cmf', title: 'CMF', color: '#43A047' }],
    calc: (bars, p) => {
      const mfv = bars.map((b) => (b.high === b.low ? 0 : (((b.close - b.low) - (b.high - b.close)) / (b.high - b.low)) * b.volume));
      const a = sum(mfv, p.length), v = sum(pick(bars, 'volume'), p.length);
      return { cmf: a.map((x, i) => (v[i] ? x / v[i] : 0)) };
    },
  },
  chaikinosc: {
    name: t('ind.chaikinosc.name'), short: 'Chaikin Osc', description: t('ind.chaikinosc.desc'), category: 'Volume', overlay: false, format: 'volume',
    params: [P('fast', t('ind.p.fast'), 3), P('slow', t('ind.p.slow'), 10)],
    levels: [0],
    plots: [{ key: 'osc', title: 'Chaikin Osc', color: '#EC407A' }],
    calc: (bars, p) => {
      const ad = INDICATORS.ad.calc(bars).ad;
      const f = ema(ad, p.fast), s = ema(ad, p.slow);
      return { osc: f.map((v, i) => v - s[i]) };
    },
  },
  pvt: {
    name: t('ind.pvt.name'), short: 'PVT', description: t('ind.pvt.desc'), category: 'Volume', overlay: false, format: 'volume',
    params: [],
    plots: [{ key: 'pvt', title: 'PVT', color: '#4FA3F7' }],
    calc: (bars) => ({ pvt: cum(bars.map((b, i) => (i ? ((b.close - bars[i - 1].close) / bars[i - 1].close) * b.volume : 0))) }),
  },
  volosc: {
    name: t('ind.volosc.name'), short: 'Vol Osc', description: t('ind.volosc.desc'), category: 'Volume', overlay: false, precision: 2,
    params: [P('fast', t('ind.p.shortLength'), 5), P('slow', t('ind.p.longLength'), 10)],
    levels: [0],
    plots: [{ key: 'osc', title: 'Vol Osc', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const v = pick(bars, 'volume'), f = ema(v, p.fast), s = ema(v, p.slow);
      return { osc: f.map((x, i) => (s[i] ? (100 * (x - s[i])) / s[i] : 0)) };
    },
  },
  klinger: {
    name: t('ind.klinger.name'), short: 'KVO', description: t('ind.klinger.desc'), category: 'Volume', overlay: false, format: 'volume',
    params: [P('fast', t('ind.p.fastLength'), 34), P('slow', t('ind.p.slowLength'), 55), P('signal', t('ind.p.signalLength'), 13)],
    levels: [0],
    plots: [{ key: 'kvo', title: 'KVO', color: '#4FA3F7' }, { key: 'signal', title: t('ind.plot.signal'), color: '#43A047' }],
    calc: (bars, p) => klinger(bars, p.fast, p.slow, p.signal),
  },
  eom: {
    name: t('ind.eom.name'), short: 'EOM', description: t('ind.eom.desc'), category: 'Volume', overlay: false,
    params: [P('length', t('ind.p.length'), 14), P('divisor', t('ind.p.divisor'), 10000, 1, 1e12, 1)],
    levels: [0],
    plots: [{ key: 'eom', title: 'EOM', color: '#43A047' }],
    calc: (bars, p) => ({ eom: eom(bars, p.length, p.divisor) }),
  },
  nvi: {
    name: t('ind.nvi.name'), short: 'NVI', description: t('ind.nvi.desc'), category: 'Volume', overlay: false, precision: 2,
    params: [P('signal', t('ind.p.lengthOf', { name: 'EMA' }), 255)],
    plots: [{ key: 'nvi', title: 'NVI', color: '#4FA3F7' }, { key: 'signal', title: 'EMA', color: '#FF6D00', width: 1 }],
    calc: (bars, p) => { const v = nvi(bars); return { nvi: v, signal: ema(v, p.signal) }; },
  },
  pvi: {
    name: t('ind.pvi.name'), short: 'PVI', description: t('ind.pvi.desc'), category: 'Volume', overlay: false, precision: 2,
    params: [P('signal', t('ind.p.lengthOf', { name: 'EMA' }), 255)],
    plots: [{ key: 'pvi', title: 'PVI', color: '#4FA3F7' }, { key: 'signal', title: 'EMA', color: '#FF6D00', width: 1 }],
    calc: (bars, p) => { const v = pvi(bars); return { pvi: v, signal: ema(v, p.signal) }; },
  },
  pvo: {
    name: t('ind.pvo.name'), short: 'PVO', description: t('ind.pvo.desc'), category: 'Volume', overlay: false, precision: 2,
    params: [P('fast', t('ind.p.fastLength'), 12), P('slow', t('ind.p.slowLength'), 26), P('signal', t('ind.p.signalLength'), 9)],
    plots: [
      { key: 'hist', title: t('ind.plot.histogram'), type: 'histogram', colorFn: (i, out) => macdHistColor(out.hist, i) },
      { key: 'ppo', title: 'PVO', color: '#4FA3F7' },
      { key: 'signal', title: t('ind.plot.signal'), color: '#FF6D00' },
    ],
    calc: (bars, p) => ppo(pick(bars, 'volume'), p.fast, p.slow, p.signal),
  },
  vwmacd: {
    name: t('ind.vwmacd.name'), short: 'VW-MACD', description: t('ind.vwmacd.desc'), category: 'Volume', overlay: false,
    params: [P('fast', t('ind.p.fastLength'), 12), P('slow', t('ind.p.slowLength'), 26), P('signal', t('ind.p.signalLength'), 9)],
    plots: [
      { key: 'hist', title: t('ind.plot.histogram'), type: 'histogram', colorFn: (i, out) => macdHistColor(out.hist, i) },
      { key: 'macd', title: 'VW-MACD', color: '#4FA3F7' },
      { key: 'signal', title: t('ind.plot.signal'), color: '#FF6D00' },
    ],
    calc: (bars, p) => vwmacd(bars, p.fast, p.slow, p.signal),
  },

  // --- Volatility ----------------------------------------------------------------------
  atr: {
    name: t('ind.atr.name'), short: 'ATR', description: t('ind.atr.desc'), category: 'Volatility', overlay: false,
    params: [P('length', t('ind.p.length'), 14)],
    plots: [{ key: 'atr', title: 'ATR', color: '#EC5246' }],
    calc: (bars, p) => ({ atr: atr(bars, p.length) }),
  },
  hv: {
    name: t('ind.hv.name'), short: 'HV', description: t('ind.hv.desc'), category: 'Volatility', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 10)],
    plots: [{ key: 'hv', title: 'HV', color: '#4FA3F7' }],
    calc: (bars, p, ctx = {}) => {
      const r = bars.map((b, i) => (i ? Math.log(b.close / bars[i - 1].close) : NaN));
      const per = (ctx.tfSec || DAY) > DAY ? 7 : 1;
      return { hv: stdev(r, p.length).map((v) => 100 * v * Math.sqrt(365 / per)) };
    },
  },
  bbw: {
    name: t('ind.bbw.name'), short: 'BBW', description: t('ind.bbw.desc'), category: 'Volatility', overlay: false, precision: 4,
    params: [P('length', t('ind.p.length'), 20), P('mult', t('ind.p.stdDev'), 2, 0.1, 10, 0.1)],
    plots: [{ key: 'w', title: 'BBW', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const { upper, lower, basis } = bb(source(bars), p.length, p.mult);
      return { w: upper.map((u, i) => (u - lower[i]) / basis[i]) };
    },
  },
  stdevind: {
    name: t('ind.stdevind.name'), short: 'StdDev', description: t('ind.stdevind.desc'), category: 'Volatility', overlay: false,
    params: [P('length', t('ind.p.length'), 20), SRC()],
    plots: [{ key: 'sd', title: 'StdDev', color: '#4FA3F7' }],
    calc: (bars, p) => ({ sd: stdev(source(bars, p.source), p.length) }),
  },
  atrp: {
    name: t('ind.atrp.name'), short: 'ATR %', description: t('ind.atrp.desc'), category: 'Volatility', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 14)],
    plots: [{ key: 'atrp', title: 'ATR %', color: '#EC5246' }],
    calc: (bars, p) => ({ atrp: atrp(bars, p.length) }),
  },
  chaikinvol: {
    name: t('ind.chaikinvol.name'), short: 'Chaikin Vol', description: t('ind.chaikinvol.desc'), category: 'Volatility', overlay: false, precision: 2,
    params: [P('length', t('ind.p.lengthOf', { name: 'EMA' }), 10), P('roc', t('ind.p.lengthOf', { name: 'ROC' }), 10)],
    levels: [0],
    plots: [{ key: 'cv', title: 'CV', color: '#4FA3F7' }],
    calc: (bars, p) => ({ cv: chaikinVolatility(bars, p.length, p.roc) }),
  },
  ulcer: {
    name: t('ind.ulcer.name'), short: 'Ulcer', description: t('ind.ulcer.desc'), category: 'Volatility', overlay: false, precision: 2,
    params: [P('length', t('ind.p.length'), 14), SRC()],
    plots: [{ key: 'ui', title: 'UI', color: '#EC5246' }],
    calc: (bars, p) => ({ ui: ulcer(source(bars, p.source), p.length) }),
  },
  massindex: {
    name: t('ind.massindex.name'), short: 'Mass', description: t('ind.massindex.desc'), category: 'Volatility', overlay: false, precision: 2,
    params: [P('length', t('ind.p.lengthOf', { name: 'EMA' }), 9), P('sum', t('ind.p.sumLength'), 25)],
    levels: [27, 26.5],
    plots: [{ key: 'mi', title: 'Mass', color: '#4FA3F7' }],
    calc: (bars, p) => ({ mi: massIndex(bars, p.length, p.sum) }),
  },
  rvi: {
    name: t('ind.rvi.name'), short: 'RVI', description: t('ind.rvi.desc'), category: 'Volatility', overlay: false, precision: 2,
    params: [P('length', t('ind.p.stdDevLength'), 10), P('smooth', t('ind.p.smoothing'), 14), SRC()],
    levels: [80, 20],
    fills: [levelsFill(80, 20, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'rvi', title: 'RVI', color: '#7E57C2' }],
    calc: (bars, p) => ({ rvi: rvi(source(bars, p.source), p.length, p.smooth) }),
  },
};

export function defaultParams(type, defs = INDICATORS) {
  const out = {};
  for (const p of defs[type]?.params || []) out[p.key] = p.def;
  return out;
}

export function indicatorLabel(def, inst) {
  const vals = (def.params || []).map((p) => inst.params?.[p.key] ?? p.def);
  return vals.length ? `${def.short} ${vals.join(' ')}` : def.short;
}

export function heikinAshi(bars) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = heikinAshiAt(bars, out, i);
  return out;
}

export function heikinAshiAt(bars, ha, i) {
  const b = bars[i];
  const close = (b.open + b.high + b.low + b.close) / 4;
  const open = i === 0 ? (b.open + b.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
  return {
    time: b.time, open, close,
    high: Math.max(b.high, open, close),
    low: Math.min(b.low, open, close),
  };
}

/** The toolkit user scripts get as `ta` (bar-based helpers are bound to the chart's bars in the worker). */
export const TA = {
  sma, ema, wma, rma, hma, dema, tema, alma, linreg, stdev, sum, cum, highest, lowest, change, mom, roc, shift,
  rsi, macd, bb, stoch, cci, crossover, crossunder, cross, pivothigh, pivotlow, vwma,
  kama, zlema, t3, mcginley, vidya, trima, linregSlope, stderrBands, ppo, kst, stc, zscore, laguerreRsi,
  connorsRsi, streak, percentrank, rvi, er, vhf, pfe, ulcer,
  // these take the chart's bars as their first argument; the worker binds them
  bars: {
    atr, tr, mfi, obv, wpr, dmi, supertrend, vwap, psar,
    alligator, chandelier, chandeKroll, ssl, rwi, elderRay, massIndex, smi, rvgi, imi, qstick, squeeze,
    klinger, eom, nvi, pvi, vwmacd, atrp, chaikinVolatility, starc, vwapBands,
  },
};
