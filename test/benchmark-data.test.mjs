// Generic custom-indicator API and hidden benchmark feed checks.
import assert from 'node:assert/strict';
import { alignBenchmarkCloses, BenchmarkFeedCache } from '../public/js/benchmark-data.js';

// An unmatched benchmark candle must not become a fabricated fresh quote.
const bars = [{ time: 10 }, { time: 20 }, { time: 30 }];
assert.deepEqual(alignBenchmarkCloses(bars, [{ time: 10, close: 20 }, { time: 30, close: 22 }]), [20, NaN, 22]);
assert.deepEqual(alignBenchmarkCloses(bars, [
  { time: 9, close: 20 }, { time: 19, close: 21 }, { time: 29, close: 22 },
], 1, 0), [20, 21, 22]);

// Reuse feeds when changing a chart's symbol, replace them for another timeframe.
const streams = [];
let updates = 0;
const cache = new BenchmarkFeedCache((_symbol, tf) => {
  const stream = {
    tf, closed: false, subscription: null,
    loadInitial: async () => ({ bars: [{ time: 10, close: 20 }], meta: { tzOffset: 0 } }),
    subscribe(handler) { this.subscription = handler; },
    close() { this.closed = true; },
  };
  streams.push(stream);
  return stream;
}, () => updates++);
cache.ensure('YAHOO:QQQ', { sec: 86400 }, '1D');
await Promise.resolve();
await Promise.resolve();
assert.equal(cache.get('YAHOO:QQQ', '1D').bars.length, 1);
assert.equal(updates, 1);
cache.ensure('YAHOO:QQQ', { sec: 86400 }, '1D');
assert.equal(streams.length, 1);
cache.ensure('YAHOO:QQQ', { sec: 604800 }, '1W');
assert.equal(streams[0].closed, true);
cache.clear();
assert.equal(streams[1].closed, true);

// Run a generic comparison script in the real worker.
let response = null;
globalThis.self = { postMessage: (m) => { response = m; } };
await import('../public/js/script-worker.js');
const count = 30;
const data = {
  time: Float64Array.from({ length: count }, (_, i) => 1700000000 + i * 86400),
  open: Float64Array.from({ length: count }, (_, i) => 10 + i),
  high: Float64Array.from({ length: count }, (_, i) => 11 + i),
  low: Float64Array.from({ length: count }, (_, i) => 9 + i),
  close: Float64Array.from({ length: count }, (_, i) => 10 + i),
  volume: Float64Array.from({ length: count }, () => 1000),
};
const code = [
  "indicator('Comparison example', { overlay: false });",
  "const benchmark = compareClose('YAHOO:QQQ');",
  "const values = close.map((c, i) => Number.isFinite(benchmark[i]) ? c / benchmark[i] : NaN);",
  "plot(values, { title: 'Comparison', color: '#20DDB3' });",
  "plot(values, { title: 'Helper series', legend: false });",
  "dashboard({ status: Number.isFinite(values[n - 1]) ? 'READY' : 'LOADING', tone: 'positive', metrics: [{ label: 'Last', value: String(values[n - 1]), tone: 'neutral' }] });",
].join('\n');
const run = (compareCloses) => {
  self.onmessage({ data: { id: 1, code, data, inputs: {}, ctx: {
    tfSec: 86400, symbol: 'YAHOO:AAPL', compareCloses,
  } } });
  return response;
};
const waiting = run({});
assert.equal(waiting.ok, true, waiting.error);
assert.deepEqual(waiting.result.benchmarks, ['YAHOO:QQQ']);
assert.equal(waiting.result.meta.dashboard.status, 'LOADING');
assert.equal(waiting.result.plots[1].legend, false);
const present = run({ 'YAHOO:QQQ': Array.from({ length: count }, (_, i) => 20 + i) });
assert.equal(present.ok, true, present.error);
assert.equal(present.result.meta.dashboard.status, 'READY');
assert.equal(present.result.meta.dashboard.tone, 'positive');
assert.ok(present.result.plots[0].values.every(Number.isFinite));
assert.equal(present.result.meta.dashboard.metrics.length, 1);
console.log('Benchmark feed and generic script API checks passed');
