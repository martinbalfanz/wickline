// Range Breakout
// Wickline community script by Wickline, shared under the MIT license.

// Highest high and lowest low of the last N bars, with markers on breakouts.
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
