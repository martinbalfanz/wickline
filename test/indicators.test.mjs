// Tests for public/js/indicators.js: known values for the core math, and every built-in
// indicator runs on realistic data without throwing and stays aligned with the bars.
import assert from 'node:assert/strict';
import * as I from '../public/js/indicators.js';

const { sma, ema, rsi, stdev, highest, lowest, crossover, crossunder, atr, macd, INDICATORS, CATEGORIES, TA, defaultParams, heikinAshi } = I;

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const near = (a, b, eps, what = '') => assert.ok(close(a, b, eps), `${what} ${a} != ${b}`);
const isNaNs = (arr) => arr.every((v) => Number.isNaN(v));
const bar = (time, open, high, low, closeP, volume = 1000) => ({ time, open, high, low, close: closeP, volume });

// A deterministic random walk with 5-minute bars: drifting returns, varying ranges, volume
// spikes and the odd zero-volume bar, like a thin real market.
let seed = 42;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const makeBars = (n, { volume = true } = {}) => {
  const out = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const o = c * (1 + (rnd() - 0.5) * 0.002); // small gap from the last close
    c = Math.max(1, o * (1 + (rnd() - 0.49) * 0.02));
    const v = !volume || i % 97 === 13 ? 0 : Math.round((1000 + rnd() * 5000) * (i % 23 === 0 ? 4 : 1));
    out.push(bar(1_700_000_000 + i * 300, o, Math.max(o, c) * (1 + rnd() * 0.004), Math.min(o, c) * (1 - rnd() * 0.004), c, v));
  }
  return out;
};
const bars = makeBars(600);
const ctx = { tfSec: 300 };

test('sma of 1..5 over 3', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
  assert.deepEqual(out.slice(2), [2, 3, 4]);
});

test('ema seeds and converges', () => {
  const out = ema([10, 10, 10, 10, 10], 3);
  assert.ok(close(out.at(-1), 10));
  const up = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.ok(up.at(-1) > 8 && up.at(-1) < 10, `ema ${up.at(-1)}`);
});

test('rsi is 100 on a straight rise and 0 on a straight fall', () => {
  const rise = Array.from({ length: 40 }, (_, i) => i + 1);
  assert.ok(close(rsi(rise, 14).at(-1), 100, 1e-6));
  const fall = rise.slice().reverse();
  assert.ok(close(rsi(fall, 14).at(-1), 0, 1e-6));
});

test('rsi stays within 0..100 on random data', () => {
  for (const v of rsi(bars.map((b) => b.close), 14)) if (Number.isFinite(v)) assert.ok(v >= 0 && v <= 100, String(v));
});

test('stdev of a constant is 0', () => {
  assert.ok(close(stdev([5, 5, 5, 5, 5], 3).at(-1), 0));
});

test('highest / lowest over a window', () => {
  assert.equal(highest([1, 5, 3, 2, 4], 3).at(-1), 4);
  assert.equal(lowest([1, 5, 3, 2, 4], 3).at(-1), 2);
});

test('crossover / crossunder mark exactly the crossing bar', () => {
  const a = [1, 2, 3, 2, 1], b = [2, 2, 2, 2, 2];
  assert.deepEqual(crossover(a, b).map(Boolean), [false, false, true, false, false]);
  assert.deepEqual(crossunder(a, b).map(Boolean), [false, false, false, false, true]);
});

test('atr is positive once warmed up', () => {
  const out = atr(bars, 14);
  assert.ok(out.at(-1) > 0);
});

test('heikin ashi keeps the bar count', () => {
  assert.equal(heikinAshi(bars).length, bars.length);
});

// --- the whole registry ---------------------------------------------------------------

const run = (type, data) => {
  try { return INDICATORS[type].calc(data, defaultParams(type), ctx); } catch (e) { throw new Error(`${type}: ${e.message}`); }
};
const checkShape = (type, out, n) => {
  for (const plot of INDICATORS[type].plots) {
    const values = out[plot.key];
    if (plot.optional && values == null) continue;
    assert.ok(Array.isArray(values), `${type}.${plot.key} is not an array`);
    assert.equal(values.length, n, `${type}.${plot.key} has ${values.length} values for ${n} bars`);
  }
};

