// Stable newest-candle positioning on symbol and timeframe changes.
import assert from 'node:assert/strict';
import { focusLatestBars, DEFAULT_RIGHT_PADDING, DEFAULT_VISIBLE_BARS } from '../public/js/viewport.js';

function fakeScale(width) {
  const calls = [];
  return {
    width: () => width,
    applyOptions: (opts) => calls.push(['options', opts]),
    scrollToPosition: (offset, animated) => calls.push(['scroll', offset, animated]),
    calls,
  };
}
for (const width of [340, 800, 1440, 2400]) {
  const scale = fakeScale(width);
  focusLatestBars(scale);
  assert.deepEqual(scale.calls, [
    ['options', { barSpacing: Math.max(2, Math.min(18, width / DEFAULT_VISIBLE_BARS)) }],
    ['scroll', DEFAULT_RIGHT_PADDING, false]
  ], 'new symbols reset zoom and scroll to live edge');
}
const zeroSize = fakeScale(0);
focusLatestBars(zeroSize);
assert.deepEqual(zeroSize.calls, [['scroll', DEFAULT_RIGHT_PADDING, false]],
  'avoid invalid zoom on hidden/zero-width charts; a subsequent resize can recenter');
console.log('Viewport reset tests passed');
