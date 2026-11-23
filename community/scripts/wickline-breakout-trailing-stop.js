// Breakout + Trailing Stop
// Wickline community script by Wickline, shared under the MIT license.

// Buys a breakout above the highest high of the last N bars and rides it with a trailing stop.
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