test(`there are 100 built-in indicators, each well formed (${Object.keys(INDICATORS).length})`, () => {
  assert.equal(Object.keys(INDICATORS).length, 100);
  for (const [type, def] of Object.entries(INDICATORS)) {
    assert.ok(def.name && def.short && def.description, `${type} needs name, short and description`);
    assert.ok(CATEGORIES.includes(def.category), `${type} has unknown category ${def.category}`);
    assert.equal(typeof def.overlay, 'boolean', `${type}.overlay`);
    assert.ok(Array.isArray(def.params) && Array.isArray(def.plots) && def.plots.length, `${type} params/plots`);
    assert.equal(new Set(def.plots.map((p) => p.key)).size, def.plots.length, `${type} has duplicate plot keys`);
    for (const p of def.params) assert.ok(p.type === 'select' ? p.options.includes(p.def) : p.def >= p.min && p.def <= p.max, `${type}.${p.key} default out of range`);
    for (const f of def.fills || []) for (const k of [f.from, f.to]) assert.ok(def.plots.some((p) => p.key === k) || k in (f.consts || {}), `${type} fill uses unknown ${k}`);
  }
});

test('every built-in indicator runs on 600 bars, stays aligned and is mostly finite after warm-up', () => {
  for (const type of Object.keys(INDICATORS)) {
    const out = run(type, bars);
    checkShape(type, out, bars.length);
    for (const plot of INDICATORS[type].plots) {
      const values = out[plot.key];
      if (plot.optional) { assert.ok(values.some(Number.isFinite), `${type}.${plot.key} is never drawn`); continue; }
      const tail = values.slice(300); // the longest default warm-up (NVI/PVI's 255 EMA) is over by here
      const finite = tail.filter(Number.isFinite).length;
      assert.ok(finite >= 0.85 * tail.length, `${type}.${plot.key}: only ${finite}/${tail.length} finite values after warm-up`);
      assert.ok(values.every((v) => Number.isFinite(v) || Number.isNaN(v)), `${type}.${plot.key} has a non-number or infinite value`);
    }
  }
});

test('every built-in indicator survives 0, 1 and 5 bars of history', () => {
  for (const n of [0, 1, 5]) {
    const short = makeBars(n);
    for (const type of Object.keys(INDICATORS)) checkShape(type, run(type, short), n);
  }
});

test('every built-in indicator survives zero volume', () => {
  const flat = makeBars(600, { volume: false });
  for (const type of Object.keys(INDICATORS)) {
    const out = run(type, flat);
    checkShape(type, out, flat.length);
    for (const plot of INDICATORS[type].plots) {
      if (out[plot.key]) assert.ok(out[plot.key].every((v) => !(v === Infinity || v === -Infinity)), `${type}.${plot.key} is infinite`);
    }
  }
});

test('warm-up bars are NaN, not 0 (new indicators)', () => {
  const head = makeBars(8);
  for (const type of ['kama', 'zlema', 't3', 'mcginley', 'vidya', 'trima', 'stc', 'kst', 'ppo', 'crsi', 'massindex', 'ulcer', 'zscore', 'pfe', 'smi', 'rvi', 'klinger', 'vwmacd']) {
    const out = run(type, head);
    assert.ok(Number.isNaN(out[INDICATORS[type].plots.find((p) => !p.type).key][0]), `${type} has a value on the first bar`);
  }
});

test('indicators do not repaint: adding bars never changes earlier values', () => {
  // The chart's live update only redraws the newest bars, so past values must be stable.
  const repaints = new Set(['ichimoku']); // its lagging span is the close 25 bars later, by design
  const part = bars.slice(0, 450);
  for (const type of Object.keys(INDICATORS)) {
    if (repaints.has(type)) continue;
    const a = run(type, part), b = run(type, bars);
    for (const plot of INDICATORS[type].plots) {
      if (!a[plot.key]) continue;
      for (let i = 0; i < part.length; i++) {
        const x = a[plot.key][i], y = b[plot.key][i];
        assert.ok(Number.isNaN(x) ? Number.isNaN(y) : close(x, y, 1e-9), `${type}.${plot.key}[${i}] changed from ${x} to ${y}`);
      }
    }
  }
});

test('bounded oscillators stay in range', () => {
  const ranges = { stc: [0, 100], crsi: [0, 100], laguerre: [0, 1], imi: [0, 100], rvi: [0, 100], er: [0, 1], vhf: [0, 1], smi: [-100, 100], pfe: [-100, 100] };
  for (const [type, [lo, hi]] of Object.entries(ranges)) {
    const out = run(type, bars), key = INDICATORS[type].plots[0].key;
    for (const v of out[key]) if (Number.isFinite(v)) assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `${type} = ${v}`);
  }
});

