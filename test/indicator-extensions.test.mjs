// Generic cross-symbol script API and sanitization tests (no bundled indicator).
import assert from 'node:assert/strict';
import { indicatorApi, sanitizeIndicatorExtras } from '../public/js/indicator-extensions.js';
import { sanitizeResult } from '../public/js/script-sanitize.js';

const out = { meta: {}, benchmarks: [] };
const closes = [1, 2, 3];
const api = indicatorApi(out, { compareCloses: { 'YAHOO:QQQ': closes } }, 3);
assert.deepEqual(api.compareClose('YAHOO:QQQ'), closes);
assert.deepEqual(api.compareClose('YAHOO:MSFT'), [NaN, NaN, NaN]);
assert.deepEqual(out.benchmarks, ['YAHOO:QQQ', 'YAHOO:MSFT']);
assert.equal(api.compareClose('YAHOO:QQQ'), closes);
assert.throws(() => api.compareClose('<script>'), /invalid symbol/);
api.dashboard({ status: 'READY', tone: 'positive', metrics: [{ label: 'Performance', value: '+2.1%' }] });
const malformed = {
  ...out,
  meta: { ...out.meta, name: 'Generic', overlay: false },
  plots: [{ values: Float64Array.from([1, 2, 3]), title: 'Primary', color: '#abcdef', legend: false }],
  inputs: [], hlines: [], fills: [], markers: [], consts: {}, logs: [],
};
const normalized = sanitizeResult(malformed, { bars: 3 });
assert.equal(normalized.plots[0].legend, false);
assert.equal(normalized.meta.dashboard.status, 'READY');
assert.equal(normalized.meta.dashboard.tone, 'positive');
assert.equal(normalized.meta.dashboard.metrics[0].value, '+2.1%');
assert.deepEqual(normalized.benchmarks, ['YAHOO:QQQ', 'YAHOO:MSFT']);
const attack = sanitizeResult({
  ...malformed,
  benchmarks: ['<img>', 'YAHOO:QQQ', 'YAHOO:QQQ', 'YAHOO:AAPL', 'YAHOO:MSFT', 'YAHOO:NVDA'],
  meta: { dashboard: { status: '<img onerror="x">', tone: '" onmouseover="x', metrics: [
    { label: '<script>', value: 'x'.repeat(200), tone: 'invalid' },
  ] } },
}, { bars: 3 });
assert.deepEqual(attack.benchmarks, ['YAHOO:QQQ', 'YAHOO:AAPL']);
assert.equal(attack.meta.dashboard.tone, 'neutral');
assert.equal(attack.meta.dashboard.metrics[0].tone, 'neutral');
assert.equal(attack.meta.dashboard.metrics[0].value.length, 22);
const budget = { left: 0, spend(n) { this.left += n; } };
assert.deepEqual(sanitizeIndicatorExtras({}, budget), { benchmarks: [], dashboard: null });
assert.equal(budget.left, 0);
console.log('Generic indicator extension and sanitizer tests passed');
