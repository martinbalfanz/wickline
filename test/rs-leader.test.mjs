// Regression checks for hidden benchmark feeds and the RS Leader starter.
import assert from 'node:assert/strict';
import { alignBenchmarkCloses, BenchmarkFeedCache } from '../public/js/benchmark-data.js';
import { RS_LEADER_SCRIPT } from '../public/js/rs-leader.js';

// Never forward-fill stale benchmark candles. Correct timezone offsets.
const chart = [{ time: 10 }, { time: 20 }, { time: 30 }];
const benchmark = [{ time: 10, close: 20 }, { time: 30, close: 22 }];
assert.deepEqual(alignBenchmarkCloses(chart, benchmark), [20, NaN, 22]);
assert.deepEqual(alignBenchmarkCloses(chart, [{ time: 9, close: 20 }, { time: 19, close: 21 }, { time: 29, close: 22 }], 1, 0),
  [20, 21, 22]);

// Reuse the benchmark while flipping between stocks; close when timeframe changes.
const feeds = [];
let updates = 0;
const cache = new BenchmarkFeedCache((_symbol, tf) => {
  const feed = {
    tf, closed: false,
    loadInitial: async () => ({ bars: benchmark, meta: { tzOffset: 0 } }),
    subscribe(handlers) { this.subscription = handlers; },
    close() { this.closed = true; }
  };
  feeds.push(feed);
  return feed;
}, () => updates++);
cache.ensure('YAHOO:SPY', { sec: 86400 }, '1d');
await Promise.resolve(); await Promise.resolve();
assert.equal(cache.get('YAHOO:SPY', '1d').bars.length, 2);
assert.equal(updates, 1);
cache.ensure('YAHOO:SPY', { sec: 86400 }, '1d');
assert.equal(feeds.length, 1, 'reuses feed when chart symbol changes');
cache.ensure('YAHOO:SPY', { sec: 604800 }, '1w');
assert.equal(feeds[0].closed, true, 'closes old timeframe feed');
cache.clear();
assert.equal(feeds[1].closed, true);

// Run bundled script inside the actual worker using deterministic daily data.
let reply = null;
globalThis.self = { postMessage: (res) => { reply = res; } };
await import('../public/js/script-worker.js');
const N = 430;
const data = { time: [], open: [], high: [], low: [], close: [], volume: [] };
const spy = [];
for (let i = 0; i < N; i++) {
  const benchmarkPrice = 100 * Math.pow(1.0005, i);
  const stockPrice = 100 * Math.pow(1.0015, i);
  spy.push(benchmarkPrice);
  data.time.push(1700000000 + i * 86400);
  data.open.push(stockPrice);
  data.high.push(stockPrice * 1.004);
  data.low.push(stockPrice * .995);
  data.close.push(stockPrice);
  data.volume.push(1000);
}
const packed = Object.fromEntries(Object.entries(data).map(([key, values]) =>
  [key, Float64Array.from(values)]));
const run = (compareCloses, tfSec = 86400) => {
  self.onmessage({ data: { id: 1, code: RS_LEADER_SCRIPT, data: packed, inputs: {},
    ctx: { symbol: 'YAHOO:LLY', tfSec, compareCloses } } });
  return reply;
};

const missing = run({});
assert.equal(missing.ok, true, missing.error);
assert.deepEqual(missing.result.benchmarks, ['YAHOO:SPY']);
assert.equal(missing.result.meta.dashboard.status, 'LOADING SPY / HISTORY');
assert.equal(missing.result.plots[2].legend, false, 'cloud helper excluded from legend');

const ready = run({ 'YAHOO:SPY': spy });
assert.equal(ready.ok, true, ready.error);
assert.equal(ready.result.meta.dashboard.status, 'LEADING');
assert.equal(ready.result.meta.dashboard.tone, 'positive');
assert.equal(ready.result.meta.dashboard.metrics.length, 3);
assert.ok(ready.result.meta.dashboard.metrics.every(m => m.value.startsWith('+')));
assert.ok(Array.from(ready.result.plots[0].values).some(Number.isFinite), 'valid RS trend');

const intraday = run({}, 3600);
assert.equal(intraday.ok, true, intraday.error);
assert.deepEqual(intraday.result.benchmarks, [], 'no daily benchmark request on intraday');
assert.equal(intraday.result.meta.dashboard.status, 'D / W / M ONLY');

console.log('RS Leader + hidden benchmark checks passed');