// --- exact values of the new math ------------------------------------------------------

test('KAMA matches a hand calculation', () => {
  // ER(3) = |12−10| / (1+1+2) = 0.5 on both bars; SC = (0.5 × (2/3 − 2/31) + 2/31)²; seeded with the prior close.
  const sc = (0.5 * (2 / 3 - 2 / 31) + 2 / 31) ** 2;
  const out = I.kama([10, 11, 10, 12, 13], 3, 2, 30);
  assert.ok(isNaNs(out.slice(0, 3)));
  near(out[3], 10 + sc * 2, 1e-12, 'kama[3]');
  near(out[4], out[3] + sc * (13 - out[3]), 1e-12, 'kama[4]');
  near(out[4], 10.6325569, 1e-7, 'kama[4]');
});

test('Efficiency Ratio: 0.5 on a hand example, 1 on a straight line', () => {
  assert.deepEqual(I.er([10, 11, 10, 12, 13], 3).slice(3), [0.5, 0.5]);
  assert.equal(I.er([1, 2, 3, 4, 5, 6], 3).at(-1), 1);
  assert.equal(INDICATORS.er.calc([1, 2, 3, 4, 5].map((c, i) => bar(i, c, c, c, c)), { length: 2, source: 'close' }).er.at(-1), 1);
});

test('PPO matches a hand calculation and equals 100 × MACD / slow EMA', () => {
  // EMA(1) is the price; EMA(2) seeds at 15 then 2/3 × 30 + 1/3 × 15 = 25.
  const r = I.ppo([10, 20, 30], 1, 2, 1);
  near(r.ppo[1], 100 * 5 / 15, 1e-12);
  near(r.ppo[2], 20, 1e-12);
  assert.equal(r.hist[2], 0);
  const c = bars.map((b) => b.close), m = macd(c, 12, 26, 9).macd, slow = ema(c, 26), p = I.ppo(c).ppo;
  for (let i = 0; i < c.length; i++) if (Number.isFinite(m[i])) near(p[i], (100 * m[i]) / slow[i], 1e-9, `ppo[${i}]`);
});

test('Mass Index: 25 for a constant range, and a hand example', () => {
  const flat = Array.from({ length: 80 }, (_, i) => bar(i, 10, 11, 9, 10));
  near(I.massIndex(flat).at(-1), 25, 1e-12, 'constant range');
  // ranges 2, 4, 4: EMA(2) = 3, 11/3; EMA of that = 10/3 → ratio 1.1
  const b = [2, 4, 4].map((r, i) => bar(i, 10, 10 + r / 2, 10 - r / 2, 10));
  near(I.massIndex(b, 2, 1)[2], 1.1, 1e-12);
});

test('Ulcer Index matches a hand calculation', () => {
  // drawdowns over 2 bars: −20 % (8 vs 10), then 0 % (9 is the high) → √((400 + 0) / 2)
  const out = I.ulcer([10, 8, 9], 2);
  near(out[2], Math.sqrt(200), 1e-12);
  assert.ok(isNaNs(out.slice(0, 2)));
  assert.equal(I.ulcer(Array.from({ length: 40 }, (_, i) => i + 1)).at(-1), 0); // never below the high
});

test('Z-Score matches a hand calculation', () => {
  near(I.zscore([1, 2, 3, 4, 5], 5)[4], Math.SQRT2, 1e-12); // (5 − 3) / √2
  assert.equal(I.zscore([4, 4, 4], 3)[2], 0);
});

test('Elder Ray matches a hand calculation', () => {
  // EMA(3) of 1, 2, 3, 4 = 2 then 3; highs are close + 1, lows close − 0.5
  const b = [1, 2, 3, 4].map((c, i) => bar(i, c, c + 1, c - 0.5, c));
  const r = I.elderRay(b, 3);
  assert.deepEqual(r.bull.slice(2), [2, 2]);
  assert.deepEqual(r.bear.slice(2), [0.5, 0.5]);
});

test('ATR % is 20 for bars with a 2-point range at 10', () => {
  const b = Array.from({ length: 20 }, (_, i) => bar(i, 10, 11, 9, 10));
  const out = I.atrp(b, 14);
  assert.ok(isNaNs(out.slice(0, 13)));
  near(out[13], 20, 1e-12);
  near(out.at(-1), 20, 1e-12);
});

test('TRIMA is the 1-2-2-1 triangular average for length 4', () => {
  assert.deepEqual(I.trima([1, 2, 3, 4, 5, 6], 4).slice(3), [(1 + 4 + 6 + 4) / 6, 3.5, 4.5]);
});

test('McGinley Dynamic matches a hand calculation', () => {
  // seed SMA(3) = 10, then 10 + (12 − 10) / (3 × 1.2⁴)
  near(I.mcginley([10, 10, 10, 12], 3)[3], 10 + 2 / (3 * 1.2 ** 4), 1e-12);
});

test('PFE is 100 on a straight line', () => {
  const out = I.pfe(Array.from({ length: 40 }, (_, i) => 100 + 0.5 * i));
  near(out.at(-1), 100, 1e-12);
});

test('linear regression slope and standard error bands', () => {
  // y = 1, 2, 4 on x = 0, 1, 2: slope 1.5, fit end 23/6, residuals 1/6, −1/3, 1/6 → SE = √(1/6)
  near(I.linregSlope([1, 2, 4], 3)[2], 1.5, 1e-12);
  const b = I.stderrBands([1, 2, 4], 3, 1, 1);
  near(b.basis[2], 23 / 6, 1e-12);
  near(b.upper[2] - b.basis[2], Math.sqrt(1 / 6), 1e-12);
  // perfect fit: SE 0, so the band is the 3-bar SMA of the last fits (54, 56, 58)
  near(I.stderrBands(Array.from({ length: 30 }, (_, i) => 2 * i), 21, 2, 3).upper.at(-1), 56, 1e-9);
});

test('streak, percent rank and Connors RSI', () => {
  assert.deepEqual(I.streak([1, 2, 3, 3, 2, 1, 2]), [0, 1, 2, 0, -1, -2, 1]);
  assert.deepEqual(I.percentrank([1, 3, 2, 5, 4], 2).slice(2), [50, 100, 50]);
  const c = bars.map((b) => b.close), out = I.connorsRsi(c);
  assert.ok(isNaNs(out.slice(0, 101)) && Number.isFinite(out[101]));
});

test('VWAP bands: volume-weighted mean and deviation', () => {
  const r = I.vwapBands([bar(0, 10, 11, 9, 10, 1), bar(60, 12, 13, 11, 12, 3)]);
  assert.deepEqual(r.vwap, [10, 11.5]); // (10 + 3 × 12) / 4
  near(r.dev[1], Math.sqrt(0.75), 1e-12); // (1 × 1.5² + 3 × 0.5²) / 4
});

test('T3 and Laguerre RSI settle on simple series', () => {
  near(I.t3(new Array(60).fill(7)).at(-1), 7, 1e-12);
  const lr = I.laguerreRsi(Array.from({ length: 30 }, (_, i) => i + 1));
  assert.ok(isNaNs(lr.slice(0, 3)));
  assert.equal(lr.at(-1), 1);
});

test('KST with one-bar windows is the weighted ROC sum', () => {
  const c = bars.map((b) => b.close), r = I.kst(c, 1, 2, 3, 4, 1, 1, 1, 1, 1);
  const roc = (k, i) => (100 * (c[i] - c[i - k])) / c[i - k];
  near(r.kst[10], roc(1, 10) + 2 * roc(2, 10) + 3 * roc(3, 10) + 4 * roc(4, 10), 1e-9);
});

// --- the script toolkit ------------------------------------------------------------------

test('ta keeps its existing names and adds the new ones', () => {
  const old = ['sma', 'ema', 'wma', 'rma', 'hma', 'dema', 'tema', 'alma', 'linreg', 'stdev', 'sum', 'cum', 'highest', 'lowest', 'change', 'mom', 'roc', 'shift',
    'rsi', 'macd', 'bb', 'stoch', 'cci', 'crossover', 'crossunder', 'cross', 'pivothigh', 'pivotlow', 'vwma'];
  const oldBars = ['atr', 'tr', 'mfi', 'obv', 'wpr', 'dmi', 'supertrend', 'vwap', 'psar'];
  const added = ['kama', 'zlema', 't3', 'mcginley', 'vidya', 'trima', 'linregSlope', 'stderrBands', 'ppo', 'kst', 'stc', 'zscore', 'laguerreRsi',
    'connorsRsi', 'streak', 'percentrank', 'rvi', 'er', 'vhf', 'pfe', 'ulcer'];
  const addedBars = ['alligator', 'chandelier', 'chandeKroll', 'ssl', 'rwi', 'elderRay', 'massIndex', 'smi', 'rvgi', 'imi', 'qstick', 'squeeze',
    'klinger', 'eom', 'nvi', 'pvi', 'vwmacd', 'atrp', 'chaikinVolatility', 'starc', 'vwapBands'];
  for (const k of [...old, ...added]) assert.equal(typeof TA[k], 'function', `ta.${k}`);
  for (const k of [...oldBars, ...addedBars]) assert.equal(typeof TA.bars[k], 'function', `ta.${k} (bars)`);
  for (const k of Object.keys(TA.bars)) assert.ok(!(k in TA), `ta.${k} is both a plain and a bar-based helper`);
});

test('bar-based ta helpers with default arguments match the built-in indicators', () => {
  const ta = { ...TA };
  for (const [k, fn] of Object.entries(TA.bars)) ta[k] = (...args) => fn(bars, ...args); // as script-worker.js binds them
  const c = bars.map((b) => b.close);
  assert.deepEqual(ta.chandelier().long, run('chandelier', bars).long);
  assert.deepEqual(ta.klinger().kvo, run('klinger', bars).kvo);
  assert.deepEqual(ta.chandeKroll().stopLong, run('ckstop', bars).stopLong);
  assert.deepEqual(ta.massIndex(), run('massindex', bars).mi);
  assert.deepEqual(ta.squeeze().value, run('squeeze', bars).value);
  assert.deepEqual(ta.kama(c), run('kama', bars).ma);
  assert.deepEqual(ta.kst(c).kst, run('kst', bars).kst);
  assert.deepEqual(ta.laguerreRsi(c), run('laguerre', bars).lrsi);
  assert.deepEqual(ta.zscore(c), run('zscore', bars).z);
  assert.deepEqual(ta.stc(c), run('stc', bars).stc);
});

test('highest, lowest and percentrank (sliding windows) match a plain scan, gaps included', () => {
  // The plain O(n·len) definitions: the extreme of the window's numbers (NaN if it has none), and
  // the share of the previous len values below the current one (NaN when any of them is a gap).
  const scanExtreme = (src, len, better) => src.map((_, i) => {
    if (i < len - 1) return NaN;
    let v = NaN;
    for (let j = 0; j < len; j++) { const x = src[i - j]; if (Number.isFinite(x) && (!Number.isFinite(v) || better(x, v))) v = x; }
    return v;
  });
  const scanRank = (src, len) => src.map((v, i) => {
    if (i < len || !Number.isFinite(v)) return NaN;
    let below = 0;
    for (let j = 1; j <= len; j++) { const x = src[i - j]; if (!Number.isFinite(x)) return NaN; if (x < v) below++; }
    return (100 * below) / len;
  });
  const same = (a, b, what) => {
    assert.equal(a.length, b.length, what);
    a.forEach((v, i) => assert.ok(Object.is(v, b[i]) || (Number.isNaN(v) && Number.isNaN(b[i])), `${what} at ${i}: ${v} vs ${b[i]}`));
  };
  const GAPS = [NaN, null, undefined, Infinity];
  for (let k = 0; k < 60; k++) {
    const n = 1 + Math.floor(rnd() * 400);
    const holes = [0, 0.03, 0.3, 0.95][k % 4];
    // Ties on purpose (half-steps), and gaps of every kind.
    const src = Array.from({ length: n }, () => (rnd() < holes ? GAPS[Math.floor(rnd() * GAPS.length)] : Math.round(rnd() * 40) / 2 - 10));
    for (const len of [1, 2, 7, 8, 20, 100, n, n + 3]) {
      same(highest(src, len), scanExtreme(src, len, (a, b) => a > b), `highest(${len}) n=${n}`);
      same(lowest(src, len), scanExtreme(src, len, (a, b) => a < b), `lowest(${len}) n=${n}`);
      same(I.percentrank(src, len), scanRank(src, len), `percentrank(${len}) n=${n}`);
    }
  }
  assert.ok(isNaNs(highest([1, 2, 3], 0)) && isNaNs(lowest([1, 2, 3], 2.5)));
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
